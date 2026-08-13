import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { Context, InlineKeyboard } from "grammy";
import { ActiveAgentPersonality, PersonalityService } from "../../personality";
import { ScheduleService } from "../../schedule";
import { StreakService, StreakStatus } from "../../streak";
import { UserService } from "../../user";
import { resolveEffectiveTimeZone, validateScheduleTime } from "../../../shared/time";

const TIME_OPTIONS = [
  { label: "09:00", hour: 9, minute: 0 },
  { label: "12:00", hour: 12, minute: 0 },
  { label: "13:00", hour: 13, minute: 0 },
  { label: "15:00", hour: 15, minute: 0 },
  { label: "18:00", hour: 18, minute: 0 },
  { label: "21:00", hour: 21, minute: 0 },
];

@Injectable()
export class SettingsHandler {
  private readonly logger = new Logger(SettingsHandler.name);

  constructor(
    private readonly userService: UserService,
    private readonly scheduleService: ScheduleService,
    private readonly streakService: StreakService,
    private readonly personalityService?: PersonalityService,
  ) {}

  async handle(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) {
      if (ctx.from?.id) await ctx.reply("Пожалуйста, начните с команды /start");
      return;
    }
    await this.showSettings(ctx, user);
  }

  async handleToggle(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    const updated = user.dailyPromptEnabled
      ? await this.scheduleService.disableSchedule(user.id)
      : await this.scheduleService.enableSchedule(user.id);
    await this.editSettings(ctx, updated);
  }

  async handleAnnouncementToggle(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    await this.editSettings(ctx, await this.userService.updateAnnouncementEnabled(user.id, !user.announcementEnabled));
  }

  async handleTimeSelect(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    const time = this.parseTime(data, /^set_time_(\d{1,2})_(\d{1,2})$/);
    if (!time) return;
    await this.editSettings(ctx, await this.scheduleService.initializeSchedule(user.id, time.hour, time.minute, user.timezone));
  }

  async handleStreakReminderToggle(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    await this.editSettings(ctx, await this.streakService.updateReminderEnabled(user.id, !user.streakReminderEnabled));
  }

  async handleStreakReminderTimeSelect(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    const time = this.parseTime(data, /^set_streak_time_(\d{1,2})_(\d{1,2})$/);
    if (!time) return;
    await this.editSettings(ctx, await this.streakService.updateReminderTime(user.id, time.hour, time.minute));
  }

  async handleToneSelect(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user || !this.personalityService) return;
    const key = data.slice("set_tone_".length);
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) return;
    try {
      await this.editSettings(ctx, await this.personalityService.selectForUser(user.id, key));
    } catch {
      await ctx.reply("Эта личность сейчас недоступна. Откройте настройки ещё раз.");
    }
  }

  private async showSettings(ctx: Context, user: User): Promise<void> {
    const [status, personalities] = await Promise.all([this.streakService.getStatus(user.id), this.activePersonalities()]);
    await ctx.reply(this.formatSettingsText(user, status, personalities), {
      reply_markup: this.buildKeyboard(user, personalities),
      parse_mode: "HTML",
    });
  }

  private async editSettings(ctx: Context, user: User): Promise<void> {
    const [status, personalities] = await Promise.all([this.streakService.getStatus(user.id), this.activePersonalities()]);
    const text = this.formatSettingsText(user, status, personalities);
    const options = { reply_markup: this.buildKeyboard(user, personalities), parse_mode: "HTML" as const };
    try {
      await ctx.editMessageText(text, options);
    } catch {
      await ctx.reply(text, options);
    }
  }

  private formatSettingsText(user: User, streak: StreakStatus | null, personalities: ActiveAgentPersonality[]): string {
    const selected = personalities.find((item) => item.key === user.agentTone) ?? personalities.find((item) => item.isDefault);
    const timezone = resolveEffectiveTimeZone(user.timezone).timeZone;
    return "<b>Настройки</b>\n\n" +
      `Рассылка: <b>${user.dailyPromptEnabled ? "включена" : "выключена"}</b>\n` +
      `Анонсы: <b>${user.announcementEnabled ? "включены" : "выключены"}</b>\n` +
      `Время (${timezone}): <b>${this.formatTime(user.dailyPromptHour, user.dailyPromptMinute)}</b>\n` +
      `Тон агента: <b>${this.escapeHtml(selected?.name ?? "Недоступна")}</b>\n\n` +
      `🔥 Текущий стрик: <b>${streak?.currentStreak ?? 0}</b>\n` +
      `🏆 Лучший стрик: <b>${streak?.longestStreak ?? user.longestStreak}</b>\n` +
      `Напоминания о стрике: <b>${user.streakReminderEnabled ? "включены" : "выключены"}</b>\n` +
      `Время напоминания: <b>${this.formatTime(user.streakReminderHour, user.streakReminderMinute)}</b>`;
  }

  private buildKeyboard(user: User, personalities: ActiveAgentPersonality[]): InlineKeyboard {
    const keyboard = new InlineKeyboard()
      .text(user.dailyPromptEnabled ? "🔕 Выключить" : "🔔 Включить", "toggle_daily").row()
      .text(user.announcementEnabled ? "🔕 Отключить анонсы" : "📣 Включить анонсы", "toggle_announcements").row();
    this.addTimeRows(keyboard, "set_time");
    keyboard.row().text(user.streakReminderEnabled ? "🔥 Отключить напоминания" : "🔥 Включить напоминания", "toggle_streak_reminder").row();
    this.addTimeRows(keyboard, "set_streak_time");
    for (const personality of personalities) {
      keyboard.row().text(`${personality.key === user.agentTone ? "✅ " : ""}${personality.name}`.slice(0, 64), `set_tone_${personality.key}`);
    }
    return keyboard;
  }

  private addTimeRows(keyboard: InlineKeyboard, prefix: string): void {
    for (let index = 0; index < TIME_OPTIONS.length; index += 1) {
      const option = TIME_OPTIONS[index];
      keyboard.text(option.label, `${prefix}_${option.hour}_${option.minute}`);
      if (index % 3 === 2 && index < TIME_OPTIONS.length - 1) keyboard.row();
    }
  }

  private activePersonalities(): Promise<ActiveAgentPersonality[]> {
    return this.personalityService
      ? this.personalityService.listActive()
      : Promise.resolve([
          { key: "friendly", name: "Дружелюбный учитель", description: "", isDefault: true },
          { key: "playful", name: "Шутливый", description: "", isDefault: false },
        ]);
  }

  private userFromContext(ctx: Context): Promise<User | null> {
    return ctx.from?.id ? this.userService.findByTelegramId(BigInt(ctx.from.id)) : Promise.resolve(null);
  }

  private parseTime(data: string, pattern: RegExp): { hour: number; minute: number } | null {
    const match = pattern.exec(data);
    if (!match) {
      this.logger.warn("Rejected malformed schedule callback");
      return null;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    try {
      validateScheduleTime(hour, minute);
      return { hour, minute };
    } catch {
      this.logger.warn("Rejected invalid schedule time");
      return null;
    }
  }

  private formatTime(hour: number, minute: number): string {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}
