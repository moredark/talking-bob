import { Injectable, Logger } from "@nestjs/common";
import { Context, InlineKeyboard } from "grammy";
import { UserService } from "../../user";
import { ScheduleService } from "../../schedule";
import { AgentTone } from "../../ai";
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
  ) {}

  async handle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      return;
    }

    const user = await this.userService.findByTelegramId(BigInt(telegramId));

    if (!user) {
      await ctx.reply("Пожалуйста, начните с команды /start");
      return;
    }

    await this.showSettings(
      ctx,
      user.dailyPromptEnabled,
      user.announcementEnabled,
      user.dailyPromptHour,
      user.dailyPromptMinute,
      user.timezone,
      this.normalizeTone(user.agentTone),
    );
  }

  async handleToggle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      return;
    }

    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) return;

    const updated = user.dailyPromptEnabled
      ? await this.scheduleService.disableSchedule(user.id)
      : await this.scheduleService.enableSchedule(user.id);

    await this.editSettings(
      ctx,
      updated.dailyPromptEnabled,
      updated.announcementEnabled,
      updated.dailyPromptHour,
      updated.dailyPromptMinute,
      updated.timezone,
      this.normalizeTone(updated.agentTone),
    );
  }

  async handleAnnouncementToggle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) return;
    const updated = await this.userService.updateAnnouncementEnabled(
      user.id,
      !user.announcementEnabled,
    );
    await this.editSettings(
      ctx,
      updated.dailyPromptEnabled,
      updated.announcementEnabled,
      updated.dailyPromptHour,
      updated.dailyPromptMinute,
      updated.timezone,
      this.normalizeTone(updated.agentTone),
    );
  }

  async handleTimeSelect(ctx: Context, data: string): Promise<void> {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      return;
    }

    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) return;

    const match = /^set_time_(\d{1,2})_(\d{1,2})$/.exec(data);
    if (!match) {
      this.logger.warn("Rejected malformed schedule callback");
      return;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    try {
      validateScheduleTime(hour, minute);
    } catch {
      this.logger.warn("Rejected invalid schedule time");
      return;
    }

    const updated = await this.scheduleService.initializeSchedule(
      user.id,
      hour,
      minute,
      user.timezone,
    );

    await this.editSettings(
      ctx,
      updated.dailyPromptEnabled,
      updated.announcementEnabled,
      updated.dailyPromptHour,
      updated.dailyPromptMinute,
      updated.timezone,
      this.normalizeTone(updated.agentTone),
    );
  }

  async handleToneSelect(ctx: Context, data: string): Promise<void> {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      return;
    }

    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) return;

    const toneRaw = data.replace("set_tone_", "");
    const tone: AgentTone = toneRaw === "playful" ? "playful" : "friendly";

    await this.userService.updateAgentTone(user.id, tone);

    const updated = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!updated) return;

    await this.editSettings(
      ctx,
      updated.dailyPromptEnabled,
      updated.announcementEnabled,
      updated.dailyPromptHour,
      updated.dailyPromptMinute,
      updated.timezone,
      this.normalizeTone(updated.agentTone),
    );
  }

  private async showSettings(
    ctx: Context,
    enabled: boolean,
    announcementsEnabled: boolean,
    hour: number,
    minute: number,
    timezone: string,
    tone: AgentTone,
  ): Promise<void> {
    const text = this.formatSettingsText(enabled, announcementsEnabled, hour, minute, timezone, tone);
    const keyboard = this.buildKeyboard(enabled, announcementsEnabled, tone);
    await ctx.reply(text, { reply_markup: keyboard, parse_mode: "HTML" });
  }

  private async editSettings(
    ctx: Context,
    enabled: boolean,
    announcementsEnabled: boolean,
    hour: number,
    minute: number,
    timezone: string,
    tone: AgentTone,
  ): Promise<void> {
    const text = this.formatSettingsText(enabled, announcementsEnabled, hour, minute, timezone, tone);
    const keyboard = this.buildKeyboard(enabled, announcementsEnabled, tone);

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: "HTML" });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard, parse_mode: "HTML" });
    }
  }

  private formatSettingsText(
    enabled: boolean,
    announcementsEnabled: boolean,
    hour: number,
    minute: number,
    timezone: string,
    tone: AgentTone,
  ): string {
    const status = enabled ? "включена" : "выключена";
    const announcementStatus = announcementsEnabled ? "включены" : "выключены";
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const toneLabel =
      tone === "playful"
        ? "Шутливый/дерзкий (сленг и неформальная речь ок)"
        : "Дружелюбный учитель";

    return (
      `<b>Настройки</b>\n\n` +
      `Рассылка: <b>${status}</b>\n` +
      `Анонсы: <b>${announcementStatus}</b>\n` +
      `Время (${resolveEffectiveTimeZone(timezone).timeZone}): <b>${time}</b>\n` +
      `Тон агента: <b>${toneLabel}</b>`
    );
  }

  private buildKeyboard(enabled: boolean, announcementsEnabled: boolean, tone: AgentTone): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    keyboard.text(
      enabled ? "🔕 Выключить" : "🔔 Включить",
      "toggle_daily",
    );
    keyboard.row();
    keyboard.text(
      announcementsEnabled ? "🔕 Отключить анонсы" : "📣 Включить анонсы",
      "toggle_announcements",
    );
    keyboard.row();

    for (let i = 0; i < TIME_OPTIONS.length; i++) {
      const opt = TIME_OPTIONS[i];
      keyboard.text(opt.label, `set_time_${opt.hour}_${opt.minute}`);
      if (i % 3 === 2) keyboard.row();
    }

    keyboard.row();
    keyboard.text(
      tone === "friendly" ? "✅ Дружелюбный" : "🙂 Дружелюбный",
      "set_tone_friendly",
    );
    keyboard.text(
      tone === "playful" ? "✅ Шутливый" : "😈 Шутливый",
      "set_tone_playful",
    );

    return keyboard;
  }

  private normalizeTone(tone: string | null | undefined): AgentTone {
    return tone === "playful" ? "playful" : "friendly";
  }
}
