import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
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
import { ErrorLogService, ObservabilityContextService } from "../../error-log";

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
    @Optional() private readonly errorLog?: ErrorLogService,
    @Optional() private readonly observability?: ObservabilityContextService,
  ) {}

  async handle(ctx: Context): Promise<void> {
    await this.handleRequest(ctx, true);
  }

  async handleNewQuestion(ctx: Context): Promise<void> {
    await this.handleRequest(ctx, false);
  }

  private async handleRequest(
    ctx: Context,
    shouldSendWelcome: boolean,
  ): Promise<void> {
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
    this.observability?.enrich({ userId: user.id });
    this.logger.log("User registration resolved");

    if (!(await this.promptService.hasActivePrompt())) {
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
      claim = await this.scheduleService.createManualClaim(user);
    } catch (error) {
      await this.releaseAdmission(admission.requestId, user.id);
      throw error;
    }

    if (!claim) {
      await this.releaseAdmission(admission.requestId, user.id);
      await ctx.reply("К сожалению, сейчас нет доступных вопросов.");
      return;
    }

    if (shouldSendWelcome) {
      try {
        await ctx.reply(WELCOME_MESSAGE);
      } catch (error) {
        this.logger.warn("Could not send the welcome message");
        void this.errorLog?.capture({
          type: "telegram",
          service: "telegram",
          operation: "start.send_welcome",
          userId: user.id,
          error,
          retryable: true,
        });
      }
    }
    await this.messageDispatcher.dispatch(claim);
  }

  private async releaseAdmission(
    requestId: string,
    userId: string,
  ): Promise<void> {
    try {
      await this.rateLimitService.releaseAction(requestId);
    } catch {
      this.logger.error("Failed to release dialog rate limit");
      void this.errorLog?.capture({
        type: "system",
        service: "telegram",
        operation: "start.release_quota",
        userId,
        code: "quota_release_failed",
        retryable: true,
      });
    }
  }
}
