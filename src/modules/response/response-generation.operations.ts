import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  ClaimGenerationData,
  ClaimGenerationResult,
  CompleteGenerationData,
  CompleteGenerationResult,
} from "./response.types";

const GENERATION_LEASE_MS = 30 * 60 * 1000;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;

export class ResponseGenerationOperations {
  constructor(private readonly prisma: PrismaService) {}

  /** Claims manual generation, reclaims failed/expired work, or returns saved output. */
  async claimGeneration(data: ClaimGenerationData): Promise<ClaimGenerationResult> {
    return this.prisma.$transaction(async (tx) => {
      const prompt = await this.lockPrompt(tx, data.userPromptId);
      if (!prompt || prompt.userId !== data.userId) return { outcome: "missing_prompt" };
      const userMessageCount = await tx.conversationMessage.count({
        where: { userPromptId: data.userPromptId, role: "user" },
      });
      if (userMessageCount === 0) return { outcome: "no_messages" };
      const now = new Date();
      if (prompt.conversationStatus === "open") {
        await tx.userPrompt.update({
          where: { id: data.userPromptId },
          data: { conversationStatus: "closed", conversationClosedAt: now },
        });
      }

      await this.lockResponseByPrompt(tx, data.userPromptId);
      const existing = await tx.userResponse.findUnique({
        where: { userPromptId: data.userPromptId },
      });
      if (existing?.generationStatus === "generated") {
        return { outcome: "generated", response: existing };
      }
      if (
        existing?.generationStatus === "failed" &&
        existing.generationRequestKey === data.generationRequestKey
      ) {
        return { outcome: "failed_same_request", response: existing };
      }
      if (
        existing?.generationStatus === "generating" &&
        existing.generationClaimExpiresAt &&
        existing.generationClaimExpiresAt > now
      ) {
        return { outcome: "busy", response: existing };
      }

      const claimToken = randomUUID();
      const claimExpiresAt = new Date(now.getTime() + GENERATION_LEASE_MS);
      const response = existing
        ? await tx.userResponse.update({
            where: { id: existing.id },
            data: {
              generationStatus: "generating",
              generationRequestKey: data.generationRequestKey,
              generationClaimToken: claimToken,
              generationClaimExpiresAt: claimExpiresAt,
              generationAttemptedAt: now,
              generatedAt: null,
              lastGenerationErrorCode: null,
              lastGenerationErrorAt: null,
              analysisVersion: null,
              analysisKind: null,
            },
          })
        : await tx.userResponse.create({
            data: {
              userId: data.userId,
              userPromptId: data.userPromptId,
              voiceFileId: data.voiceFileId,
              generationRequestKey: data.generationRequestKey,
              generationClaimToken: claimToken,
              generationClaimExpiresAt: claimExpiresAt,
              generationAttemptedAt: now,
            },
          });
      return {
        outcome: "claimed",
        claim: { responseId: response.id, claimToken, claimExpiresAt },
      };
    });
  }

  async completeGeneration(
    data: CompleteGenerationData,
  ): Promise<CompleteGenerationResult> {
    if (data.chunks.length === 0) throw new Error("delivery_chunks_empty");
    return this.prisma.$transaction(async (tx) => {
      await this.lockResponse(tx, data.responseId);
      const current = await tx.userResponse.findUnique({ where: { id: data.responseId } });
      if (
        !current ||
        current.generationStatus !== "generating" ||
        current.generationClaimToken !== data.claimToken
      ) {
        return { outcome: "stale" };
      }
      await tx.userResponse.update({
        where: { id: data.responseId },
        data: {
          transcript: data.transcript,
          analysis: data.analysis,
          generationStatus: "generated",
          generatedAt: new Date(),
          analysisVersion: data.analysisVersion,
          analysisKind: data.analysisKind,
          generationClaimToken: null,
          generationClaimExpiresAt: null,
          lastGenerationErrorCode: null,
          lastGenerationErrorAt: null,
        },
      });
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(Date.now() + DELIVERY_LEASE_MS);
      const request = await tx.reportDeliveryRequest.create({
        data: {
          userResponseId: data.responseId,
          requestKey: current.generationRequestKey,
          chunks: data.chunks as Prisma.InputJsonValue,
          claimToken,
          claimExpiresAt,
        },
      });
      return {
        outcome: "claimed",
        claim: {
          requestId: request.id,
          claimToken,
          claimExpiresAt,
          nextChunkIndex: 0,
          chunks: data.chunks,
        },
      };
    });
  }

  async failGeneration(
    responseId: string,
    claimToken: string,
    errorCode: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.userResponse.updateMany({
      where: { id: responseId, generationStatus: "generating", generationClaimToken: claimToken },
      data: {
        generationStatus: "failed",
        generationClaimToken: null,
        generationClaimExpiresAt: null,
        lastGenerationErrorCode: this.sanitizeErrorCode(errorCode),
        lastGenerationErrorAt: now,
      },
    });
    return result.count === 1;
  }

  private sanitizeErrorCode(value: string): string {
    const sanitized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
    return sanitized || "unknown_error";
  }

  private async lockPrompt(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string; userId: string; conversationStatus: "open" | "closed" }>>
      `SELECT "id", "userId", "conversationStatus" FROM "user_prompts" WHERE "id" = ${id} FOR UPDATE`;
    return rows[0] ?? null;
  }

  private async lockResponse(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "user_responses" WHERE "id" = ${id} FOR UPDATE`;
  }

  private async lockResponseByPrompt(tx: Prisma.TransactionClient, userPromptId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "user_responses" WHERE "userPromptId" = ${userPromptId} FOR UPDATE`;
  }
}
