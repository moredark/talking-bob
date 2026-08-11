const assert = require("node:assert/strict");
const test = require("node:test");

const { StreakService } = require("../dist/modules/streak/streak.service");
const {
  SettingsHandler,
} = require("../dist/modules/telegram/handlers/settings.handler");

function sameDate(left, right) {
  return left instanceof Date && right instanceof Date
    ? left.getTime() === right.getTime()
    : left === right;
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("in" in expected) return expected.in.includes(actual);
      if ("not" in expected) return !sameDate(actual, expected.not);
      if ("lte" in expected && !(actual <= expected.lte)) return false;
      if ("lt" in expected && !(actual < expected.lt)) return false;
      if ("gte" in expected && !(actual >= expected.gte)) return false;
      if ("gt" in expected && !(actual > expected.gt)) return false;
      return true;
    }
    return sameDate(actual, expected);
  });
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value
      ? row[key] + value.increment
      : value;
  }
  return row;
}

function createFakePrisma(overrides = {}) {
  const state = {
    user: {
      id: "user-1",
      telegramId: 4242n,
      timezone: "UTC",
      currentStreak: 0,
      longestStreak: 0,
      lastStreakLocalDate: null,
      streakExpiresAt: null,
      streakReminderEnabled: true,
      streakReminderHour: 21,
      streakReminderMinute: 0,
      nextStreakReminderAt: null,
      dailyPromptEnabled: true,
      announcementEnabled: true,
      dailyPromptHour: 13,
      dailyPromptMinute: 0,
      agentTone: "friendly",
      ...overrides.user,
    },
    days: [],
    reminders: [],
    snapshots: new Map(),
    reminderSequence: 0,
  };

  const client = {
    state,
    async $transaction(callback) { return callback(client); },
    async $queryRaw(query) {
      const text = (query.strings || []).join("?");
      const values = query.values || [];
      if (text.includes('FROM "users"')) {
        return values[0] === state.user.id ? [state.user] : [];
      }
      if (text.includes('FROM "streak_reminders"') && text.includes('WHERE "id"')) {
        const row = state.reminders.find((item) => item.id === values[0]);
        return row ? [row] : [];
      }
      if (text.includes('SELECT r."id", r."userId"')) {
        const now = values.find((value) => value instanceof Date);
        const limit = values.findLast((value) => typeof value === "number") || 50;
        return state.reminders
          .filter((row) =>
            row.status === "pending" &&
            row.nextAttemptAt && row.nextAttemptAt <= now &&
            row.expiresAt > now &&
            (!row.claimToken || row.claimExpiresAt <= now) &&
            state.user.streakReminderEnabled &&
            state.user.nextStreakReminderAt &&
            state.user.nextStreakReminderAt <= now)
          .slice(0, limit)
          .map(({ id, userId }) => ({ id, userId }));
      }
      throw new Error(`unsupported raw query: ${text}`);
    },
    async $executeRaw() { return 0; },
    user: {
      async findUnique({ where }) {
        return where.id === state.user.id ? state.user : null;
      },
      async update({ where, data }) {
        assert.equal(where.id, state.user.id);
        return applyData(state.user, data);
      },
      async updateMany({ where, data }) {
        if (!matches(state.user, where)) return { count: 0 };
        applyData(state.user, data);
        return { count: 1 };
      },
    },
    userResponse: {
      async updateMany({ where, data }) {
        state.snapshots.set(where.userPromptId, { ...data });
        return { count: 1 };
      },
    },
    streakDay: {
      async findUnique({ where }) {
        const compound = where.userId_localDate;
        return state.days.find((row) =>
          row.userId === compound.userId && sameDate(row.localDate, compound.localDate)) || null;
      },
      async create({ data }) {
        assert.equal(
          state.days.some((row) => row.sourceUserPromptId === data.sourceUserPromptId),
          false,
          "source prompt qualification must be unique",
        );
        const row = { id: `day-${state.days.length + 1}`, ...data };
        state.days.push(row);
        return row;
      },
    },
    streakReminder: {
      async createMany({ data }) {
        for (const item of data) {
          if (state.reminders.some((row) =>
            row.userId === item.userId && sameDate(row.localDate, item.localDate))) continue;
          state.reminders.push({
            id: `reminder-${++state.reminderSequence}`,
            status: "pending",
            attemptCount: 0,
            claimToken: null,
            claimExpiresAt: null,
            deliveryAttemptedAt: null,
            sentAt: null,
            lastErrorCode: null,
            lastErrorAt: null,
            ...item,
          });
        }
        return { count: data.length };
      },
      async findUnique({ where }) {
        return state.reminders.find((row) => row.id === where.id) || null;
      },
      async update({ where, data }) {
        const row = state.reminders.find((item) => item.id === where.id);
        assert.ok(row);
        return applyData(row, data);
      },
      async updateMany({ where, data }) {
        const rows = state.reminders.filter((row) => matches(row, where));
        rows.forEach((row) => applyData(row, data));
        return { count: rows.length };
      },
    },
  };
  return client;
}

async function qualify(service, prisma, userPromptId, qualifiedAt) {
  return service.qualifyConversation(
    { userId: "user-1", userPromptId, qualifiedAt },
    prisma,
  );
}

test("qualification is idempotent per local day, snapshots reports, and handles consecutive and gap days", async () => {
  const prisma = createFakePrisma();
  const service = new StreakService(prisma);

  const first = await qualify(service, prisma, "prompt-1", new Date("2026-08-01T10:00:00Z"));
  assert.deepEqual(
    { current: first.currentStreak, longest: first.longestStreak, record: first.isNewRecord },
    { current: 1, longest: 1, record: true },
  );
  assert.equal(first.expiresAt.toISOString(), "2026-08-03T00:00:00.000Z");
  assert.equal(prisma.state.user.nextStreakReminderAt.toISOString(), "2026-08-02T21:00:00.000Z");

  const sameDay = await qualify(service, prisma, "prompt-2", new Date("2026-08-01T22:00:00Z"));
  assert.equal(sameDay.currentStreak, 1);
  assert.equal(prisma.state.days.length, 1);
  assert.deepEqual(prisma.state.snapshots.get("prompt-2"), {
    streakCurrentSnapshot: 1,
    streakLongestSnapshot: 1,
    streakIsNewRecord: false,
  });

  const consecutive = await qualify(service, prisma, "prompt-3", new Date("2026-08-02T08:00:00Z"));
  assert.equal(consecutive.currentStreak, 2);
  assert.equal(consecutive.isNewRecord, true);
  assert.equal(prisma.state.reminders[0].status, "cancelled");

  const afterGap = await qualify(service, prisma, "prompt-4", new Date("2026-08-04T08:00:00Z"));
  assert.equal(afterGap.currentStreak, 1);
  assert.equal(afterGap.longestStreak, 2);
  assert.equal(afterGap.isNewRecord, false);
  assert.deepEqual(prisma.state.days.map((row) => row.localDate.toISOString().slice(0, 10)), [
    "2026-08-01", "2026-08-02", "2026-08-04",
  ]);
});

test("effective status becomes zero exactly at D+2 expiry without losing the longest streak", async () => {
  const prisma = createFakePrisma({
    user: {
      currentStreak: 4,
      longestStreak: 9,
      lastStreakLocalDate: new Date("2026-08-01T00:00:00Z"),
      streakExpiresAt: new Date("2026-08-03T00:00:00Z"),
    },
  });
  const service = new StreakService(prisma);

  assert.deepEqual(
    await service.getStatus("user-1", new Date("2026-08-02T23:59:59.999Z")),
    {
      currentStreak: 4,
      longestStreak: 9,
      active: true,
      expiresAt: new Date("2026-08-03T00:00:00Z"),
      lastLocalDate: new Date("2026-08-01T00:00:00Z"),
    },
  );
  const expired = await service.getStatus("user-1", new Date("2026-08-03T00:00:00Z"));
  assert.equal(expired.currentStreak, 0);
  assert.equal(expired.longestStreak, 9);
  assert.equal(expired.active, false);
});

test("qualification canonicalizes timezone aliases while keeping database dates at UTC midnight", async () => {
  const prisma = createFakePrisma({ user: { timezone: "US/Eastern" } });
  const service = new StreakService(prisma);

  await qualify(service, prisma, "prompt-alias", new Date("2026-08-02T02:00:00Z"));

  assert.equal(prisma.state.days[0].localDate.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(
    prisma.state.days[0].timezoneSnapshot,
    new Intl.DateTimeFormat("en-US", { timeZone: "US/Eastern" }).resolvedOptions().timeZone,
  );
});

test("timezone reschedule never resurrects expiry and recomputes D+1/D+2 only for active streaks", async () => {
  const cases = [
    {
      name: "stored expiry has already passed",
      user: {
        timezone: "America/Los_Angeles",
        lastStreakLocalDate: new Date("2026-08-01T00:00:00Z"),
        streakExpiresAt: new Date("2026-08-02T10:00:00Z"),
      },
      now: new Date("2026-08-02T12:00:00Z"),
      expiry: "2026-08-02T10:00:00.000Z",
      reminder: null,
    },
    {
      name: "westward timezone makes the stored date one day ahead",
      user: {
        timezone: "America/Los_Angeles",
        lastStreakLocalDate: new Date("2026-08-02T00:00:00Z"),
        streakExpiresAt: new Date("2026-08-03T00:00:00Z"),
      },
      now: new Date("2026-08-02T02:00:00Z"),
      expiry: "2026-08-04T07:00:00.000Z",
      reminder: "2026-08-04T04:00:00.000Z",
    },
    {
      name: "today's reminder time is already gone",
      user: {
        timezone: "America/Los_Angeles",
        lastStreakLocalDate: new Date("2026-08-01T00:00:00Z"),
        streakExpiresAt: new Date("2026-08-03T00:00:00Z"),
        streakReminderHour: 0,
      },
      now: new Date("2026-08-02T10:00:00Z"),
      expiry: "2026-08-03T07:00:00.000Z",
      reminder: null,
    },
  ];

  for (const entry of cases) {
    const prisma = createFakePrisma({
      user: { currentStreak: 3, longestStreak: 5, ...entry.user },
    });
    await new StreakService(prisma).rescheduleForTimezone("user-1", entry.now);
    assert.equal(prisma.state.user.streakExpiresAt.toISOString(), entry.expiry, entry.name);
    assert.equal(
      prisma.state.user.nextStreakReminderAt?.toISOString() ?? null,
      entry.reminder,
      entry.name,
    );
  }
});

test("reminder claims are unique, reclaim expired leases, retry with backoff, and terminally fence attempts", async () => {
  const prisma = createFakePrisma();
  const service = new StreakService(prisma);
  await qualify(service, prisma, "prompt-1", new Date("2026-08-01T10:00:00Z"));

  const due = new Date("2026-08-02T21:00:00Z");
  const [firstClaim] = await service.claimDueReminders(10, due);
  assert.ok(firstClaim.claimToken);
  assert.deepEqual(await service.claimDueReminders(10, due), []);

  const reclaimedAt = new Date("2026-08-02T21:02:00.001Z");
  const [reclaimed] = await service.claimDueReminders(10, reclaimedAt);
  assert.equal(reclaimed.reminderId, firstClaim.reminderId);
  assert.notEqual(reclaimed.claimToken, firstClaim.claimToken);

  const attempt = await service.beginReminderAttempt(reclaimed, reclaimedAt);
  assert.equal(attempt.currentStreak, 1);
  assert.equal(prisma.state.reminders[0].attemptCount, 1);
  assert.equal(prisma.state.reminders[0].claimToken, reclaimed.claimToken);
  assert.equal(attempt.claimToken, reclaimed.claimToken);
  assert.equal(
    await service.completeReminderRetryableFailure(attempt, "Telegram / 503", reclaimedAt),
    true,
  );
  assert.equal(prisma.state.reminders[0].status, "pending");
  assert.equal(prisma.state.reminders[0].lastErrorCode, "telegram_503");
  assert.equal(prisma.state.reminders[0].nextAttemptAt.toISOString(), "2026-08-02T21:03:00.001Z");

  const [retryClaim] = await service.claimDueReminders(
    10,
    new Date("2026-08-02T21:03:00.001Z"),
  );
  const retryAttempt = await service.beginReminderAttempt(
    retryClaim,
    new Date("2026-08-02T21:03:00.001Z"),
  );
  assert.equal(
    await service.completeReminderTerminalFailure(
      retryAttempt,
      "telegram transport ambiguous",
      new Date("2026-08-02T21:03:01Z"),
    ),
    true,
  );
  assert.equal(prisma.state.reminders[0].status, "failed");
  assert.equal(prisma.state.user.nextStreakReminderAt, null);
  assert.deepEqual(await service.claimDueReminders(10, new Date("2026-08-02T22:00:00Z")), []);
});

test("an expired attempted reminder lease is terminal while an unattempted lease is reclaimable", async () => {
  const attemptedPrisma = createFakePrisma();
  const attemptedService = new StreakService(attemptedPrisma);
  await qualify(attemptedService, attemptedPrisma, "prompt-attempted", new Date("2026-08-01T10:00:00Z"));
  const due = new Date("2026-08-02T21:00:00Z");
  const [claimBeforeIo] = await attemptedService.claimDueReminders(1, due);
  const begun = await attemptedService.beginReminderAttempt(claimBeforeIo, due);
  assert.ok(begun);
  assert.equal(attemptedPrisma.state.reminders[0].claimToken, claimBeforeIo.claimToken);

  const afterLease = new Date("2026-08-02T21:02:00.001Z");
  assert.deepEqual(await attemptedService.claimDueReminders(1, afterLease), []);
  assert.equal(attemptedPrisma.state.reminders[0].status, "failed");
  assert.equal(attemptedPrisma.state.reminders[0].lastErrorCode, "lease_expired_after_io");
  assert.ok(attemptedPrisma.state.reminders[0].deliveryAttemptedAt);

  const unattemptedPrisma = createFakePrisma();
  const unattemptedService = new StreakService(unattemptedPrisma);
  await qualify(unattemptedService, unattemptedPrisma, "prompt-unattempted", new Date("2026-08-01T10:00:00Z"));
  const [first] = await unattemptedService.claimDueReminders(1, due);
  const [second] = await unattemptedService.claimDueReminders(1, afterLease);
  assert.equal(second.reminderId, first.reminderId);
  assert.notEqual(second.claimToken, first.claimToken);
  assert.equal(unattemptedPrisma.state.reminders[0].deliveryAttemptedAt, null);
});

test("elapsed same-date time or timezone changes cancel pending leases and fence the old claim", async (t) => {
  async function assertCancelled(prisma, oldClaim, now) {
    const row = prisma.state.reminders[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.claimToken, null);
    assert.equal(row.claimExpiresAt, null);
    assert.equal(row.nextAttemptAt, null);
    assert.equal(prisma.state.user.nextStreakReminderAt, null);
    assert.equal(await new StreakService(prisma).beginReminderAttempt(oldClaim, now), null);
  }

  await t.test("reminder time moves earlier", async () => {
    const now = new Date("2026-08-02T22:00:00.000Z");
    const prisma = createFakePrisma({
      user: {
        currentStreak: 3,
        longestStreak: 3,
        lastStreakLocalDate: new Date("2026-08-01T00:00:00.000Z"),
        streakExpiresAt: new Date("2026-08-03T00:00:00.000Z"),
        nextStreakReminderAt: new Date("2026-08-02T21:00:00.000Z"),
      },
    });
    prisma.state.reminders.push({
      id: "reminder-time",
      userId: "user-1",
      localDate: new Date("2026-08-02T00:00:00.000Z"),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date("2026-08-02T21:00:00.000Z"),
      expiresAt: new Date("2026-08-03T00:00:00.000Z"),
      claimToken: "old-time-claim",
      claimExpiresAt: new Date("2026-08-02T22:01:00.000Z"),
      deliveryAttemptedAt: null,
    });
    const oldClaim = { reminderId: "reminder-time", userId: "user-1", claimToken: "old-time-claim" };

    await new StreakService(prisma).updateReminderTime("user-1", 18, 0, now);
    await assertCancelled(prisma, oldClaim, now);
  });

  await t.test("timezone moves the same local rescue-day slot into the past", async () => {
    const now = new Date("2026-08-02T10:00:00.000Z");
    const prisma = createFakePrisma({
      user: {
        timezone: "America/Los_Angeles",
        currentStreak: 3,
        longestStreak: 3,
        lastStreakLocalDate: new Date("2026-08-01T00:00:00.000Z"),
        streakExpiresAt: new Date("2026-08-03T12:00:00.000Z"),
        streakReminderHour: 0,
        nextStreakReminderAt: new Date("2026-08-02T09:00:00.000Z"),
      },
    });
    prisma.state.reminders.push({
      id: "reminder-zone",
      userId: "user-1",
      localDate: new Date("2026-08-02T00:00:00.000Z"),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date("2026-08-02T09:00:00.000Z"),
      expiresAt: new Date("2026-08-03T12:00:00.000Z"),
      claimToken: "old-zone-claim",
      claimExpiresAt: new Date("2026-08-02T10:01:00.000Z"),
      deliveryAttemptedAt: null,
    });
    const oldClaim = { reminderId: "reminder-zone", userId: "user-1", claimToken: "old-zone-claim" };
    const service = new StreakService(prisma);

    await service.rescheduleForTimezoneInTransaction(prisma, prisma.state.user, now);
    await assertCancelled(prisma, oldClaim, now);
  });
});

test("settings expose defaults and delegate streak reminder toggle and time independently", async () => {
  const calls = [];
  const user = createFakePrisma().state.user;
  const streak = {
    getStatus: async () => ({ currentStreak: 3, longestStreak: 5 }),
    updateReminderEnabled: async (id, enabled) => {
      calls.push(["toggle", id, enabled]);
      return { ...user, streakReminderEnabled: enabled };
    },
    updateReminderTime: async (id, hour, minute) => {
      calls.push(["time", id, hour, minute]);
      return { ...user, streakReminderHour: hour, streakReminderMinute: minute };
    },
  };
  const handler = new SettingsHandler(
    { findByTelegramId: async () => user },
    {},
    streak,
  );
  const edits = [];
  const context = {
    from: { id: 4242 },
    editMessageText: async (text, options) => edits.push({ text, options }),
    reply: async () => undefined,
  };

  await handler.handleStreakReminderToggle(context);
  await handler.handleStreakReminderTimeSelect(context, "set_streak_time_18_0");

  assert.deepEqual(calls, [
    ["toggle", "user-1", false],
    ["time", "user-1", 18, 0],
  ]);
  assert.match(edits[0].text, /Текущий стрик: <b>3<\/b>/);
  assert.match(edits[0].text, /Напоминания о стрике: <b>выключены<\/b>/);
  assert.match(edits[1].text, /Время напоминания: <b>18:00<\/b>/);
  assert.ok(edits[1].options.reply_markup.inline_keyboard.flat().some(
    (button) => button.callback_data === "toggle_streak_reminder",
  ));
});
