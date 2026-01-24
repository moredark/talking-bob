import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { TelegramService } from "./telegram.service";
import { UserService } from "../user";
import { PromptService } from "../prompt";

const MOSCOW_UTC_OFFSET = 3;
const CHECK_INTERVAL_MS = 60_000;

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private interval: NodeJS.Timeout | null = null;
  private lastCheckedMinute = -1;

  constructor(
    private readonly telegramService: TelegramService,
    private readonly userService: UserService,
    private readonly promptService: PromptService,
  ) {}

  onModuleInit() {
    this.logger.log("Daily prompt scheduler started");
    this.interval = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error("Scheduler tick error:", err);
      });
    }, CHECK_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const moscowHour = (now.getUTCHours() + MOSCOW_UTC_OFFSET) % 24;
    const moscowMinute = now.getUTCMinutes();

    const currentMinuteKey = moscowHour * 60 + moscowMinute;
    if (currentMinuteKey === this.lastCheckedMinute) {
      return;
    }
    this.lastCheckedMinute = currentMinuteKey;

    const users = await this.userService.getUsersForDailyPrompt(moscowHour, moscowMinute);

    if (users.length === 0) {
      return;
    }

    this.logger.log(
      `Sending daily prompts to ${users.length} users at ${moscowHour}:${String(moscowMinute).padStart(2, "0")} MSK`,
    );

    const bot = this.telegramService.getBot();
    let sent = 0;

    for (const user of users) {
      try {
        const lastPrompt = await this.promptService.getLatestUserPrompt(user.id);

        if (lastPrompt && this.isSameDay(lastPrompt.sentAt, now)) {
          continue;
        }

        const prompt = await this.promptService.getRandomActivePrompt();
        if (!prompt) {
          this.logger.warn("No active prompts available");
          return;
        }

        await this.promptService.recordPromptSent(user.id, prompt.id);

        const chatId = Number(user.telegramId);

        try {
          await bot.api.sendVoice(chatId, prompt.audioFileId, {
            caption: `🎤 Тема дня: ${prompt.topic}\n\nПрослушай и ответь голосовым сообщением.`,
          });
        } catch {
          await bot.api.sendMessage(
            chatId,
            `🎤 Тема дня: ${prompt.topic}\n\nОтветь голосовым сообщением на английском.`,
          );
        }

        sent++;
      } catch (error) {
        this.logger.warn(`Failed to send prompt to user ${user.id}: ${error}`);
      }
    }

    if (sent > 0) {
      this.logger.log(`Daily prompts sent to ${sent} users`);
    }
  }

  private isSameDay(date: Date, now: Date): boolean {
    const moscowOffset = MOSCOW_UTC_OFFSET * 60 * 60 * 1000;
    const dateMoscow = new Date(date.getTime() + moscowOffset);
    const nowMoscow = new Date(now.getTime() + moscowOffset);

    return (
      dateMoscow.getUTCFullYear() === nowMoscow.getUTCFullYear() &&
      dateMoscow.getUTCMonth() === nowMoscow.getUTCMonth() &&
      dateMoscow.getUTCDate() === nowMoscow.getUTCDate()
    );
  }
}
