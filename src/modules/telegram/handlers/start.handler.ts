import { Inject, Injectable, Logger } from "@nestjs/common";
import { Context } from "grammy";
import { RATE_LIMITS } from "../../../config/limits.config";
import { PromptService } from "../../prompt";
import { RateLimitService } from "../../rate-limit";
import {
  IMessageDispatcher,
  MESSAGE_DISPATCHER,
  ScheduleService,
} from "../../schedule";
import { UserService } from "../../user";

const WELCOME_MESSAGE = `Привет! Я Talking Bob — бот для практики разговорного английского.

Я буду отправлять тебе голосовые сообщения с вопросами на английском. Отвечай голосовым сообщением, и я дам обратную связь.

Сейчас пришлю тебе первый вопрос.`;

@Injectable()
export class StartHandler {
  private readonly logger = new Logger(StartHandler.name);

  constructor(
    private readonly userService: UserService,
    private readonly rateLimitService: RateLimitService,
    private readonly promptService: PromptService,
    private readonly scheduleService: ScheduleService,
    @Inject(MESSAGE_DISPATCHER)
    private readonly messageDispatcher: IMessageDispatcher,
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

    let claim;
    try {
      claim = await this.scheduleService.createManualClaim(user, prompt);
    } catch (error) {
      try {
        await this.rateLimitService.releaseAction(admission.requestId);
      } catch {
        this.logger.error("Failed to release dialog rate limit");
      }
      throw error;
    }

    try {
      await ctx.reply(WELCOME_MESSAGE);
    } catch {
      this.logger.warn("Could not send the welcome message");
    }
    await this.messageDispatcher.dispatch(claim);
  }
}
