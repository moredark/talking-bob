import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { Bot, Context } from "grammy";
import { StartHandler } from "./handlers/start.handler";
import { VoiceHandler } from "./handlers/voice.handler";
import { ReportHandler } from "./handlers/report.handler";
import { SettingsHandler } from "./handlers/settings.handler";

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Bot;

  constructor(
    private readonly startHandler: StartHandler,
    private readonly voiceHandler: VoiceHandler,
    private readonly reportHandler: ReportHandler,
    private readonly settingsHandler: SettingsHandler,
  ) {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN is not defined");
    }

    this.bot = new Bot(token);
  }

  async onModuleInit() {
    this.registerHandlers();
    await this.startBot();
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

    this.bot.catch((err) => {
      this.logger.error("Bot error:", err);
    });
  }

  private async startBot() {
    this.logger.log("Starting Telegram bot...");

    await this.bot.api.setMyCommands([
      { command: "start", description: "Начать / Новый вопрос" },
      { command: "report", description: "Получить отчёт по разговору" },
      { command: "settings", description: "Настройки ежедневного вопроса" },
    ]);

    this.bot.start();
    this.logger.log("Telegram bot started");
  }

  getBot(): Bot {
    return this.bot;
  }
}
