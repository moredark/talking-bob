import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ScheduleService } from "./schedule.service";
import { MESSAGE_DISPATCHER, IMessageDispatcher } from "./message-dispatcher.interface";
import { ErrorLogService, ObservabilityContextService } from "../error-log";

/**
 * Cron-based scheduler service.
 * Runs every minute and processes users who are due for their scheduled message.
 *
 * Key design decisions:
 * 1. Database-driven: Reads from DB, not memory timers
 * 2. Idempotent: Safe to run multiple times - nextPromptAt prevents duplicates
 * 3. Restart-safe: State is in DB, survives restarts
 * 4. Horizontally scalable: Can add locking for multiple instances (see comments)
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private isProcessing = false;

  constructor(
    private readonly scheduleService: ScheduleService,
    @Inject(MESSAGE_DISPATCHER)
    private readonly messageDispatcher: IMessageDispatcher,
    @Optional() private readonly errorLog?: ErrorLogService,
    @Optional() private readonly observability?: ObservabilityContextService,
  ) {}

  /**
   * Main cron job - runs every minute.
   * Queries users where nextPromptAt <= now and sends them their message.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledMessages(): Promise<void> {
    if (!this.observability) return this.processScheduledMessagesCorrelated();
    return this.observability.run(
      { correlationId: this.observability.createCorrelationId("schedule") },
      () => this.processScheduledMessagesCorrelated(),
    );
  }

  private async processScheduledMessagesCorrelated(): Promise<void> {
    // Prevent overlapping executions within the same instance
    if (this.isProcessing) {
      this.logger.debug("Previous tick still processing, skipping");
      return;
    }

    this.isProcessing = true;

    try {
      await this.scheduleService.repairAllSchedules();
      const claims = await this.scheduleService.claimScheduledBatch();

      if (claims.length === 0) {
        return;
      }

      this.logger.log(`Processing ${claims.length} scheduled messages`);

      let successCount = 0;

      for (const claim of claims) {
        try {
          const outcome = await this.messageDispatcher.dispatch(claim);

          if (outcome === "sent") {
            successCount++;
          }
        } catch (error) {
          this.logger.error(
            "Error processing scheduled delivery claim",
          );
          await this.errorLog?.capture({
            type: "system",
            service: "scheduler",
            operation: "claim.dispatch",
            userId: claim.user.id,
            requestId: claim.userPromptId,
            error,
            retryable: true,
          });
          // Continue with other users even if one fails
        }
      }

      if (successCount > 0) {
        this.logger.log(`Successfully sent ${successCount} scheduled messages`);
      }
    } catch (error) {
      this.logger.error(`Scheduler tick failed (${this.errorKind(error)})`);
      await this.errorLog?.capture({
        type: "system",
        service: "scheduler",
        operation: "tick",
        error,
        retryable: true,
      });
    } finally {
      this.isProcessing = false;
    }
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }
}
