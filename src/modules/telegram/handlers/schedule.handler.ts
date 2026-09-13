import { Injectable } from "@nestjs/common";
import { User } from "@prisma/client";
import { Context, InlineKeyboard } from "grammy";
import { ScheduleService } from "../../schedule";
import { StreakService } from "../../streak";
import { UserService } from "../../user";
import { ALL_WEEKDAYS_MASK, resolveEffectiveTimeZone, validateScheduleTime } from "../../../shared/time";

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const DAY_BITS = DAYS.map((_, index) => 1 << index);
const VERSION = "v1";

@Injectable()
export class ScheduleHandler {
  private readonly timeInputs = new Map<string, number>();

  constructor(
    private readonly userService: UserService,
    private readonly scheduleService: ScheduleService,
    private readonly streakService: StreakService,
  ) {}

  async handle(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    this.cancelTimeInput(ctx);
    await this.show(ctx, user);
  }

  async handleTime(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const match = /^\/time(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/.exec((text ?? "").trim());
    const argument = match?.[1]?.trim();
    if (!match || !argument) {
      await this.openTimePicker(ctx);
      return;
    }
    await this.saveTime(ctx, user, argument);
  }

  cancelTimeInput(ctx: Context): void {
    const key = this.timeInputKey(ctx);
    if (key) this.timeInputs.delete(key);
  }

  async openTimePicker(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    const keyboard = new InlineKeyboard();
    for (const hour of [9, 13, 18]) {
      keyboard.text(String(hour).padStart(2, "0") + ":00", "schedule_time_v1_" + hour + "_0");
    }
    keyboard.row().text("К расписанию", "schedule_open");
    await this.edit(ctx, "<b>Время вопросов</b>\n\nСейчас: " + this.time(user) + " (" + resolveEffectiveTimeZone(user.timezone).timeZone + ").\nВыберите время или отправьте в чат своё в формате ЧЧ:ММ, например 08:45. Ввод доступен 10 минут.\nТакже можно использовать /time 08:45.", keyboard);
    const now = Date.now();
    for (const [key, expires] of this.timeInputs) {
      if (expires <= now) this.timeInputs.delete(key);
    }
    const key = this.timeInputKey(ctx);
    if (key) this.timeInputs.set(key, now + 10 * 60 * 1000);
  }

  async handleTimeText(ctx: Context): Promise<boolean> {
    const key = this.timeInputKey(ctx);
    const expires = key ? this.timeInputs.get(key) : undefined;
    if (!expires || expires <= Date.now()) {
      this.cancelTimeInput(ctx);
      return false;
    }
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text ?? "").trim() : "";
    if (!text || text.startsWith("/")) return false;
    const user = await this.userFromContext(ctx);
    if (!user) { this.cancelTimeInput(ctx); await this.requireStart(ctx); return true; }
    await this.saveTime(ctx, user, text);
    return true;
  }

  async handleTimeSelect(ctx: Context, data: string): Promise<void> {
    const match = /^schedule_time_v1_(9|13|18)_0$/.exec(data);
    if (!match) { await ctx.reply("Откройте /time и выберите время ещё раз."); return; }
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    await this.saveTime(ctx, user, match[1].padStart(2, "0") + ":00");
  }

  private timeInputKey(ctx: Context): string | null {
    return ctx.from?.id && ctx.chat?.type === "private" ? String(ctx.chat.id) + ":" + ctx.from.id : null;
  }

  private async saveTime(ctx: Context, user: User, argument: string): Promise<void> {
    if (!/^\d{2}:\d{2}$/.test(argument)) {
      await ctx.reply("Время должно быть в формате /time ЧЧ:ММ, например /time 08:45.");
      return;
    }
    const [hour, minute] = argument.split(":").map(Number);
    try {
      validateScheduleTime(hour, minute);
    } catch {
      await ctx.reply("Укажите время от 00:00 до 23:59 в формате /time ЧЧ:ММ.");
      return;
    }
    try {
      const updated = await this.scheduleService.updateScheduleSettings(user.id, { dailyPromptHour: hour, dailyPromptMinute: minute });
      this.cancelTimeInput(ctx);
      await ctx.reply(`Время сохранено: ${this.time(updated)} (${resolveEffectiveTimeZone(updated.timezone).timeZone}).`, {
        reply_markup: this.openKeyboard(updated),
      });
    } catch {
      await ctx.reply("Не удалось сохранить время. Откройте /schedule и попробуйте ещё раз.");
    }
  }

  async handleDays(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    const mask = this.parseDraftMask(data, `schedule_days_${VERSION}_`);
    if (mask === null) { await ctx.reply("Черновик расписания устарел. Откройте /schedule и выберите дни ещё раз."); return; }
    await this.edit(ctx, this.daysText(user, mask), this.daysKeyboard(mask));
  }

  async handleDayToggle(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    const match = new RegExp(`^schedule_day_${VERSION}_(\\d+)_(\\d+)$`).exec(data);
    if (!match) return;
    const mask = Number(match[1]);
    const bit = Number(match[2]);
    if (!this.validDraftMask(mask) || !DAY_BITS.includes(bit)) { await ctx.reply("Черновик расписания устарел. Откройте /schedule и выберите дни ещё раз."); return; }
    const next = mask ^ bit;
    await this.edit(ctx, this.daysText(user, next), this.daysKeyboard(next));
  }

  async handleSaveDays(ctx: Context, data: string): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    const mask = this.parseMask(data, `schedule_save_${VERSION}_`);
    if (mask === null || mask === 0) {
      await ctx.reply("Выберите хотя бы один день или включите режим «Занимаюсь сам».");
      return;
    }
    try {
      const patch = { promptWeekdaysMask: mask, dailyPromptEnabled: true };
      const updated = await this.scheduleService.updateScheduleSettings(user.id, patch);
      await this.showSaved(ctx, updated, mask !== ALL_WEEKDAYS_MASK);
    } catch {
      await ctx.reply("Не удалось сохранить дни. Расписание осталось прежним — попробуйте ещё раз.");
    }
  }

  async handleCancel(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    await this.show(ctx, user);
  }

  async handleManual(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    try {
      const updated = await this.scheduleService.disableSchedule(user.id);
      await this.showSaved(ctx, updated, true);
    } catch {
      await ctx.reply("Не удалось включить режим самостоятельных занятий. Попробуйте ещё раз.");
    }
  }

  async handleEnable(ctx: Context): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    try {
      await this.show(ctx, await this.scheduleService.enableSchedule(user.id));
    } catch {
      await ctx.reply("Не удалось включить автоматические вопросы. Попробуйте ещё раз.");
    }
  }

  async handleReminderChoice(ctx: Context, enabled: boolean): Promise<void> {
    const user = await this.userFromContext(ctx);
    if (!user) return this.requireStart(ctx);
    try {
      const updated = await this.streakService.updateReminderEnabled(user.id, enabled);
      await this.edit(ctx, this.reminderText(updated), this.reminderKeyboard(updated));
    } catch {
      await ctx.reply("Расписание сохранено, но настройку напоминаний не удалось изменить. Выберите действие ещё раз.");
    }
  }

  private async showSaved(ctx: Context, user: User, explainStreak: boolean): Promise<void> {
    if (!explainStreak) return this.show(ctx, user);
    await this.edit(ctx, this.reminderText(user), this.reminderKeyboard(user));
  }

  private async show(ctx: Context, user: User): Promise<void> {
    await this.edit(ctx, this.format(user), this.openKeyboard(user));
  }

  private format(user: User): string {
    const tz = resolveEffectiveTimeZone(user.timezone).timeZone;
    const days = this.dayNames(this.userMask(user));
    const next = user.dailyPromptEnabled && user.nextPromptAt
      ? user.nextPromptAt.toLocaleString("ru-RU", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })
      : "нет автоматической отправки";
    return `<b>Расписание занятий</b>\n\nДни: <b>${days}</b>\nВремя: <b>${this.time(user)}</b>\nЧасовой пояс: <b>${tz}</b>\nАвтоматические вопросы: <b>${user.dailyPromptEnabled ? "включены" : "выключены"}</b>\nСледующий слот: <b>${next}</b>\nИзменить время: <code>/time ЧЧ:ММ</code>`;
  }

  private daysText(user: User, mask: number): string {
    return `Выберите дни для вопросов. Сохранённые: ${this.dayNames(this.userMask(user))}.\nТекущий выбор: <b>${mask ? this.dayNames(mask) : "не выбраны"}</b>`;
  }

  private reminderText(user: User): string {
    return `${this.format(user)}\n\n<b>Стрик</b> сохраняется, если завершать разговор с ботом каждый день. Получение вопроса само по себе день не засчитывает. В свободный день можно начать через /start.\n\nНапоминания о стрике сейчас <b>${user.streakReminderEnabled ? "включены" : "выключены"}</b>.`;
  }

  private openKeyboard(user: User): InlineKeyboard {
    return new InlineKeyboard()
      .text("🕒 Изменить время", "schedule_time_open").row()
      .text("📅 Выбрать дни", `schedule_days_${VERSION}_${this.userMask(user)}`).row()
      .text("✍️ Занимаюсь сам", `schedule_manual_${VERSION}`).row()
      .text(user.dailyPromptEnabled ? "🔕 Выключить вопросы" : "🔔 Включить вопросы", user.dailyPromptEnabled ? `schedule_manual_${VERSION}` : `schedule_enable_${VERSION}`);
  }

  private daysKeyboard(mask: number): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    DAY_BITS.forEach((bit, index) => {
      keyboard.text(`${mask & bit ? "✅ " : ""}${DAYS[index]}`, `schedule_day_${VERSION}_${mask}_${bit}`);
      if (index === 2 || index === 5) keyboard.row();
    });
    return keyboard.row()
      .text("Сохранить", `schedule_save_${VERSION}_${mask}`)
      .text("Отмена", `schedule_cancel_${VERSION}`)
      .row().text("Занимаюсь сам", `schedule_manual_${VERSION}`);
  }

  private reminderKeyboard(user: User): InlineKeyboard {
    return new InlineKeyboard()
      .text(`${user.streakReminderEnabled ? "✅ " : ""}Включить напоминания`, `schedule_reminder_${VERSION}_on`).row()
      .text(`${!user.streakReminderEnabled ? "✅ " : ""}Выключить напоминания`, `schedule_reminder_${VERSION}_off`).row()
      .text("К расписанию", "schedule_open");
  }

  private userMask(user: User): number {
    const value = (user as User & { promptWeekdaysMask?: number }).promptWeekdaysMask;
    return this.validMask(value) ? value : ALL_WEEKDAYS_MASK;
  }

  private parseMask(data: string, prefix: string): number | null {
    if (!data.startsWith(prefix)) return null;
    const value = Number(data.slice(prefix.length));
    return this.validMask(value) ? value : null;
  }

  private parseDraftMask(data: string, prefix: string): number | null {
    if (!data.startsWith(prefix)) return null;
    const value = Number(data.slice(prefix.length));
    return this.validDraftMask(value) ? value : null;
  }

  private validDraftMask(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= ALL_WEEKDAYS_MASK;
  }

  private validMask(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= ALL_WEEKDAYS_MASK;
  }

  private dayNames(mask: number): string {
    return DAY_BITS.filter((bit) => mask & bit).map((bit) => DAYS[DAY_BITS.indexOf(bit)]).join(", ");
  }

  private time(user: Pick<User, "dailyPromptHour" | "dailyPromptMinute">): string {
    return `${String(user.dailyPromptHour).padStart(2, "0")}:${String(user.dailyPromptMinute).padStart(2, "0")}`;
  }

  private async edit(ctx: Context, text: string, reply_markup: InlineKeyboard): Promise<void> {
    try { await ctx.editMessageText(text, { reply_markup, parse_mode: "HTML" }); }
    catch { await ctx.reply(text, { reply_markup, parse_mode: "HTML" }); }
  }

  private async requireStart(ctx: Context): Promise<void> {
    if (ctx.from?.id) await ctx.reply("Пожалуйста, начните с команды /start");
  }

  private userFromContext(ctx: Context): Promise<User | null> {
    return ctx.from?.id ? this.userService.findByTelegramId(BigInt(ctx.from.id)) : Promise.resolve(null);
  }
}
