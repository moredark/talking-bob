import { Injectable, Logger, Optional } from "@nestjs/common";
import { Bot, GrammyError, HttpError } from "grammy";
import {
  DeliveryClaim,
  DeliveryOutcome,
  IMessageDispatcher,
} from "./message-dispatcher.interface";
import { ScheduleService } from "./schedule.service";
import { ErrorLogService, ObservabilityContextService } from "../error-log";

@Injectable()
export class DailyPromptDispatcher implements IMessageDispatcher {
  private readonly logger = new Logger(DailyPromptDispatcher.name);
  private bot: Bot | null = null;

  constructor(
    private readonly scheduleService: ScheduleService,
    @Optional() private readonly errorLog?: ErrorLogService,
    @Optional() private readonly observability?: ObservabilityContextService,
  ) {}

  setBot(bot: Bot): void {
    this.bot = bot;
  }

  async dispatch(claim: DeliveryClaim): Promise<DeliveryOutcome> {
    if (!this.observability) return this.dispatchCorrelated(claim);
    const current = this.observability.current();
    return this.observability.run(
      {
        ...current,
        correlationId: this.observability.createCorrelationId("delivery"),
        userId: claim.user.id,
        requestId: claim.userPromptId,
      },
      () => this.dispatchCorrelated(claim),
    );
  }

  private async dispatchCorrelated(claim: DeliveryClaim): Promise<DeliveryOutcome> {
    if (!this.bot) {
      this.logger.error("Bot not initialized");
      await this.errorLog?.capture({
        type: "system", service: "scheduler", operation: "delivery.bot_unavailable",
        userId: claim.user.id, requestId: claim.userPromptId,
        code: "bot_unavailable", retryable: true,
      });
      return "not_attempted";
    }

    const attemptedAt = await this.scheduleService.beginDeliveryAttempt(claim);
    if (!attemptedAt) {
      return "not_attempted";
    }

    const chatId = claim.user.telegramId.toString();
    const text =
      `🎤 Тема дня: ${claim.prompt.topic}\n\n` +
      "Ответь голосовым сообщением на английском.";

    if (!claim.prompt.audioFileId) {
      try {
        await this.bot.api.sendMessage(chatId, text);
        return this.completeSuccess(claim, attemptedAt);
      } catch (error) {
        return this.completeFailure(claim, attemptedAt, error);
      }
    }

    try {
      await this.bot.api.sendVoice(chatId, claim.prompt.audioFileId, {
        caption:
          `🎤 Тема дня: ${claim.prompt.topic}\n\n` +
          "Прослушай и ответь голосовым сообщением.",
      });
      return this.completeSuccess(claim, attemptedAt);
    } catch (error) {
      if (!(error instanceof GrammyError)) {
        return this.completeFailure(claim, attemptedAt, error);
      }
    }

    try {
      await this.bot.api.sendMessage(chatId, text);
      return this.completeSuccess(claim, attemptedAt);
    } catch (error) {
      return this.completeFailure(claim, attemptedAt, error);
    }
  }

  private async completeSuccess(
    claim: DeliveryClaim,
    attemptedAt: Date,
  ): Promise<DeliveryOutcome> {
    try {
      const completed = await this.scheduleService.completeDeliverySuccess(
        claim,
        attemptedAt,
      );
      return completed ? "sent" : "pending";
    } catch (error) {
      this.logger.error(
        "Could not persist successful scheduled delivery",
      );
      await this.errorLog?.capture({
        type: "system", service: "scheduler", operation: "delivery.persist_success",
        userId: claim.user.id, requestId: claim.userPromptId, error, retryable: true,
      });
      return "pending";
    }
  }

  private async completeFailure(
    claim: DeliveryClaim,
    attemptedAt: Date,
    error: unknown,
  ): Promise<DeliveryOutcome> {
    try {
      if (error instanceof GrammyError) {
        const completed =
          await this.scheduleService.completeDeliveryDefiniteFailure(
            claim,
            attemptedAt,
          );
        this.logger.warn(
          "Telegram rejected scheduled delivery",
        );
        await this.errorLog?.capture({
          type: "telegram", service: "scheduler", operation: "delivery.send",
          userId: claim.user.id, requestId: claim.userPromptId, error,
          retryable: false, code: "definite",
        });
        return completed ? "failed" : "pending";
      }

      await this.scheduleService.completeDeliveryAmbiguousFailure(
        claim,
        attemptedAt,
      );
      const kind = error instanceof HttpError ? "transport" : "unknown";
      this.logger.warn(
        `Telegram scheduled delivery outcome is ambiguous (${kind})`,
      );
      await this.errorLog?.capture({
        type: "telegram", service: "scheduler", operation: "delivery.send",
        userId: claim.user.id, requestId: claim.userPromptId, error,
        retryable: true, code: kind,
      });
      return "pending";
    } catch (persistenceError) {
      this.logger.error(
        "Could not persist failed scheduled delivery outcome",
      );
      await this.errorLog?.capture({
        type: "system", service: "scheduler", operation: "delivery.persist_failure",
        userId: claim.user.id, requestId: claim.userPromptId,
        error: persistenceError, retryable: true,
      });
      return "pending";
    }
  }
}
