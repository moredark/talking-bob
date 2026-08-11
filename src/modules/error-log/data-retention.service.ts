import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { RUNTIME_CONFIG } from "../../config/runtime-config.module";
import { RuntimeConfig } from "../../config/runtime.config";
import { RuntimeSettingsService } from "../../config/runtime-settings.service";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { ErrorLogService } from "./error-log.service";
import { ObservabilityContextService } from "./observability-context.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const AI_TRACE_RETENTION_BATCH_SIZE = 500;
const BROADCAST_RETENTION_BATCH_SIZE = 500;
const TERMINAL_BROADCAST_STATUSES = ["completed", "completed_with_errors", "cancelled"] as const;

export interface DataRetentionResult {
  reportDeliveryRequests: number;
  aiProviderCalls: number;
  userPrompts: number;
  conversationMessages: number;
  userResponses: number;
  userRequests: number;
  quotaWindows: number;
  errorLogs: number;
  adminAuditLogs: number;
  broadcastRecipients: number;
  broadcasts: number;
}

@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);
  private running = false;
  @Inject(RuntimeSettingsService) private readonly settings!: RuntimeSettingsService;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Optional() private readonly observability?: ObservabilityContextService,
    @Optional() private readonly errorLog?: ErrorLogService,
  ) {}

  @Cron("0 30 3 * * *")
  async runDailyCleanup(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const execute = () => this.runCorrelatedCleanup();
      if (this.observability) {
        await this.observability.run(
          { correlationId: this.observability.createCorrelationId("retention") },
          execute,
        );
      } else {
        await execute();
      }
    } finally {
      this.running = false;
    }
  }

  async cleanup(now = new Date()): Promise<DataRetentionResult> {
    const contentCutoff = this.cutoff(now, this.settings?.productNumber("RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS") ?? this.config.retention.closedConversationContentDays);
    const aiCallCutoff = this.cutoff(now, 30);
    const rateLimitCutoff = this.cutoff(now, this.settings?.productNumber("RETENTION_RATE_LIMIT_DAYS") ?? this.config.retention.rateLimitDays);
    const errorLogCutoff = this.cutoff(now, this.settings?.productNumber("RETENTION_ERROR_LOGS_DAYS") ?? this.config.retention.errorLogsDays);
    const adminAuditCutoff = this.cutoff(now, 365);
    const broadcastContentCutoff = this.cutoff(now, 90);
    const broadcastAggregateCutoff = this.cutoff(now, 365);

    const aiProviderCallCount = await this.purgeAiProviderCalls(aiCallCutoff, now);
    const broadcastRetention = await this.purgeBroadcastData(
      broadcastContentCutoff,
      broadcastAggregateCutoff,
      now,
    );
    return this.prisma.$transaction(async (tx) => {
      const closedConversation = {
        conversationStatus: "closed" as const,
        conversationClosedAt: { lt: contentCutoff },
      };

      const reportDeliveryRequests = await tx.reportDeliveryRequest.deleteMany({
        where: { userResponse: { userPrompt: closedConversation } },
      });
      const conversationMessages = await tx.conversationMessage.deleteMany({
        where: { userPrompt: closedConversation },
      });
      const userResponses = await tx.userResponse.updateMany({
        where: { userPrompt: closedConversation, sensitiveDataPurgedAt: null },
        data: {
          voiceFileId: null,
          transcript: null,
          analysis: null,
          sensitiveDataPurgedAt: now,
        },
      });

      const userPrompts = await tx.userPrompt.updateMany({
        where: { ...closedConversation, contentPurgedAt: null },
        data: { contentPurgedAt: now },
      });
      const userRequests = await tx.userRequest.deleteMany({
        where: {
          createdAt: { lt: rateLimitCutoff },
          OR: [
            { quotaWindowId: null },
            { quotaWindow: { windowEnd: { lte: now } } },
          ],
        },
      });
      const quotaWindows = await tx.quotaWindow.deleteMany({
        where: { windowEnd: { lt: rateLimitCutoff }, userRequests: { none: {} } },
      });
      const errorLogs = await tx.errorLog.deleteMany({
        where: { createdAt: { lt: errorLogCutoff } },
      });
      const adminAuditLogs = await tx.adminAuditLog.deleteMany({
        where: { createdAt: { lt: adminAuditCutoff } },
      });

      return {
        reportDeliveryRequests: reportDeliveryRequests.count,
        aiProviderCalls: aiProviderCallCount,
        userPrompts: userPrompts.count,
        conversationMessages: conversationMessages.count,
        userResponses: userResponses.count,
        userRequests: userRequests.count,
        quotaWindows: quotaWindows.count,
        errorLogs: errorLogs.count,
        adminAuditLogs: adminAuditLogs.count,
        broadcastRecipients: broadcastRetention.recipients,
        broadcasts: broadcastRetention.broadcasts,
      };
    });
  }

  private async purgeBroadcastData(
    contentCutoff: Date,
    aggregateCutoff: Date,
    now: Date,
  ): Promise<{ recipients: number; broadcasts: number }> {
    let recipients = 0;
    let broadcasts = 0;

    while (true) {
      const result = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.broadcast.findMany({
          where: {
            status: { in: [...TERMINAL_BROADCAST_STATUSES] },
            terminalAt: { lt: contentCutoff },
            OR: [
              { contentPurgedAt: null },
              { recipients: { some: {} } },
            ],
          },
          orderBy: [{ terminalAt: "asc" }, { id: "asc" }],
          take: BROADCAST_RETENTION_BATCH_SIZE,
          select: { id: true },
        });
        if (rows.length === 0) return { selected: 0, recipients: 0 };
        const ids = rows.map((row) => row.id);
        const deleted = await tx.broadcastRecipient.deleteMany({
          where: { broadcastId: { in: ids } },
        });
        await tx.broadcast.updateMany({
          where: { id: { in: ids } },
          data: { content: null, contentPurgedAt: now },
        });
        return { selected: rows.length, recipients: deleted.count };
      });
      recipients += result.recipients;
      if (result.selected === 0) break;
    }

    while (true) {
      const result = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.broadcast.findMany({
          where: {
            status: { in: [...TERMINAL_BROADCAST_STATUSES] },
            terminalAt: { lt: aggregateCutoff },
          },
          orderBy: [{ terminalAt: "asc" }, { id: "asc" }],
          take: BROADCAST_RETENTION_BATCH_SIZE,
          select: { id: true },
        });
        if (rows.length === 0) return { selected: 0, deleted: 0 };
        const deleted = await tx.broadcast.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
        return { selected: rows.length, deleted: deleted.count };
      });
      broadcasts += result.deleted;
      if (result.selected === 0) break;
    }

    return { recipients, broadcasts };
  }

  private async purgeAiProviderCalls(cutoff: Date, now: Date): Promise<number> {
    let total = 0;
    while (true) {
      const result = await this.prisma.$transaction(async (tx) => {
        const batch = await tx.aiProviderCall.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: AI_TRACE_RETENTION_BATCH_SIZE,
          select: { id: true, userPromptId: true },
        });
        if (batch.length === 0) return { selected: 0, deleted: 0 };
        const deleted = await tx.aiProviderCall.deleteMany({
          where: { id: { in: batch.map((row) => row.id) } },
        });
        await tx.userPrompt.updateMany({
          where: { id: { in: [...new Set(batch.map((row) => row.userPromptId))] } },
          data: { aiTracePurgedAt: now },
        });
        return { selected: batch.length, deleted: deleted.count };
      });
      total += result.deleted;
      if (result.selected === 0) return total;
    }
  }

  private cutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * DAY_MS);
  }

  private async runCorrelatedCleanup(): Promise<void> {
    try {
      const result = await this.cleanup();
      this.logger.log(
        `Retention cleanup completed: ${Object.values(result).reduce((sum, count) => sum + count, 0)} rows changed`,
      );
    } catch (error) {
      this.logger.error(
        `Retention cleanup failed (${error instanceof Error ? error.name : "UnknownError"})`,
      );
      await this.errorLog?.capture({
        type: "system",
        service: "scheduler",
        operation: "retention.cleanup",
        error,
        retryable: true,
      });
    }
  }
}
