import { Injectable, Logger, Optional } from "@nestjs/common";
import { Bot, HttpError } from "grammy";
import { ErrorLogService } from "../error-log";
import {
  StreakReminderClaim,
  StreakReminderAttempt,
  StreakService,
} from "./streak.service";

@Injectable()
export class StreakReminderDispatcher {
  private readonly logger = new Logger(StreakReminderDispatcher.name);
  private bot: Bot | null = null;

  constructor(
    private readonly streakService: StreakService,
    @Optional() private readonly errorLog?: ErrorLogService,
  ) {}

  setBot(bot: Bot): void {
    this.bot = bot;
  }

  async dispatch(claim: StreakReminderClaim): Promise<"sent" | "terminal" | "retry" | "skipped"> {
    if (!this.bot) return "skipped";
    let attempt: StreakReminderAttempt | null;
    try {
      // This is the durable eligibility fence immediately before Telegram I/O.
      attempt = await this.streakService.beginReminderAttempt(claim);
    } catch (error) {
      await this.capture("persist_attempt", claim, error, true);
      return "skipped";
    }
    if (!attempt) return "skipped";

    const text =
      `🔥 Ваш стрик — ${attempt.currentStreak} дней.\n\n` +
      "Завершите диалог сегодня до полуночи, иначе стрик пропадёт.";
    try {
      await this.bot.api.sendMessage(attempt.telegramId.toString(), text);
    } catch (error) {
      if (this.isRetryableDefiniteFailure(error)) {
        const failedAt = new Date();
        await this.streakService.completeReminderRetryableFailure(
          attempt,
          this.errorCode(error),
          failedAt,
          this.retryAfterSeconds(error),
        );
        await this.capture("send", claim, error, true);
        return "retry";
      }
      // Transport and unknown failures are ambiguous after I/O began, so they
      // are terminal to prevent a duplicate Telegram notification.
      await this.streakService.completeReminderTerminalFailure(
        attempt,
        error instanceof HttpError ? "telegram_transport_ambiguous" : this.errorCode(error),
      );
      await this.capture("send", claim, error, false);
      return "terminal";
    }

    try {
      await this.streakService.completeReminderSuccess(attempt);
      return "sent";
    } catch (error) {
      // Telegram accepted the message. Never resend if success persistence is
      // unavailable; deliveryAttemptedAt keeps this identity non-claimable.
      this.logger.error("Could not persist successful streak reminder");
      await this.capture("persist_success", claim, error, false);
      return "terminal";
    }
  }

  private isRetryableDefiniteFailure(error: unknown): boolean {
    const status = this.telegramStatus(error);
    return status === 429 || (status !== undefined && status >= 500);
  }

  private errorCode(error: unknown): string {
    const status = this.telegramStatus(error);
    if (status !== undefined) return `telegram_api_${status}`;
    if (error instanceof HttpError) return "telegram_transport_ambiguous";
    return error instanceof Error ? error.name : "unknown_error";
  }

  private retryAfterSeconds(error: unknown): number | undefined {
    const response = this.telegramResponse(error);
    const parameters =
      response.parameters !== null && typeof response.parameters === "object"
        ? response.parameters as Record<string, unknown>
        : {};
    return typeof parameters.retry_after === "number" &&
      parameters.retry_after >= 0
      ? Math.ceil(parameters.retry_after)
      : undefined;
  }

  private telegramStatus(error: unknown): number | undefined {
    const source =
      error !== null && typeof error === "object"
        ? error as Record<string, unknown>
        : {};
    const response = this.telegramResponse(error);
    return typeof response.error_code === "number"
      ? response.error_code
      : typeof response.statusCode === "number"
        ? response.statusCode
        : typeof source.statusCode === "number"
          ? source.statusCode
          : undefined;
  }

  private telegramResponse(error: unknown): Record<string, unknown> {
    const source =
      error !== null && typeof error === "object"
        ? error as Record<string, unknown>
        : {};
    return (
      source.error !== null && typeof source.error === "object"
        ? source.error as Record<string, unknown>
        : source.response !== null && typeof source.response === "object"
          ? source.response as Record<string, unknown>
          : source
    );
  }

  private async capture(
    operation: string,
    claim: StreakReminderClaim,
    error: unknown,
    retryable: boolean,
  ): Promise<void> {
    this.logger.warn(`Streak reminder ${operation} failed (${this.errorCode(error)})`);
    await this.errorLog?.capture({
      type: "telegram",
      service: "telegram",
      operation: `reminder.${operation}`,
      userId: claim.userId,
      requestId: claim.reminderId,
      error,
      retryable,
      code: this.errorCode(error),
    });
  }
}
