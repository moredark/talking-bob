import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { RUNTIME_CONFIG } from "../../config/runtime-config.module";
import { RuntimeConfig } from "../../config/runtime.config";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { ErrorLogService } from "./error-log.service";
import { ObservabilityContextService } from "./observability-context.service";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DataRetentionResult {
  reportDeliveryRequests: number;
  conversationMessages: number;
  userResponses: number;
  userRequests: number;
  quotaWindows: number;
  errorLogs: number;
}

@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);
  private running = false;

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
    const contentCutoff = this.cutoff(now, this.config.retention.closedConversationContentDays);
    const rateLimitCutoff = this.cutoff(now, this.config.retention.rateLimitDays);
    const errorLogCutoff = this.cutoff(now, this.config.retention.errorLogsDays);

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

      return {
        reportDeliveryRequests: reportDeliveryRequests.count,
        conversationMessages: conversationMessages.count,
        userResponses: userResponses.count,
        userRequests: userRequests.count,
        quotaWindows: quotaWindows.count,
        errorLogs: errorLogs.count,
      };
    });
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
