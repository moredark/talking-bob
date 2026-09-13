const assert = require("node:assert/strict");
const test = require("node:test");
const { ScheduleHandler } = require("../dist/modules/telegram/handlers/schedule.handler");

function user(overrides = {}) {
  return {
    id: "u1", telegramId: 42n, timezone: "Europe/Moscow",
    dailyPromptEnabled: true, promptWeekdaysMask: 127,
    dailyPromptHour: 13, dailyPromptMinute: 0, nextPromptAt: new Date("2026-09-14T10:00:00Z"),
    streakReminderEnabled: true, streakReminderHour: 21, streakReminderMinute: 0,
    ...overrides,
  };
}

function context(text) {
  const calls = { replies: [], edits: [] };
  return {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    message: text === undefined ? undefined : { text },
    reply: async (message, options) => calls.replies.push({ message, options }),
    editMessageText: async (message, options) => calls.edits.push({ message, options }),
    calls,
  };
}

function setup(initial = user()) {
  let current = initial;
  const scheduleCalls = [];
  const reminderCalls = [];
  const users = { async findByTelegramId() { return current; } };
  const schedule = {
    async initializeSchedule(id, hour, minute) {
      scheduleCalls.push({ kind: "time", id, hour, minute });
      current = { ...current, dailyPromptHour: hour, dailyPromptMinute: minute };
      return current;
    },
    async updateScheduleSettings(id, patch) {
      scheduleCalls.push({ kind: "settings", id, patch });
      current = { ...current, ...patch, nextPromptAt: patch.dailyPromptEnabled === false ? null : current.nextPromptAt };
      return current;
    },
    async disableSchedule(id) {
      scheduleCalls.push({ kind: "disable", id }); current = { ...current, dailyPromptEnabled: false, nextPromptAt: null }; return current;
    },
    async enableSchedule(id) {
      scheduleCalls.push({ kind: "enable", id }); current = { ...current, dailyPromptEnabled: true }; return current;
    },
  };
  const streak = {
    async updateReminderEnabled(id, enabled) {
      reminderCalls.push({ id, enabled }); current = { ...current, streakReminderEnabled: enabled }; return current;
    },
  };
  return { handler: new ScheduleHandler(users, schedule, streak), scheduleCalls, reminderCalls, get current() { return current; } };
}

test("/time accepts arbitrary two-digit time and preserves schedule state", async () => {
  const env = setup(user({ promptWeekdaysMask: 5, dailyPromptEnabled: false, nextPromptAt: null }));
  const ctx = context("/time 07:25");
  await env.handler.handleTime(ctx);
  assert.deepEqual(env.scheduleCalls[0], { kind: "settings", id: "u1", patch: { dailyPromptHour: 7, dailyPromptMinute: 25 } });
  assert.equal(env.current.promptWeekdaysMask, 5);
  assert.equal(env.current.dailyPromptEnabled, false);
  assert.match(ctx.calls.replies[0].message, /07:25/);
});

test("/time rejects malformed values and unknown users without creating state", async () => {
  const env = setup();
  for (const value of ["/time 8:05", "/time 24:00", "/time 12:60", "/time 08:45 extra"]) {
    const ctx = context(value); await env.handler.handleTime(ctx);
    assert.match(ctx.calls.replies[0].message, /формат|00:00/);
  }
  const unknown = setup();
  unknown.handler = new ScheduleHandler({ findByTelegramId: async () => null }, {}, {});
  const ctx = context("/time 08:45"); await unknown.handler.handleTime(ctx);
  assert.match(ctx.calls.replies[0].message, /\/start/);
});

test("weekday draft can be changed, cleared temporarily, cancelled, then saved atomically", async () => {
  const env = setup(user({ promptWeekdaysMask: 127 }));
  const ctx = context();
  await env.handler.handleDayToggle(ctx, "schedule_day_v1_127_1");
  const keyboard = ctx.calls.edits.at(-1).options.reply_markup.inline_keyboard;
  assert.equal(keyboard.flat().some((button) => button.callback_data === "schedule_save_v1_126"), true);
  await env.handler.handleSaveDays(ctx, "schedule_save_v1_126");
  assert.deepEqual(env.scheduleCalls.at(-1).patch, { promptWeekdaysMask: 126, dailyPromptEnabled: true });
  assert.match(ctx.calls.edits.at(-1).message, /Напоминания|стрик/i);
  const before = env.scheduleCalls.length;
  await env.handler.handleCancel(ctx);
  assert.equal(env.scheduleCalls.length, before);
});

test("sparse schedule offers explicit reminder choices and retries after failure", async () => {
  const env = setup(user({ promptWeekdaysMask: 127 }));
  const ctx = context();
  await env.handler.handleSaveDays(ctx, "schedule_save_v1_5");
  assert.deepEqual(env.scheduleCalls[0].patch, { promptWeekdaysMask: 5, dailyPromptEnabled: true });
  assert.equal(env.reminderCalls.length, 0);
  const reminderButtonData = ctx.calls.edits.at(-1).options.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(reminderButtonData.includes("schedule_reminder_v1_on"));
  assert.ok(reminderButtonData.includes("schedule_reminder_v1_off"));
  await env.handler.handleReminderChoice(ctx, false);
  assert.deepEqual(env.reminderCalls[0], { id: "u1", enabled: false });
  const failing = setup(user({ promptWeekdaysMask: 127 }));
  failing.handler = new ScheduleHandler({ findByTelegramId: async () => failing.current }, failing.schedule, { updateReminderEnabled: async () => { throw new Error("db"); } });
  const failedCtx = context(); await failing.handler.handleReminderChoice(failedCtx, false);
  assert.match(failedCtx.calls.replies[0].message, /ещё раз/i);
});

test("manual mode disables automatic questions and enable is a separate explicit action", async () => {
  const env = setup(user({ promptWeekdaysMask: 3 }));
  const ctx = context(); await env.handler.handleManual(ctx);
  assert.deepEqual(env.scheduleCalls[0], { kind: "disable", id: "u1" });
  await env.handler.handleEnable(ctx);
  assert.deepEqual(env.scheduleCalls[1], { kind: "enable", id: "u1" });
});

test("old day menus preserve newer time, empty drafts cannot save, and daily mode preserves reminder choice", async () => {
  const env = setup();
  const ctx = context();
  await env.handler.handleDayToggle(ctx, "schedule_day_v1_1_1");
  assert.ok(ctx.calls.edits.at(-1).options.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "schedule_save_v1_0"));
  await env.handler.handleSaveDays(ctx, "schedule_save_v1_0");
  assert.equal(env.scheduleCalls.length, 0);
  ctx.message = { text: "/time 08:45" };
  await env.handler.handleTime(ctx);
  await env.handler.handleSaveDays(ctx, "schedule_save_v1_21");
  assert.equal(env.current.dailyPromptHour, 8);
  assert.equal(env.current.dailyPromptMinute, 45);
  await env.handler.handleReminderChoice(ctx, false);
  await env.handler.handleReminderChoice(ctx, false);
  assert.deepEqual(env.reminderCalls.map(call => call.enabled), [false, false]);
  await env.handler.handleSaveDays(ctx, "schedule_save_v1_127");
  assert.equal(env.current.streakReminderEnabled, false);
  assert.equal(env.current.streakReminderHour, 21);
  assert.equal(env.current.streakReminderMinute, 0);
  assert.equal(env.current.promptWeekdaysMask, 127);
});

test("time picker offers three presets and accepts private chat time once", async () => {
  const env = setup(user({ dailyPromptEnabled: false, promptWeekdaysMask: 5 }));
  const ctx = context("/time");
  await env.handler.handle(ctx);
  assert.ok(ctx.calls.edits.at(-1).options.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "schedule_time_open"));
  await env.handler.handleTime(ctx);
  const buttons = ctx.calls.edits.at(-1).options.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.filter(b => /^schedule_time_v1/.test(b.callback_data)).map(b => b.text), ["09:00", "13:00", "18:00"]);
  const another = context("08:45"); another.from.id = 43;
  assert.equal(await env.handler.handleTimeText(another), false);
  assert.equal(await env.handler.handleTimeText(context("24:00")), true);
  assert.equal(env.scheduleCalls.length, 0);
  assert.equal(await env.handler.handleTimeText(context(" 08:45 ")), true);
  assert.equal(env.current.dailyPromptHour, 8);
  assert.equal(env.current.dailyPromptMinute, 45);
  assert.equal(env.current.dailyPromptEnabled, false);
  assert.equal(env.current.promptWeekdaysMask, 5);
  assert.equal(await env.handler.handleTimeText(context("12:00")), false);
});

test("time input expires, cancels, and never consumes voice or unrelated chat", async () => {
  const env = setup();
  assert.equal(await env.handler.handleTimeText(context("08:45")), false);
  await env.handler.openTimePicker(context());
  assert.equal(await env.handler.handleTimeText(context()), false);
  env.handler.timeInputs.set("42:42", Date.now() - 1);
  assert.equal(await env.handler.handleTimeText(context("08:45")), false);
  await env.handler.openTimePicker(context());
  await env.handler.handle(context());
  assert.equal(await env.handler.handleTimeText(context("08:45")), false);
  await env.handler.openTimePicker(context());
  await env.handler.handleTimeSelect(context(), "schedule_time_v1_18_0");
  assert.equal(env.current.dailyPromptHour, 18);
  assert.equal(await env.handler.handleTimeText(context("08:45")), false);
  const group = context(); group.chat = { id: -1, type: "group" };
  await env.handler.openTimePicker(group);
  group.message = { text: "08:45" };
  assert.equal(await env.handler.handleTimeText(group), false);
});

test("failed time persistence allows retry", async () => {
  const env = setup();
  await env.handler.openTimePicker(context());
  const update = env.handler.scheduleService.updateScheduleSettings;
  env.handler.scheduleService.updateScheduleSettings = async () => { throw new Error("db"); };
  const ctx = context("08:45");
  assert.equal(await env.handler.handleTimeText(ctx), true);
  assert.match(ctx.calls.replies.at(-1).message, /Не удалось/);
  env.handler.scheduleService.updateScheduleSettings = update;
  assert.equal(await env.handler.handleTimeText(context("08:45")), true);
  assert.equal(env.current.dailyPromptMinute, 45);
});
