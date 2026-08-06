import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { Bot, Context } from "grammy";
import { StartHandler } from "./handlers/start.handler";
import { VoiceHandler } from "./handlers/voice.handler";
import { ReportHandler } from "./handlers/report.handler";
import { SettingsHandler } from "./handlers/settings.handler";
import { DailyPromptDispatcher } from "../schedule";

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botStartRetryMs = 30_000;
  private botStartRetryTimer?: NodeJS.Timeout;
  private bot: Bot;

  constructor(
    private readonly startHandler: StartHandler,
    private readonly voiceHandler: VoiceHandler,
    private readonly reportHandler: ReportHandler,
    private readonly settingsHandler: SettingsHandler,
    private readonly dailyPromptDispatcher: DailyPromptDispatcher,
  ) {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN is not defined");
    }

    this.bot = new Bot(token);
  }

  async onModuleInit() {
    this.registerHandlers();
    this.dailyPromptDispatcher.setBot(this.bot);
    void this.startBot();
  }

  private registerHandlers() {
    this.bot.command("start", (ctx) => this.startHandler.handle(ctx));
    this.bot.command("report", (ctx) => this.reportHandler.handle(ctx));
    this.bot.command("settings", (ctx) => this.settingsHandler.handle(ctx));

    this.bot.on("message:voice", (ctx) => this.voiceHandler.handle(ctx));

    this.bot.callbackQuery("report", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.reportHandler.handle(ctx);
    });

    this.bot.callbackQuery("new_question", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.startHandler.handle(ctx);
    });

    this.bot.callbackQuery("toggle_daily", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.settingsHandler.handleToggle(ctx);
    });

    this.bot.callbackQuery(/^set_time_\d+_\d+$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.settingsHandler.handleTimeSelect(ctx, ctx.callbackQuery.data);
    });

    this.bot.callbackQuery(/^set_tone_(friendly|playful)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.settingsHandler.handleToneSelect(ctx, ctx.callbackQuery.data);
    });

    this.bot.catch((err) => {
      this.logger.error("Bot error:", err);
    });
  }

  private async startBot() {
    if (this.bot.isRunning()) {
      return;
    }

    this.logger.log("Starting Telegram bot...");

    try {
      await this.bot.api.setMyCommands([
        { command: "start", description: "Начать / Новый вопрос" },
        { command: "report", description: "Получить отчёт по разговору" },
        { command: "settings", description: "Настройки ежедневного вопроса" },
      ]);

      void this.bot
        .start({
          onStart: () => this.logger.log("Telegram bot started"),
        })
        .catch((error) => {
          this.logger.error(
            "Telegram bot stopped with an error",
            this.formatError(error),
          );
          this.scheduleBotRestart();
        });
    } catch (error) {
      this.logger.error(
        `Telegram bot startup failed; retrying in ${this.botStartRetryMs / 1000}s`,
        this.formatError(error),
      );
      this.scheduleBotRestart();
    }
  }

  getBot(): Bot {
    return this.bot;
  }

  private scheduleBotRestart() {
    if (this.botStartRetryTimer || this.bot.isRunning()) {
      return;
    }

    this.botStartRetryTimer = setTimeout(() => {
      this.botStartRetryTimer = undefined;
      void this.startBot();
    }, this.botStartRetryMs);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack || error.message;
    }

    return String(error);
  }
}
