import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { Bot } from "grammy";
import { IMessageDispatcher } from "./message-dispatcher.interface";
import { PromptService } from "../prompt";

/**
 * Dispatcher for daily prompts.
 * Handles the "what to send" logic - getting a random prompt and sending it to the user.
 */
@Injectable()
export class DailyPromptDispatcher implements IMessageDispatcher {
  private readonly logger = new Logger(DailyPromptDispatcher.name);
  private bot: Bot | null = null;

  constructor(private readonly promptService: PromptService) {}

  /**
   * Set the bot instance for sending messages.
   * Called by TelegramModule during initialization.
   */
  setBot(bot: Bot): void {
    this.bot = bot;
  }

  async dispatch(user: User): Promise<boolean> {
    if (!this.bot) {
      this.logger.error("Bot not initialized");
      return false;
    }

    try {
      const prompt = await this.promptService.getRandomActivePrompt();

      if (!prompt) {
        this.logger.warn("No active prompts available");
        return false;
      }

      await this.promptService.recordPromptSent(user.id, prompt.id);

      const chatId = Number(user.telegramId);

      if (prompt.audioFileId) {
        try {
          await this.bot.api.sendVoice(chatId, prompt.audioFileId, {
            caption: `🎤 Тема дня: ${prompt.topic}\n\nПрослушай и ответь голосовым сообщением.`,
          });
        } catch {
          await this.bot.api.sendMessage(
            chatId,
            `🎤 Тема дня: ${prompt.topic}\n\nОтветь голосовым сообщением на английском.`,
          );
        }
      } else {
        await this.bot.api.sendMessage(
          chatId,
          `🎤 Тема дня: ${prompt.topic}\n\nОтветь голосовым сообщением на английском.`,
        );
      }

      return true;
    } catch (error) {
      this.logger.warn(`Failed to send prompt to user ${user.id}: ${error}`);
      return false;
    }
  }
}
