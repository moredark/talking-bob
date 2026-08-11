import { randomUUID } from "node:crypto";
import { Prisma, ReportDeliveryRequest } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  BeginChunkResult,
  ClaimDeliveryResult,
  CompleteChunkResult,
} from "./response.types";

const DELIVERY_LEASE_MS = 2 * 60 * 1000;
const UNKNOWN_DELIVERY_ERROR = "unknown_delivery_outcome";

export class ResponseDeliveryOperations {
  constructor(private readonly prisma: PrismaService) {}

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
        const deliveredAt = new Date();
        const delivered = await tx.reportDeliveryRequest.update({
          where: { id: requestId },
          data: {
            status: "delivered",
            nextChunkIndex,
            deliveredAt,
            lastDeliveryErrorCode: null,
            lastDeliveryErrorAt: null,
          },
        });
        await tx.userResponse.updateMany({
          where: {
            id: request!.userResponseId,
            OR: [
              { reportDeliveredAt: null },
              { reportDeliveredAt: { lt: deliveredAt } },
            ],
          },
          data: { reportDeliveredAt: deliveredAt },
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

  private async lockResponse(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "user_responses" WHERE "id" = ${id} FOR UPDATE`;
  }

  private async lockDelivery(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "report_delivery_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
  }

  private async lockDeliveryByKey(tx: Prisma.TransactionClient, userResponseId: string, requestKey: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "report_delivery_requests" WHERE "userResponseId" = ${userResponseId} AND "requestKey" = ${requestKey} FOR UPDATE`;
  }
}
