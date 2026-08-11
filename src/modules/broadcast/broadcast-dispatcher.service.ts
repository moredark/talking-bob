import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { BroadcastRecipient, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import AbortController from "abort-controller";
import { PrismaService } from "../../infrastructure/database";
import { ErrorLogService } from "../error-log";
import { BROADCAST_LIMITS, BroadcastSendError, BroadcastSender } from "./broadcast.contracts";

type ClaimedRecipient = BroadcastRecipient & { content: string; claimToken: string };

@Injectable()
export class BroadcastDispatcher {
  private readonly logger = new Logger(BroadcastDispatcher.name);
  private sender?: BroadcastSender;
  private running = false;
  private shuttingDown = false;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly shutdownController = new AbortController();
  private shutdownFenceTimer?: NodeJS.Timeout;
  private readonly ownedClaims = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLog: ErrorLogService,
  ) {}

  setSender(sender: BroadcastSender): void {
    this.sender = sender;
  }

  @Interval(5_000)
  async tick(): Promise<void> {
    if (!this.sender || this.running || this.shuttingDown) return;
    this.running = true;
    const work = this.dispatchDue().catch(async (error: unknown) => {
      this.logger.error(`Broadcast dispatcher tick failed (${this.errorKind(error)})`);
      await this.errorLog.capture({
        type: "system",
        service: "scheduler",
        operation: "broadcast.dispatch",
        error,
        retryable: true,
      });
    }).finally(() => {
      this.running = false;
    });
    this.inFlight = work;
    await work;
  }

  stopAdmission(deadline = Date.now()): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const delay = Math.max(0, deadline - Date.now());
    this.shutdownFenceTimer = setTimeout(() => {
      if (!this.shutdownController.signal.aborted) this.shutdownController.abort();
    }, delay);
  }

  drain(): Promise<void> {
    return this.inFlight;
  }

  async finishShutdown(drained: boolean): Promise<void> {
    if (this.shutdownFenceTimer) {
      clearTimeout(this.shutdownFenceTimer);
      this.shutdownFenceTimer = undefined;
    }
    if (drained) {
      if (!this.shutdownController.signal.aborted) this.shutdownController.abort();
      return;
    }
    await this.activateShutdownFence();
  }

  private async activateShutdownFence(): Promise<void> {
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort();
    const owned = [...this.ownedClaims.entries()];
    const expiresAt = new Date();
    await Promise.all(owned.map(async ([id, claimToken]) => {
      await this.prisma.broadcastRecipient.updateMany({
        where: { id, status: "pending", claimToken },
        data: { claimToken: randomUUID(), claimExpiresAt: expiresAt },
      });
      if (this.ownedClaims.get(id) === claimToken) this.ownedClaims.delete(id);
    }));
  }

  async dispatchDue(now = new Date()): Promise<void> {
    const sender = this.sender;
    if (!sender) return;
    await this.prisma.broadcast.updateMany({
      where: { status: "queued", scheduledAt: { lte: now } },
      data: { status: "processing" },
    });
    const reconciledIds = await this.reconcileExpiredClaims(now);
    const claims = await this.claimRecipients(now);
    await this.runBounded(claims, (claim) => this.deliver(claim, sender, now));
    const broadcastIds = [...new Set([...reconciledIds, ...claims.map((claim) => claim.broadcastId)])];
    const zeroOrTerminal = await this.prisma.broadcast.findMany({
      where: { status: "processing", recipients: { none: { status: "pending" } } },
      select: { id: true },
      take: BROADCAST_LIMITS.claimBatch,
    });
    for (const id of zeroOrTerminal.map((row) => row.id)) broadcastIds.push(id);
    await Promise.all([...new Set(broadcastIds)].map((id) => this.finalize(id, new Date())));
  }

  private async reconcileExpiredClaims(now: Date): Promise<string[]> {
    const expired = await this.prisma.broadcastRecipient.findMany({
      where: { status: "pending", claimToken: { not: null }, claimExpiresAt: { lte: now } },
      select: { id: true, broadcastId: true, deliveryAttemptedAt: true },
      take: BROADCAST_LIMITS.claimBatch,
      orderBy: [{ claimExpiresAt: "asc" }, { id: "asc" }],
    });
    for (const row of expired) {
      if (row.deliveryAttemptedAt) {
        await this.finishExpiredAmbiguous(row.id, row.broadcastId, now);
      } else {
        await this.prisma.broadcastRecipient.updateMany({
          where: { id: row.id, status: "pending", claimExpiresAt: { lte: now } },
          data: { claimToken: null, claimExpiresAt: null },
        });
      }
    }
    return expired.map((row) => row.broadcastId);
  }

  private async claimRecipients(now: Date): Promise<ClaimedRecipient[]> {
    const leaseUntil = new Date(now.getTime() + BROADCAST_LIMITS.claimLeaseMs);
    const claimed = await this.prisma.$transaction(async (tx) => {
      const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT recipient."id"
        FROM "broadcast_recipients" recipient
        JOIN "broadcasts" broadcast ON broadcast."id" = recipient."broadcastId"
        WHERE recipient."status" = 'pending'::"BroadcastRecipientStatus"
          AND recipient."claimToken" IS NULL
          AND (recipient."nextAttemptAt" IS NULL OR recipient."nextAttemptAt" <= ${now})
          AND broadcast."status" = 'processing'::"BroadcastStatus"
        ORDER BY broadcast."scheduledAt" ASC, recipient."createdAt" ASC, recipient."id" ASC
        FOR UPDATE OF recipient SKIP LOCKED
        LIMIT ${BROADCAST_LIMITS.claimBatch}
      `);
      const claims: Array<{ id: string; token: string }> = [];
      for (const row of ids) {
        const token = randomUUID();
        const updated = await tx.broadcastRecipient.updateMany({
          where: { id: row.id, status: "pending", claimToken: null },
          data: { claimToken: token, claimExpiresAt: leaseUntil },
        });
        if (updated.count === 1) claims.push({ id: row.id, token });
      }
      if (claims.length === 0) return [];
      const rows = await tx.broadcastRecipient.findMany({
        where: { id: { in: claims.map((claim) => claim.id) } },
        include: { broadcast: { select: { content: true } } },
      });
      const tokenById = new Map(claims.map((claim) => [claim.id, claim.token]));
      return rows.flatMap<ClaimedRecipient>((row) => {
        const token = tokenById.get(row.id);
        const content = row.broadcast.content;
        if (!token || content === null) return [];
        const { broadcast, ...recipient } = row;
        return [{ ...recipient, content, claimToken: token }];
      });
    });
    for (const claim of claimed) this.ownedClaims.set(claim.id, claim.claimToken);
    return claimed;
  }

  private async deliver(claim: ClaimedRecipient, sender: BroadcastSender, now: Date): Promise<void> {
    if (this.shutdownController.signal.aborted) return;
    const eligible = await this.prisma.user.findFirst({
      where: {
        id: claim.userId,
        status: "active",
        bannedAt: null,
        announcementEnabled: true,
      },
      select: { id: true },
    });
    if (this.shutdownController.signal.aborted) return;
    if (!eligible) {
      await this.finishTerminal(claim, "skipped", "recipient_ineligible", now);
      this.releaseOwnedClaim(claim);
      return;
    }

    const attempt = claim.attemptCount + 1;
    if (this.shutdownController.signal.aborted) return;
    const admitted = await this.prisma.broadcastRecipient.updateMany({
      where: { id: claim.id, status: "pending", claimToken: claim.claimToken },
      data: {
        attemptCount: { increment: 1 },
        deliveryAttemptedAt: now,
        nextAttemptAt: null,
      },
    });
    if (admitted.count !== 1) {
      this.releaseOwnedClaim(claim);
      return;
    }

    try {
      await sender.sendPlainText(claim.telegramIdSnapshot, claim.content, this.shutdownController.signal);
      if (this.shutdownController.signal.aborted) return;
      await this.finishTerminal(claim, "sent", null, new Date());
      this.releaseOwnedClaim(claim);
    } catch (error) {
      if (this.shutdownController.signal.aborted) return;
      const classified = this.classify(error);
      const errorAt = new Date();
      if (classified.code === "telegram_runtime_closed") {
        await this.prisma.broadcastRecipient.updateMany({
          where: { id: claim.id, status: "pending", claimToken: claim.claimToken },
          data: {
            attemptCount: { decrement: 1 },
            claimToken: null,
            claimExpiresAt: null,
            nextAttemptAt: null,
            deliveryAttemptedAt: null,
            lastErrorCode: classified.code,
            lastErrorAt: errorAt,
          },
        });
      } else if (classified.ambiguous) {
        await this.finishError(claim, "ambiguous", classified.code, errorAt);
      } else if (classified.retryable && attempt < BROADCAST_LIMITS.maxAttempts) {
        const retryMs = Math.max(
          classified.retryAfterSeconds ? classified.retryAfterSeconds * 1000 : 0,
          30_000 * 2 ** (attempt - 1),
        );
        await this.prisma.broadcastRecipient.updateMany({
          where: { id: claim.id, status: "pending", claimToken: claim.claimToken },
          data: {
            claimToken: null,
            claimExpiresAt: null,
            nextAttemptAt: new Date(errorAt.getTime() + retryMs),
            deliveryAttemptedAt: null,
            lastErrorCode: classified.code,
            lastErrorAt: errorAt,
          },
        });
      } else {
        await this.finishError(claim, "failed", classified.code, errorAt);
      }
      this.releaseOwnedClaim(claim);
      await this.errorLog.capture({
        type: "telegram",
        service: "telegram",
        operation: "broadcast.send",
        userId: claim.userId,
        code: classified.code,
        retryable: classified.retryable,
        metadata: { broadcastId: claim.broadcastId, recipientId: claim.id, attempt },
      });
    }
  }

  private releaseOwnedClaim(claim: ClaimedRecipient): void {
    if (this.ownedClaims.get(claim.id) === claim.claimToken) this.ownedClaims.delete(claim.id);
  }

  private finishError(claim: ClaimedRecipient, status: "failed" | "ambiguous", code: string, now: Date) {
    return this.finishTerminal(claim, status, code, now);
  }

  private finishTerminal(
    claim: ClaimedRecipient,
    status: "sent" | "failed" | "ambiguous" | "skipped",
    code: string | null,
    now: Date,
  ): Promise<void> {
    if (this.shutdownController.signal.aborted) return Promise.resolve();
    const countField = status === "sent" ? "sentCount"
      : status === "failed" ? "failedCount"
        : status === "ambiguous" ? "ambiguousCount" : "skippedCount";
    return this.prisma.$transaction(async (tx) => {
      if (this.shutdownController.signal.aborted) return;
      const updated = await tx.broadcastRecipient.updateMany({
        where: { id: claim.id, status: "pending", claimToken: claim.claimToken },
        data: {
          status,
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          ...(status === "sent" ? { sentAt: now, lastErrorCode: null, lastErrorAt: null }
            : { lastErrorCode: code, lastErrorAt: now }),
        },
      });
      if (updated.count === 1) {
        await tx.broadcast.updateMany({
          where: { id: claim.broadcastId, status: "processing" },
          data: { [countField]: { increment: 1 } },
        });
      }
    });
  }

  private finishExpiredAmbiguous(id: string, broadcastId: string, now: Date): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.broadcastRecipient.updateMany({
        where: {
          id,
          status: "pending",
          deliveryAttemptedAt: { not: null },
          claimExpiresAt: { lte: now },
        },
        data: {
          status: "ambiguous",
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          lastErrorCode: "lease_expired_after_io",
          lastErrorAt: now,
        },
      });
      if (updated.count === 1) {
        await tx.broadcast.updateMany({
          where: { id: broadcastId, status: "processing" },
          data: { ambiguousCount: { increment: 1 } },
        });
      }
    });
  }

  private async finalize(broadcastId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.broadcast.findUnique({ where: { id: broadcastId } });
      if (!current || current.status !== "processing") return;
      const grouped = await tx.broadcastRecipient.groupBy({
        by: ["status"],
        where: { broadcastId },
        _count: { _all: true },
      });
      const counts = new Map(grouped.map((row) => [row.status, row._count._all]));
      const pending = counts.get("pending") ?? 0;
      const failed = counts.get("failed") ?? 0;
      const ambiguous = counts.get("ambiguous") ?? 0;
      if (pending !== 0) return;
      await tx.broadcast.updateMany({
        where: { id: broadcastId, status: "processing" },
        data: {
          status: failed > 0 || ambiguous > 0 ? "completed_with_errors" : "completed",
          terminalAt: now,
        },
      });
    });
  }

  private classify(error: unknown): BroadcastSendError {
    const source = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
    const response = source.error !== null && typeof source.error === "object"
      ? source.error as Record<string, unknown>
      : source.response !== null && typeof source.response === "object"
        ? source.response as Record<string, unknown>
        : source;
    const status = typeof response.error_code === "number"
      ? response.error_code
      : typeof response.statusCode === "number" ? response.statusCode
        : typeof source.statusCode === "number" ? source.statusCode : undefined;
    const parameters = response.parameters !== null && typeof response.parameters === "object"
      ? response.parameters as Record<string, unknown>
      : {};
    if (source.name === "TelegramRuntimeClosedError") {
      return { code: "telegram_runtime_closed", retryable: true, ambiguous: false };
    }
    const retryAfterSeconds = typeof parameters.retry_after === "number" && parameters.retry_after >= 0
      ? Math.ceil(parameters.retry_after)
      : undefined;
    if (status === 429) return { code: "telegram_429", retryable: true, retryAfterSeconds, ambiguous: false };
    if (status !== undefined && status >= 500) return { code: `telegram_${status}`, retryable: true, ambiguous: false };
    if (status !== undefined) return { code: `telegram_${status}`, retryable: false, ambiguous: false };
    return { code: "telegram_outcome_unknown", retryable: false, ambiguous: true };
  }

  private async runBounded<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(BROADCAST_LIMITS.concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await task(item);
      }
    });
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }
}
