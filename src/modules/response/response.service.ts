import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  Prisma,
  ReportAnalysisKind,
  ReportDeliveryRequest,
  UserResponse,
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";

const GENERATION_LEASE_MS = 30 * 60 * 1000;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;
const UNKNOWN_DELIVERY_ERROR = "unknown_delivery_outcome";

export interface CreateResponseData {
  userId: string;
  userPromptId: string;
  voiceFileId: string;
}

export interface UpdateResponseData {
  transcript?: string;
  analysis?: string;
}

export interface ClaimGenerationData extends CreateResponseData {
  generationRequestKey: string;
}

export interface GenerationClaim {
  responseId: string;
  claimToken: string;
  claimExpiresAt: Date;
}

export type ClaimGenerationResult =
  | { outcome: "claimed"; claim: GenerationClaim }
  | { outcome: "generated"; response: UserResponse }
  | { outcome: "busy"; response: UserResponse }
  | { outcome: "failed_same_request"; response: UserResponse }
  | { outcome: "no_messages" }
  | { outcome: "missing_prompt" };

export interface CompleteGenerationData {
  responseId: string;
  claimToken: string;
  transcript: string;
  analysis: string;
  analysisVersion: number;
  analysisKind: ReportAnalysisKind;
  chunks: string[];
}

export interface DeliveryClaim {
  requestId: string;
  claimToken: string;
  claimExpiresAt: Date;
  nextChunkIndex: number;
  chunks: string[];
}

export type CompleteGenerationResult =
  | { outcome: "claimed"; claim: DeliveryClaim }
  | { outcome: "stale" };

export type ClaimDeliveryResult =
  | { outcome: "claimed"; claim: DeliveryClaim }
  | { outcome: "busy" | "ambiguous" | "failed" | "delivered"; request: ReportDeliveryRequest }
  | { outcome: "response_not_generated" };

export type BeginChunkResult =
  | { outcome: "begun"; chunk: string; chunkIndex: number; attemptedAt: Date }
  | { outcome: "stale" };

export type CompleteChunkResult =
  | { outcome: "claimed_next"; claim: DeliveryClaim }
  | { outcome: "delivered"; request: ReportDeliveryRequest }
  | { outcome: "stale" };

@Injectable()
export class ResponseService {
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

  async createOrClaimDeliveryRequest(
    userResponseId: string,
    requestKey: string,
    chunks: string[],
  ): Promise<ClaimDeliveryResult> {
    if (chunks.length === 0) throw new Error("delivery_chunks_empty");
    return this.prisma.$transaction(async (tx) => {
      await this.lockResponse(tx, userResponseId);
      const response = await tx.userResponse.findUnique({ where: { id: userResponseId } });
      if (response?.generationStatus !== "generated") {
        return { outcome: "response_not_generated" };
      }

      await this.lockDeliveryByKey(tx, userResponseId, requestKey);
      const existing = await tx.reportDeliveryRequest.findUnique({
        where: { userResponseId_requestKey: { userResponseId, requestKey } },
      });
      const now = new Date();
      if (existing) {
        if (existing.status === "delivered") return { outcome: "delivered", request: existing };
        if (existing.status === "failed") return { outcome: "failed", request: existing };
        if (existing.deliveryAttemptedAt) return { outcome: "ambiguous", request: existing };
        if (existing.claimExpiresAt && existing.claimExpiresAt > now) {
          return { outcome: "busy", request: existing };
        }
      }

      const claimToken = randomUUID();
      const claimExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);
      const request = existing
        ? await tx.reportDeliveryRequest.update({
            where: { id: existing.id },
            data: { claimToken, claimExpiresAt },
          })
        : await tx.reportDeliveryRequest.create({
            data: {
              userResponseId,
              requestKey,
              chunks: chunks as Prisma.InputJsonValue,
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
          nextChunkIndex: request.nextChunkIndex,
          chunks: this.readChunks(request),
        },
      };
    });
  }

  /** Marks a chunk attempted before Telegram I/O and clears the delivery lease. */
  async beginDeliveryChunk(
    requestId: string,
    claimToken: string,
    attemptedAt = new Date(),
  ): Promise<BeginChunkResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDelivery(tx, requestId);
      const request = await tx.reportDeliveryRequest.findUnique({ where: { id: requestId } });
      if (!request || request.status !== "pending" || request.claimToken !== claimToken || request.deliveryAttemptedAt) {
        return { outcome: "stale" };
      }
      const chunks = this.readChunks(request);
      const chunk = chunks[request.nextChunkIndex];
      if (chunk === undefined) return { outcome: "stale" };
      await tx.reportDeliveryRequest.update({
        where: { id: requestId },
        data: {
          deliveryAttemptedAt: attemptedAt,
          claimToken: null,
          claimExpiresAt: null,
          lastDeliveryErrorCode: UNKNOWN_DELIVERY_ERROR,
          lastDeliveryErrorAt: attemptedAt,
        },
      });
      return { outcome: "begun", chunk, chunkIndex: request.nextChunkIndex, attemptedAt };
    });
  }

  async completeDeliveryChunk(
    requestId: string,
    chunkIndex: number,
    attemptedAt: Date,
  ): Promise<CompleteChunkResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDelivery(tx, requestId);
      const request = await tx.reportDeliveryRequest.findUnique({ where: { id: requestId } });
      if (!this.matchesAttempt(request, chunkIndex, attemptedAt)) return { outcome: "stale" };
      const chunks = this.readChunks(request!);
      const nextChunkIndex = chunkIndex + 1;
      if (nextChunkIndex === chunks.length) {
        const delivered = await tx.reportDeliveryRequest.update({
          where: { id: requestId },
          data: {
            status: "delivered",
            nextChunkIndex,
            deliveredAt: new Date(),
            lastDeliveryErrorCode: null,
            lastDeliveryErrorAt: null,
          },
        });
        return { outcome: "delivered", request: delivered };
      }
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(Date.now() + DELIVERY_LEASE_MS);
      await tx.reportDeliveryRequest.update({
        where: { id: requestId },
        data: {
          nextChunkIndex,
          deliveryAttemptedAt: null,
          claimToken,
          claimExpiresAt,
          lastDeliveryErrorCode: null,
          lastDeliveryErrorAt: null,
        },
      });
      return {
        outcome: "claimed_next",
        claim: { requestId, claimToken, claimExpiresAt, nextChunkIndex, chunks },
      };
    });
  }

  async failDeliveryDefinite(
    requestId: string,
    chunkIndex: number,
    attemptedAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    return this.finishDeliveryFailure(requestId, chunkIndex, attemptedAt, errorCode, true);
  }

  async failDeliveryAmbiguous(
    requestId: string,
    chunkIndex: number,
    attemptedAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    return this.finishDeliveryFailure(requestId, chunkIndex, attemptedAt, errorCode, false);
  }

  private async finishDeliveryFailure(
    requestId: string,
    chunkIndex: number,
    attemptedAt: Date,
    errorCode: string,
    definite: boolean,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDelivery(tx, requestId);
      const request = await tx.reportDeliveryRequest.findUnique({ where: { id: requestId } });
      if (!this.matchesAttempt(request, chunkIndex, attemptedAt)) return false;
      await tx.reportDeliveryRequest.update({
        where: { id: requestId },
        data: {
          status: definite ? "failed" : "pending",
          lastDeliveryErrorCode: this.sanitizeErrorCode(errorCode),
          lastDeliveryErrorAt: new Date(),
        },
      });
      return true;
    });
  }

  async createResponse(data: CreateResponseData): Promise<UserResponse> {
    const now = new Date();
    return this.prisma.userResponse.create({
      data: {
        ...data,
        generationRequestKey: `crud:${randomUUID()}`,
        generationClaimToken: randomUUID(),
        generationClaimExpiresAt: new Date(now.getTime() + GENERATION_LEASE_MS),
        generationAttemptedAt: now,
      },
    });
  }

  async updateResponse(id: string, data: UpdateResponseData): Promise<UserResponse> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockResponse(tx, id);
      const current = await tx.userResponse.findUniqueOrThrow({ where: { id } });
      const completesLegacy =
        current.generationStatus === "generating" &&
        Boolean(data.transcript?.trim()) &&
        Boolean(data.analysis?.trim());
      return tx.userResponse.update({
        where: { id },
        data: completesLegacy
          ? {
              ...data,
              generationStatus: "generated",
              generatedAt: new Date(),
              analysisVersion: 0,
              analysisKind: "legacy",
              generationClaimToken: null,
              generationClaimExpiresAt: null,
            }
          : data,
      });
    });
  }

  async getResponseById(id: string): Promise<UserResponse | null> {
    return this.prisma.userResponse.findUnique({ where: { id } });
  }

  async getResponseByUserPromptId(userPromptId: string): Promise<UserResponse | null> {
    return this.prisma.userResponse.findUnique({ where: { userPromptId } });
  }

  async getUserResponses(userId: string): Promise<UserResponse[]> {
    return this.prisma.userResponse.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  private matchesAttempt(
    request: ReportDeliveryRequest | null,
    chunkIndex: number,
    attemptedAt: Date,
  ): boolean {
    return Boolean(
      request &&
      request.status === "pending" &&
      request.nextChunkIndex === chunkIndex &&
      request.deliveryAttemptedAt?.getTime() === attemptedAt.getTime() &&
      request.claimToken === null,
    );
  }

  private readChunks(request: ReportDeliveryRequest): string[] {
    if (!Array.isArray(request.chunks) || !request.chunks.every((chunk) => typeof chunk === "string")) {
      throw new Error("invalid_delivery_chunks");
    }
    return request.chunks as string[];
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

  private async lockDelivery(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "report_delivery_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
  }

  private async lockDeliveryByKey(tx: Prisma.TransactionClient, userResponseId: string, requestKey: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "report_delivery_requests" WHERE "userResponseId" = ${userResponseId} AND "requestKey" = ${requestKey} FOR UPDATE`;
  }
}
