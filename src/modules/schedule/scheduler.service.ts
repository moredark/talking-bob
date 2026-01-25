import { Injectable, Inject, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ScheduleService } from "./schedule.service";
import { MESSAGE_DISPATCHER, IMessageDispatcher } from "./message-dispatcher.interface";

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
  ) {}

  /**
   * Main cron job - runs every minute.
   * Queries users where nextPromptAt <= now and sends them their message.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledMessages(): Promise<void> {
    // Prevent overlapping executions within the same instance
    if (this.isProcessing) {
      this.logger.debug("Previous tick still processing, skipping");
      return;
    }

    this.isProcessing = true;

    try {
      const users = await this.scheduleService.getUsersDueForPrompt();

      if (users.length === 0) {
        return;
      }

      this.logger.log(`Processing ${users.length} scheduled messages`);

      let successCount = 0;

      for (const user of users) {
        try {
          // Mark as sent BEFORE sending to prevent duplicates on failure-retry
          // This is a "at-most-once" delivery semantic
          // For "at-least-once", move markPromptSent after dispatch
          await this.scheduleService.markPromptSent(user.id);

          const success = await this.messageDispatcher.dispatch(user);

          if (success) {
            successCount++;
          }
        } catch (error) {
          this.logger.error(`Error processing user ${user.id}: ${error}`);
          // Continue with other users even if one fails
        }
      }

      if (successCount > 0) {
        this.logger.log(`Successfully sent ${successCount} scheduled messages`);
      }
    } catch (error) {
      this.logger.error(`Scheduler tick error: ${error}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

/**
 * FUTURE IMPROVEMENTS for horizontal scaling:
 *
 * 1. Database-level locking (PostgreSQL advisory locks):
 *    - Use SELECT ... FOR UPDATE SKIP LOCKED to claim users
 *    - This allows multiple instances to process different users
 *
 * 2. Redis-based distributed lock:
 *    - Use Redlock algorithm to ensure only one instance runs the scheduler
 *    - Good for "only one scheduler" approach
 *
 * 3. BullMQ migration:
 *    - Move to job queue for better reliability and monitoring
 *    - Each user's schedule becomes a delayed job
 *    - Built-in retry, dead letter queue, and concurrency control
 *
 * Example with PostgreSQL advisory locks:
 *
 * async processWithLocking() {
 *   const users = await this.prisma.$queryRaw`
 *     SELECT * FROM users
 *     WHERE daily_prompt_enabled = true
 *       AND next_prompt_at <= NOW()
 *     FOR UPDATE SKIP LOCKED
 *     LIMIT 100
 *   `;
 *   // Process users...
 * }
 */
