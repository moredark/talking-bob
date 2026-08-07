import { Injectable, Logger } from "@nestjs/common";
import { Bot, GrammyError, HttpError } from "grammy";
import {
  DeliveryClaim,
  DeliveryOutcome,
  IMessageDispatcher,
} from "./message-dispatcher.interface";
import { ScheduleService } from "./schedule.service";

@Injectable()
export class DailyPromptDispatcher implements IMessageDispatcher {
  private readonly logger = new Logger(DailyPromptDispatcher.name);
  private bot: Bot | null = null;

  constructor(private readonly scheduleService: ScheduleService) {}

  setBot(bot: Bot): void {
    this.bot = bot;
  }

  async dispatch(claim: DeliveryClaim): Promise<DeliveryOutcome> {
    if (!this.bot) {
      this.logger.error("Bot not initialized");
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
    } catch {
      this.logger.error(
        `Could not persist successful delivery for user prompt ${claim.userPromptId}`,
      );
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
          `Telegram rejected delivery for user prompt ${claim.userPromptId}`,
        );
        return completed ? "failed" : "pending";
      }

      await this.scheduleService.completeDeliveryAmbiguousFailure(
        claim,
        attemptedAt,
      );
      const kind = error instanceof HttpError ? "transport" : "unknown";
      this.logger.warn(
        `Telegram delivery outcome is ambiguous for user prompt ${claim.userPromptId} (${kind})`,
      );
      return "pending";
    } catch {
      this.logger.error(
        `Could not persist failed delivery outcome for user prompt ${claim.userPromptId}`,
      );
      return "pending";
    }
  }
}
