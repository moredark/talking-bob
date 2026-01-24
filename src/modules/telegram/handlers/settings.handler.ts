import { Injectable, Logger } from "@nestjs/common";
import { Context, InlineKeyboard } from "grammy";
import { UserService } from "../../user";

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

  constructor(private readonly userService: UserService) {}

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

    await this.showSettings(ctx, user.dailyPromptEnabled, user.dailyPromptHour, user.dailyPromptMinute);
  }

  async handleToggle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      return;
    }

    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) return;

    const updated = await this.userService.updateDailyPromptSettings(user.id, {
      dailyPromptEnabled: !user.dailyPromptEnabled,
    });

    await this.editSettings(ctx, updated.dailyPromptEnabled, updated.dailyPromptHour, updated.dailyPromptMinute);
  }

  async handleTimeSelect(ctx: Context, data: string): Promise<void> {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      return;
    }

    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) return;

    const [hourStr, minuteStr] = data.replace("set_time_", "").split("_");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    const updated = await this.userService.updateDailyPromptSettings(user.id, {
      dailyPromptHour: hour,
      dailyPromptMinute: minute,
    });

    await this.editSettings(ctx, updated.dailyPromptEnabled, updated.dailyPromptHour, updated.dailyPromptMinute);
  }

  private async showSettings(
    ctx: Context,
    enabled: boolean,
    hour: number,
    minute: number,
  ): Promise<void> {
    const text = this.formatSettingsText(enabled, hour, minute);
    const keyboard = this.buildKeyboard(enabled);
    await ctx.reply(text, { reply_markup: keyboard, parse_mode: "HTML" });
  }

  private async editSettings(
    ctx: Context,
    enabled: boolean,
    hour: number,
    minute: number,
  ): Promise<void> {
    const text = this.formatSettingsText(enabled, hour, minute);
    const keyboard = this.buildKeyboard(enabled);

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: "HTML" });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard, parse_mode: "HTML" });
    }
  }

  private formatSettingsText(enabled: boolean, hour: number, minute: number): string {
    const status = enabled ? "включена" : "выключена";
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

    return (
      `<b>Настройки ежедневного вопроса</b>\n\n` +
      `Рассылка: <b>${status}</b>\n` +
      `Время (МСК): <b>${time}</b>`
    );
  }

  private buildKeyboard(enabled: boolean): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    keyboard.text(
      enabled ? "🔕 Выключить" : "🔔 Включить",
      "toggle_daily",
    );
    keyboard.row();

    for (let i = 0; i < TIME_OPTIONS.length; i++) {
      const opt = TIME_OPTIONS[i];
      keyboard.text(opt.label, `set_time_${opt.hour}_${opt.minute}`);
      if (i % 3 === 2) keyboard.row();
    }

    return keyboard;
  }
}
