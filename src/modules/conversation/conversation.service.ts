import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  ConversationMessage as PrismaConversationMessage,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";

const GENERATION_LEASE_MS = 30 * 60 * 1000;

export interface AcceptVoiceData {
  userId: string;
  userPromptId: string;
  content: string;
  voiceFileId: string;
  telegramUpdateId: bigint;
  generationRequestKey: string;
}

export type VoicePrecheckResult =
  | { outcome: "accept" }
  | { outcome: "duplicate"; message: PrismaConversationMessage }
  | { outcome: "closed" };

export interface ConversationGenerationClaim {
  responseId: string;
  claimToken: string;
  claimExpiresAt: Date;
}

export type AcceptVoiceResult =
  | { outcome: "duplicate"; message: PrismaConversationMessage }
  | { outcome: "closed" }
  | {
      outcome: "accepted";
      message: PrismaConversationMessage;
      userMessageCount: number;
      generationClaim: ConversationGenerationClaim | null;
    };

export type GuardedAssistantResult =
  | { outcome: "inserted"; message: PrismaConversationMessage }
  | { outcome: "closed" | "stale" };

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Cheap read-only gate. The locked accept method is authoritative. */
  async precheckVoiceAcceptance(
    userPromptId: string,
    telegramUpdateId?: bigint,
  ): Promise<VoicePrecheckResult> {
    if (telegramUpdateId !== undefined) {
      const duplicate = await this.prisma.conversationMessage.findUnique({
        where: { telegramUpdateId },
      });
      if (duplicate) return { outcome: "duplicate", message: duplicate };
    }
    const prompt = await this.prisma.userPrompt.findUnique({
      where: { id: userPromptId },
      select: { conversationStatus: true },
    });
    return prompt?.conversationStatus === "open"
      ? { outcome: "accept" }
      : { outcome: "closed" };
  }

  /** Atomically accepts a voice turn and claims generation on turn three. */
  async acceptVoiceAndMaybeClaimGeneration(
    data: AcceptVoiceData,
  ): Promise<AcceptVoiceResult> {
    return this.prisma.$transaction(async (tx) => {
      const prompt = await this.lockUserPrompt(tx, data.userPromptId);
      if (!prompt || prompt.userId !== data.userId) return { outcome: "closed" };
      const duplicate = await tx.conversationMessage.findUnique({
        where: { telegramUpdateId: data.telegramUpdateId },
      });
      if (duplicate) return { outcome: "duplicate", message: duplicate };
      if (prompt.conversationStatus !== "open") return { outcome: "closed" };

      const message = await tx.conversationMessage.create({
        data: {
          userPromptId: data.userPromptId,
          role: "user",
          content: data.content,
          voiceFileId: data.voiceFileId,
          telegramUpdateId: data.telegramUpdateId,
        },
      });
      const userMessageCount = await tx.conversationMessage.count({
        where: { userPromptId: data.userPromptId, role: "user" },
      });
      let generationClaim: ConversationGenerationClaim | null = null;

      if (userMessageCount >= 3) {
        const now = new Date();
        const claimToken = randomUUID();
        const claimExpiresAt = new Date(now.getTime() + GENERATION_LEASE_MS);
        await tx.userPrompt.update({
          where: { id: data.userPromptId },
          data: { conversationStatus: "closed", conversationClosedAt: now },
        });
        const firstUserMessage = await tx.conversationMessage.findFirst({
          where: {
            userPromptId: data.userPromptId,
            role: "user",
            voiceFileId: { not: null },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { voiceFileId: true },
        });
        const existing = await tx.userResponse.findUnique({
          where: { userPromptId: data.userPromptId },
        });
        if (!existing) {
          const response = await tx.userResponse.create({
            data: {
              userId: data.userId,
              userPromptId: data.userPromptId,
              voiceFileId: firstUserMessage?.voiceFileId ?? data.voiceFileId,
              generationRequestKey: data.generationRequestKey,
              generationClaimToken: claimToken,
              generationClaimExpiresAt: claimExpiresAt,
              generationAttemptedAt: now,
            },
          });
          generationClaim = { responseId: response.id, claimToken, claimExpiresAt };
        }
      }
      return { outcome: "accepted", message, userMessageCount, generationClaim };
    });
  }

  /** Inserts a follow-up only if it still belongs to the latest open turn. */
  async addAssistantMessageIfOpen(
    userPromptId: string,
    content: string,
    expectedUserMessageId?: string,
  ): Promise<GuardedAssistantResult> {
    return this.prisma.$transaction(async (tx) => {
      const prompt = await this.lockUserPrompt(tx, userPromptId);
      if (!prompt || prompt.conversationStatus !== "open") {
        return { outcome: "closed" };
      }
      if (expectedUserMessageId) {
        const latestUser = await tx.conversationMessage.findFirst({
          where: { userPromptId, role: "user" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
        });
        if (latestUser?.id !== expectedUserMessageId) return { outcome: "stale" };
      }
      const message = await tx.conversationMessage.create({
        data: { userPromptId, role: "assistant", content },
      });
      return { outcome: "inserted", message };
    });
  }

  async addMessage(
    userPromptId: string,
    role: string,
    content: string,
    voiceFileId?: string,
  ): Promise<PrismaConversationMessage> {
    return this.prisma.conversationMessage.create({
      data: { userPromptId, role, content, voiceFileId },
    });
  }

  async getMessages(userPromptId: string): Promise<PrismaConversationMessage[]> {
    return this.prisma.conversationMessage.findMany({
      where: { userPromptId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async hasMessages(userPromptId: string): Promise<boolean> {
    return (await this.prisma.conversationMessage.count({
      where: { userPromptId },
    })) > 0;
  }

  private async lockUserPrompt(
    tx: Prisma.TransactionClient,
    userPromptId: string,
  ): Promise<{ id: string; userId: string; conversationStatus: "open" | "closed" } | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; userId: string; conversationStatus: "open" | "closed" }>
    >`SELECT "id", "userId", "conversationStatus" FROM "user_prompts" WHERE "id" = ${userPromptId} FOR UPDATE`;
    return rows[0] ?? null;
  }
}
