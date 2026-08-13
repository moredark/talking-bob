import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  createConcurrentSink,
  createRunner,
  createSource,
  createUpdateFetcher,
  RunnerHandle,
  sequentialize,
} from "@grammyjs/runner";
import { Bot, Context, type BotError } from "grammy";
import { RUNTIME_CONFIG } from "../../config/runtime-config.module";
import { RuntimeConfig } from "../../config/runtime.config";
import {
  AiRequestLimiterClosedError,
  AiRequestLimiterService,
} from "../ai";
import { DailyPromptDispatcher } from "../schedule";
import { BroadcastDispatcher } from "../broadcast";
import { StreakReminderDispatcher } from "../streak";
import { ErrorLogService, ObservabilityContextService } from "../error-log";
import { ReportHandler } from "./handlers/report.handler";
import { SettingsHandler } from "./handlers/settings.handler";
import { StartHandler } from "./handlers/start.handler";
import { VoiceHandler } from "./handlers/voice.handler";

class TelegramRuntimeClosedError extends Error {
  constructor() {
    super("Telegram API call rejected after the runtime shutdown deadline");
    this.name = "TelegramRuntimeClosedError";
  }
}

type TelegramUpdate = Parameters<Bot["handleUpdate"]>[0];

export type TelegramLifecycleState =
  | "starting"
  | "running"
  | "restart_wait"
  | "shutting_down"
  | "stopped";

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botStartRetryMs = 30_000;
  private readonly bot: Bot;
  private readonly callbackAcknowledgements = new Set<Promise<unknown>>();
  private readonly telegramBusinessTasks = new Set<Promise<void>>();
  private runner?: RunnerHandle;
  private runnerTask?: Promise<void>;
  private startupPromise?: Promise<void>;
  private botStartRetryTimer?: NodeJS.Timeout;
  private restartAttempted = false;
  private shuttingDown = false;
  private telegramApiClosed = false;
  private shutdownDeadline?: number;
  private lifecycleState: TelegramLifecycleState = "starting";

  constructor(
    private readonly startHandler: StartHandler,
    private readonly voiceHandler: VoiceHandler,
    private readonly reportHandler: ReportHandler,
    private readonly settingsHandler: SettingsHandler,
    private readonly dailyPromptDispatcher: DailyPromptDispatcher,
    private readonly streakReminderDispatcher: StreakReminderDispatcher,
    @Inject(RUNTIME_CONFIG) private readonly runtimeConfig: RuntimeConfig,
    @Optional() private readonly aiRequestLimiter?: AiRequestLimiterService,
    private readonly errorLog?: ErrorLogService,
    private readonly observability?: ObservabilityContextService,
    @Optional() private readonly broadcastDispatcher?: BroadcastDispatcher,
  ) {
    this.bot = new Bot(runtimeConfig.telegramBotToken, {
      client: {
        apiRoot: "https://api.telegram.org",
        timeoutSeconds: runtimeConfig.telegram.apiTimeoutMs / 1000,
      },
    });
    this.bot.api.config.use((previous, method, payload, signal) => {
      if (this.isTelegramApiClosed()) {
        return Promise.reject(new TelegramRuntimeClosedError());
      }
      return previous(method, payload, signal);
    });
  }

  onModuleInit(): void {
    this.registerHandlers();
    this.dailyPromptDispatcher.setBot(this.bot);
    this.streakReminderDispatcher.setBot(this.bot);
    this.broadcastDispatcher?.setSender({
      sendPlainText: async (telegramId, content, signal) => {
        await this.bot.api.sendMessage(telegramId.toString(), content, undefined, signal);
      },
    });
    this.startRunner();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.lifecycleState = "shutting_down";
    const deadline = Date.now() + this.runtimeConfig.shutdown.drainTimeoutMs;
    this.shutdownDeadline = deadline;
    this.aiRequestLimiter?.close();
    this.broadcastDispatcher?.stopAdmission(deadline);

    if (this.botStartRetryTimer) {
      clearTimeout(this.botStartRetryTimer);
      this.botStartRetryTimer = undefined;
    }

    const shutdownWork = Promise.allSettled([
      this.stopRunner(),
      this.drainTelegramBusinessTasks(),
      this.drainCallbackAcknowledgements(),
      this.aiRequestLimiter?.drain() ?? Promise.resolve(),
      this.broadcastDispatcher?.drain() ?? Promise.resolve(),
    ]).then(() => undefined);

    const drained = await this.waitUntilDeadline(shutdownWork, deadline);
    await this.broadcastDispatcher?.finishShutdown(drained);
    this.telegramApiClosed = true;
    if (!drained) {
      this.logger.warn(
        `Runtime drain timed out with ${this.runner?.size() ?? 0} Telegram updates, ${this.telegramBusinessTasks.size} Telegram business tasks, ${this.callbackAcknowledgements.size} callback acknowledgements, ${this.aiRequestLimiter?.active ?? 0} active AI requests, and ${this.aiRequestLimiter?.pending ?? 0} pending AI requests`,
      );
    }
    this.lifecycleState = "stopped";
  }

  getBot(): Bot {
    return this.bot;
  }

  getLifecycleState(): TelegramLifecycleState {
    return this.lifecycleState;
  }

  private registerHandlers(): void {
    // This outer middleware is the service lifecycle boundary. It rejects
    // admission after shutdown starts and observes every accepted update until
    // all downstream business middleware has settled.
    this.bot.use((ctx, next) => this.trackTelegramBusinessTask(ctx, next));
    // Callback acknowledgements must begin before sequentialize can wait on a
    // previous update for the same chat.
    this.bot.use((ctx, next) => {
      if (ctx.callbackQuery) this.trackCallbackAcknowledgement(ctx);
      return next();
    });
    this.bot.use(sequentialize((ctx) => this.updateKey(ctx)));

    this.bot.command("start", (ctx) => this.startHandler.handle(ctx));
    this.bot.command("report", (ctx) => this.reportHandler.handle(ctx));
    this.bot.command("settings", (ctx) => this.settingsHandler.handle(ctx));
    this.bot.on("message:voice", (ctx) => this.voiceHandler.handle(ctx));

    this.bot.callbackQuery("report", (ctx) => this.reportHandler.handle(ctx));
    this.bot.callbackQuery("new_question", (ctx) =>
      this.startHandler.handleNewQuestion(ctx),
    );
    this.bot.callbackQuery("toggle_daily", (ctx) =>
      this.settingsHandler.handleToggle(ctx),
    );
    this.bot.callbackQuery("toggle_announcements", (ctx) =>
      this.settingsHandler.handleAnnouncementToggle(ctx),
    );
    this.bot.callbackQuery(/^set_time_\d+_\d+$/, (ctx) =>
      this.settingsHandler.handleTimeSelect(ctx, ctx.callbackQuery.data),
    );
    this.bot.callbackQuery("toggle_streak_reminder", (ctx) =>
      this.settingsHandler.handleStreakReminderToggle(ctx),
    );
    this.bot.callbackQuery(/^set_streak_time_\d+_\d+$/, (ctx) =>
      this.settingsHandler.handleStreakReminderTimeSelect(
        ctx,
        ctx.callbackQuery.data,
      ),
    );
    this.bot.callbackQuery(/^set_tone_([a-z0-9][a-z0-9_-]{0,31})$/, (ctx) =>
      this.settingsHandler.handleToneSelect(ctx, ctx.callbackQuery.data),
    );

    this.bot.catch((error) => {
      this.logger.error(
        `Telegram middleware failed (${this.errorKind(error.error)})`,
      );
      void this.errorLog?.capture({
        type: "telegram",
        service: "telegram",
        operation: "update.handle",
        error: error.error,
        retryable: false,
      });
    });
  }

  private trackTelegramBusinessTask(
    ctx: Context,
    next: () => void | Promise<void>,
  ): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    const correlationId = this.observability?.createCorrelationId("tg") ??
      `tg-update-${ctx.update.update_id}`;
    const downstream = Promise.resolve(
      this.observability
        ? this.observability.run(
            {
              correlationId,
              telegramUpdateId: String(ctx.update.update_id),
              requestId: `update:${ctx.update.update_id}`,
            },
            next,
          )
        : next(),
    );
    let tracked!: Promise<void>;
    tracked = downstream.finally(() => {
      this.telegramBusinessTasks.delete(tracked);
    });
    this.telegramBusinessTasks.add(tracked);
    return tracked;
  }

  private trackCallbackAcknowledgement(ctx: Context): void {
    const acknowledgement = ctx.answerCallbackQuery();
    this.callbackAcknowledgements.add(acknowledgement);
    void acknowledgement
      .catch((error: unknown) => {
        this.logger.warn(
          `Telegram callback acknowledgement failed for update ${ctx.update.update_id} (${this.errorKind(error)})`,
        );
        void this.errorLog?.capture({
          type: "telegram",
          service: "telegram",
          operation: "callback.acknowledge",
          telegramUpdateId: ctx.update.update_id,
          error,
          retryable: true,
        });
      })
      .finally(() => {
        this.callbackAcknowledgements.delete(acknowledgement);
      });
  }

  private updateKey(ctx: Context): string {
    if (ctx.chat) return `chat:${ctx.chat.id}`;
    if (ctx.from) return `user:${ctx.from.id}`;
    return `update:${ctx.update.update_id}`;
  }

  private startRunner(): void {
    if (this.shuttingDown || this.startupPromise || this.runner?.isRunning()) {
      return;
    }

    this.logger.log("Starting Telegram bot...");
    this.lifecycleState = "starting";
    const startupPromise = this.launchRunner();
    this.startupPromise = startupPromise;
    void startupPromise
      .catch((error: unknown) => {
        this.logger.error(
          `Telegram runner failed to start (${this.errorKind(error)})`,
        );
        void this.errorLog?.capture({
          type: "telegram",
          service: "telegram",
          operation: "runner.start",
          error,
          retryable: true,
        });
        this.scheduleRunnerRestart();
      })
      .finally(() => {
        if (this.startupPromise === startupPromise) {
          this.startupPromise = undefined;
        }
      });
  }

  private async launchRunner(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: "start", description: "Начать / Новый вопрос" },
      { command: "report", description: "Получить отчёт по разговору" },
      { command: "settings", description: "Настройки ежедневного вопроса" },
    ]);
    if (this.shuttingDown) return;

    await this.bot.init();
    if (this.shuttingDown) return;

    const concurrency = this.runtimeConfig.concurrency.telegramUpdates;
    const fetchUpdates = createUpdateFetcher(this.bot, {
      fetch: { allowed_updates: ["message", "callback_query"] },
    });
    const source = createSource<TelegramUpdate>({ supply: fetchUpdates });
    // runner@2.0.3 starts a source at Infinity. Set the initial pace before
    // start so even the first Telegram batch respects the hard admission cap.
    source.setGeneratorPace(concurrency);
    const sink = createConcurrentSink<TelegramUpdate, BotError<Context>>(
      { consume: (update) => this.bot.handleUpdate(update) },
      async (error) => {
        await this.bot.errorHandler(error);
      },
      { concurrency },
    );
    const runner = createRunner(source, sink);
    runner.start();
    this.runner = runner;
    this.lifecycleState = "running";
    this.logger.log("Telegram bot started");

    const task = runner.task();
    if (!task) return;
    this.runnerTask = task;
    void task
      .catch((error: unknown) => {
        this.logger.error(
          `Telegram runner stopped (${this.errorKind(error)})`,
        );
        void this.errorLog?.capture({
          type: "telegram",
          service: "telegram",
          operation: "runner.run",
          error,
          retryable: true,
        });
      })
      .finally(() => {
        if (this.runner === runner) this.runner = undefined;
        if (this.runnerTask === task) this.runnerTask = undefined;
        this.scheduleRunnerRestart();
      });
  }

  private scheduleRunnerRestart(): void {
    if (
      this.shuttingDown ||
      this.botStartRetryTimer ||
      this.runner?.isRunning()
    ) {
      return;
    }

    if (this.restartAttempted) {
      this.lifecycleState = "stopped";
      this.logger.error(
        "Telegram runner exhausted its restart budget; requesting shutdown",
      );
      process.kill(process.pid, "SIGTERM");
      return;
    }

    this.restartAttempted = true;
    this.lifecycleState = "restart_wait";
    this.logger.warn(
      `Restarting Telegram runner in ${this.botStartRetryMs / 1000}s`,
    );
    this.botStartRetryTimer = setTimeout(() => {
      this.botStartRetryTimer = undefined;
      this.startRunner();
    }, this.botStartRetryMs);
  }

  private async stopRunner(): Promise<void> {
    await this.startupPromise?.catch(() => undefined);
    const runner = this.runner;
    if (!runner) return;

    const stop = runner.stop().catch((error: unknown) => {
      this.logger.error(
        `Telegram runner stop failed (${this.errorKind(error)})`,
      );
    });
    const task = this.runnerTask ?? runner.task();
    await Promise.allSettled(task ? [stop, task] : [stop]);
  }

  private async drainCallbackAcknowledgements(): Promise<void> {
    while (this.callbackAcknowledgements.size > 0) {
      await Promise.allSettled([...this.callbackAcknowledgements]);
    }
  }

  private async drainTelegramBusinessTasks(): Promise<void> {
    while (this.telegramBusinessTasks.size > 0) {
      await Promise.allSettled([...this.telegramBusinessTasks]);
    }
  }

  private waitUntilDeadline(
    work: Promise<void>,
    deadline: number,
  ): Promise<boolean> {
    const remainingMs = Math.max(0, deadline - Date.now());
    let timeout: NodeJS.Timeout | undefined;
    return Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          this.telegramApiClosed = true;
          this.aiRequestLimiter?.abort(
            new AiRequestLimiterClosedError(
              "AI request aborted at shutdown deadline",
            ),
          );
          resolve(false);
        }, remainingMs);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private isTelegramApiClosed(): boolean {
    if (this.telegramApiClosed) return true;
    if (
      this.shutdownDeadline !== undefined &&
      Date.now() >= this.shutdownDeadline
    ) {
      this.telegramApiClosed = true;
      return true;
    }
    return false;
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }
}
