import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { Context, InlineKeyboard } from "grammy";
import { AgentTone } from "../../ai";
import { ScheduleService } from "../../schedule";
import { StreakService, StreakStatus } from "../../streak";
import { UserService } from "../../user";
import {
  resolveEffectiveTimeZone,
  validateScheduleTime,
} from "../../../shared/time";

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
    const updated = await this.userService.updateAnnouncementEnabled(
      user.id,
      !user.announcementEnabled,
    );
    await this.editSettings(ctx, updated);
  }

  async handleTimeSelect(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    const time = this.parseTime(data, /^set_time_(\d{1,2})_(\d{1,2})$/);
    if (!time) return;
    const updated = await this.scheduleService.initializeSchedule(
      user.id,
      time.hour,
      time.minute,
      user.timezone,
    );
    await this.editSettings(ctx, updated);
  }

  async handleStreakReminderToggle(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    const updated = await this.streakService.updateReminderEnabled(
      user.id,
      !user.streakReminderEnabled,
    );
    await this.editSettings(ctx, updated);
  }

  async handleStreakReminderTimeSelect(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    const time = this.parseTime(
      data,
      /^set_streak_time_(\d{1,2})_(\d{1,2})$/,
    );
    if (!time) return;
    const updated = await this.streakService.updateReminderTime(
      user.id,
      time.hour,
      time.minute,
    );
    await this.editSettings(ctx, updated);
  }

  async handleToneSelect(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return;
    const tone: AgentTone =
      data.replace("set_tone_", "") === "playful" ? "playful" : "friendly";
    const updated = await this.userService.updateAgentTone(user.id, tone);
    await this.editSettings(ctx, updated);
  }

  private async showSettings(ctx: Context, user: User): Promise<void> {
    const status = await this.streakService.getStatus(user.id);
    await ctx.reply(this.formatSettingsText(user, status), {
      reply_markup: this.buildKeyboard(user),
      parse_mode: "HTML",
    });
  }

  private async editSettings(ctx: Context, user: User): Promise<void> {
    const status = await this.streakService.getStatus(user.id);
    const options = {
      reply_markup: this.buildKeyboard(user),
      parse_mode: "HTML" as const,
    };
    try {
      await ctx.editMessageText(this.formatSettingsText(user, status), options);
    } catch {
      await ctx.reply(this.formatSettingsText(user, status), options);
    }
  }

  private formatSettingsText(user: User, streak: StreakStatus | null): string {
    const timezone = resolveEffectiveTimeZone(user.timezone).timeZone;
    const dailyTime = this.formatTime(user.dailyPromptHour, user.dailyPromptMinute);
    const reminderTime = this.formatTime(
      user.streakReminderHour,
      user.streakReminderMinute,
    );
    const toneLabel =
      this.normalizeTone(user.agentTone) === "playful"
        ? "Шутливый/дерзкий (сленг и неформальная речь ок)"
        : "Дружелюбный учитель";
    return (
      "<b>Настройки</b>\n\n" +
      `Рассылка: <b>${user.dailyPromptEnabled ? "включена" : "выключена"}</b>\n` +
      `Анонсы: <b>${user.announcementEnabled ? "включены" : "выключены"}</b>\n` +
      `Время (${timezone}): <b>${dailyTime}</b>\n` +
      `Тон агента: <b>${toneLabel}</b>\n\n` +
      `🔥 Текущий стрик: <b>${streak?.currentStreak ?? 0}</b>\n` +
      `🏆 Лучший стрик: <b>${streak?.longestStreak ?? user.longestStreak}</b>\n` +
      `Напоминания о стрике: <b>${user.streakReminderEnabled ? "включены" : "выключены"}</b>\n` +
      `Время напоминания: <b>${reminderTime}</b>`
    );
  }

  private buildKeyboard(user: User): InlineKeyboard {
    const keyboard = new InlineKeyboard()
      .text(user.dailyPromptEnabled ? "🔕 Выключить" : "🔔 Включить", "toggle_daily")
      .row()
      .text(
        user.announcementEnabled ? "🔕 Отключить анонсы" : "📣 Включить анонсы",
        "toggle_announcements",
      )
      .row();
    this.addTimeRows(keyboard, "set_time");
    keyboard
      .row()
      .text(
        user.streakReminderEnabled
          ? "🔥 Отключить напоминания"
          : "🔥 Включить напоминания",
        "toggle_streak_reminder",
      )
      .row();
    this.addTimeRows(keyboard, "set_streak_time");
    keyboard
      .row()
      .text(
        this.normalizeTone(user.agentTone) === "friendly"
          ? "✅ Дружелюбный"
          : "🙂 Дружелюбный",
        "set_tone_friendly",
      )
      .text(
        this.normalizeTone(user.agentTone) === "playful"
          ? "✅ Шутливый"
          : "😈 Шутливый",
        "set_tone_playful",
      );
    return keyboard;
  }

  private addTimeRows(keyboard: InlineKeyboard, prefix: string): void {
    for (let index = 0; index < TIME_OPTIONS.length; index += 1) {
      const option = TIME_OPTIONS[index];
      keyboard.text(
        option.label,
        `${prefix}_${option.hour}_${option.minute}`,
      );
      if (index % 3 === 2 && index < TIME_OPTIONS.length - 1) keyboard.row();
    }
  }

  private async userFromContext(ctx: Context): Promise<User | null> {
    return ctx.from?.id
      ? this.userService.findByTelegramId(BigInt(ctx.from.id))
      : null;
  }

  private parseTime(
    data: string,
    pattern: RegExp,
  ): { hour: number; minute: number } | null {
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

  private normalizeTone(tone: string | null | undefined): AgentTone {
    return tone === "playful" ? "playful" : "friendly";
  }
}
