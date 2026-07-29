import { Injectable, Logger } from "@nestjs/common";
import { Context } from "grammy";
import { UserService } from "../../user";
import { RateLimitService } from "../../rate-limit";
import { PromptService } from "../../prompt";
import { Prompt } from "@prisma/client";
import { RATE_LIMITS } from "../../../config/limits.config";

const WELCOME_MESSAGE = `Привет! Я Talking Bob — бот для практики разговорного английского.

Я буду отправлять тебе голосовые сообщения с вопросами на английском. Отвечай голосовым сообщением, и я дам обратную связь.

Через несколько секунд пришлю тебе первый вопрос...`;

const QUESTION_DELAY_MS = 5000;

@Injectable()
export class StartHandler {
  private readonly logger = new Logger(StartHandler.name);

  constructor(
    private readonly userService: UserService,
    private readonly rateLimitService: RateLimitService,
    private readonly promptService: PromptService,
  ) {}

  async handle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;
    const username = ctx.from?.username;

    if (!telegramId) {
      this.logger.warn("Received /start without user id");
      return;
    }

    const user = await this.userService.findOrCreateByTelegramId(
      BigInt(telegramId),
      username,
    );

    this.logger.log(`User registered/found: ${user.id} (tg: ${telegramId})`);

    const prompt = await this.promptService.getRandomActivePrompt();

    if (!prompt) {
      await ctx.reply("К сожалению, сейчас нет доступных вопросов.");
      return;
    }

    const admission = await this.rateLimitService.consumeCalendarDayLimit(
      user.id,
      "dialog_start",
      user.timezone,
      RATE_LIMITS.dialog_start.maxRequests,
    );

    if (!admission.allowed) {
      await ctx.reply(
        `Лимит новых диалогов на сегодня исчерпан (${RATE_LIMITS.dialog_start.maxRequests}). Попробуйте завтра.`,
      );
      return;
    }

    try {
      await this.promptService.recordPromptSent(user.id, prompt.id);
    } catch (error) {
      try {
        await this.rateLimitService.releaseAction(admission.requestId);
      } catch (releaseError) {
        this.logger.error("Failed to release dialog rate limit:", releaseError);
      }

      throw error;
    }

    await ctx.reply(WELCOME_MESSAGE);

    setTimeout(() => {
      this.sendPrompt(ctx, user.id, prompt).catch((err) => {
        this.logger.error("Failed to send prompt:", err);
      });
    }, QUESTION_DELAY_MS);
  }

  private async sendPrompt(
    ctx: Context,
    userId: string,
    prompt: Prompt,
  ): Promise<void> {
    if (prompt.audioFileId) {
      try {
        await ctx.replyWithVoice(prompt.audioFileId, {
          caption: `🎤 Тема: ${prompt.topic}\n\nПрослушай и ответь голосовым сообщением.`,
        });
      } catch {
        await ctx.reply(
          `🎤 Тема: ${prompt.topic}\n\n` +
            `Ответь голосовым сообщением на английском.`,
        );
      }
    } else {
      await ctx.reply(
        `🎤 Тема: ${prompt.topic}\n\n` +
          `Ответь голосовым сообщением на английском.`,
      );
    }

    this.logger.log(`Sent prompt ${prompt.id} to user ${userId}`);
  }
}
