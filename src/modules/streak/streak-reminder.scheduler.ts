import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { StreakReminderDispatcher } from "./streak-reminder.dispatcher";
import { StreakService } from "./streak.service";

@Injectable()
export class StreakReminderScheduler {
  private readonly logger = new Logger(StreakReminderScheduler.name);
  private processing = false;

  constructor(
    private readonly streakService: StreakService,
    private readonly dispatcher: StreakReminderDispatcher,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processDueReminders(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const claims = await this.streakService.claimDueReminders();
      for (const claim of claims) {
        try {
          await this.dispatcher.dispatch(claim);
        } catch (error) {
          this.logger.error(
            `Unhandled streak reminder error (${error instanceof Error ? error.name : "UnknownError"})`,
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
