const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULT_USER_TIMEZONE } = require("../dist/config/limits.config");
const {
  ScheduleService,
} = require("../dist/modules/schedule/schedule.service");

function sqlText(query) {
  return query.strings.join("?");
}

test("startup normalization canonicalizes disabled legacy users without delivery and is idempotent", async () => {
  const now = new Date("2026-08-06T09:00:00.000Z");
  const aliasCanonical = new Intl.DateTimeFormat("en-US", {
    timeZone: "US/Eastern",
  }).resolvedOptions().timeZone;
  const rows = [
    {
      id: "a-disabled-invalid",
      timezone: "Not/A_Timezone",
      dailyPromptHour: 99,
      dailyPromptMinute: -1,
      dailyPromptEnabled: false,
      promptWeekdaysMask: 127,
      nextPromptAt: null,
    },
    {
      id: "b-disabled-alias",
      timezone: "US/Eastern",
      dailyPromptHour: 9,
      dailyPromptMinute: 30,
      dailyPromptEnabled: false,
      promptWeekdaysMask: 127,
      nextPromptAt: new Date("2026-08-07T13:30:00.000Z"),
    },
    {
      id: "c-enabled-missing",
      timezone: DEFAULT_USER_TIMEZONE,
      dailyPromptHour: 13,
      dailyPromptMinute: 0,
      dailyPromptEnabled: true,
      promptWeekdaysMask: 127,
      nextPromptAt: null,
    },
  ];
  const queries = [];
  const updates = [];
  let userPromptAccesses = 0;
  const tx = {
    $queryRaw: async (query) => {
      queries.push({ text: sqlText(query), values: query.values });
      const afterId = query.values.find(
        (value) => typeof value === "string",
      );
      const limit = query.values.find((value) => typeof value === "number");
      return rows
        .filter((row) => !afterId || row.id > afterId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit);
    },
    user: {
      update: async ({ where, data }) => {
        updates.push({ where, data });
        Object.assign(
          rows.find((row) => row.id === where.id),
          data,
        );
      },
    },
    userPrompt: new Proxy(
      {},
      {
        get() {
          userPromptAccesses += 1;
          throw new Error("normalization must not create or send prompts");
        },
      },
    ),
  };
  const service = new ScheduleService({
    $transaction: async (callback) => callback(tx),
  });

  await service.onModuleInit();
  assert.equal(updates.length, 3);
  assert.deepEqual(rows[0], {
    id: "a-disabled-invalid",
    timezone: DEFAULT_USER_TIMEZONE,
    dailyPromptHour: 13,
    dailyPromptMinute: 0,
    dailyPromptEnabled: false,
    promptWeekdaysMask: 127,
    nextPromptAt: null,
  });
  assert.equal(rows[1].timezone, aliasCanonical);
  assert.equal(rows[1].dailyPromptEnabled, false);
  assert.equal(rows[1].nextPromptAt, null);
  assert.ok(rows[2].nextPromptAt instanceof Date);
  const enabledSlotParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: DEFAULT_USER_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(rows[2].nextPromptAt)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  assert.deepEqual(
    { hour: enabledSlotParts.hour, minute: enabledSlotParts.minute },
    { hour: "13", minute: "00" },
  );
  assert.equal(userPromptAccesses, 0);
  assert.doesNotMatch(queries[0].text, /"dailyPromptEnabled" = true/);
  assert.match(queries[0].text, /ORDER BY "id"/);
  assert.match(queries[0].text, /FOR UPDATE/);

  assert.equal(await service.normalizeAllSchedules(2, now), 0);
  assert.equal(updates.length, 3);
  assert.equal(queries.length, 3);
  assert.ok(queries[2].values.includes("b-disabled-alias"));
  assert.equal(userPromptAccesses, 0);
});

test("schedule repair selects only enabled missing slots, repairs invalid values, and performs no delivery", async () => {
  const now = new Date("2026-08-06T09:00:00.000Z");
  const updates = [];
  const queries = [];
  let userPromptAccesses = 0;
  const tx = {
    $queryRaw: async (query) => {
      queries.push(sqlText(query));
      return [
        {
          id: "user-1",
          timezone: "Not/A_Timezone",
          dailyPromptHour: 99,
          dailyPromptMinute: -1,
          promptWeekdaysMask: 127,
        },
      ];
    },
    user: {
      update: async (args) => {
        updates.push(args);
        return args.data;
      },
    },
    userPrompt: new Proxy(
      {},
      {
        get() {
          userPromptAccesses += 1;
          throw new Error("repair must not create or deliver prompts");
        },
      },
    ),
  };
  const service = new ScheduleService({
    $transaction: async (callback) => callback(tx),
  });

  assert.equal(await service.repairSchedules(10, now), 1);
  assert.match(queries[0], /"dailyPromptEnabled" = true/);
  assert.match(queries[0], /"nextPromptAt" IS NULL/);
  assert.match(queries[0], /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(updates, [
    {
      where: { id: "user-1" },
      data: {
        dailyPromptHour: 13,
        dailyPromptMinute: 0,
        timezone: DEFAULT_USER_TIMEZONE,
        nextPromptAt: new Date("2026-08-06T10:00:00.000Z"),
      },
    },
  ]);
  assert.equal(userPromptAccesses, 0);
});

test("empty repair batch is idempotent and leaves disabled users untouched", async () => {
  let updates = 0;
  let queryText;
  const service = new ScheduleService({
    $transaction: async (callback) =>
      callback({
        $queryRaw: async (query) => {
          queryText = sqlText(query);
          return [];
        },
        user: {
          update: async () => {
            updates += 1;
          },
        },
      }),
  });

  assert.equal(
    await service.repairSchedules(100, new Date("2026-08-06T09:00:00Z")),
    0,
  );
  assert.match(queryText, /"dailyPromptEnabled" = true/);
  assert.equal(updates, 0);
});

test("settings lock, canonicalization, and next slot update share one transaction", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const locked = {
    id: "user-1",
    dailyPromptEnabled: true,
    dailyPromptHour: 13,
    dailyPromptMinute: 0,
    timezone: DEFAULT_USER_TIMEZONE,
    promptWeekdaysMask: 42,
  };
  const updates = [];
  let transactions = 0;
  let lockSql;
  const service = new ScheduleService({
    $transaction: async (callback) => {
      transactions += 1;
      return callback({
        $queryRaw: async (query) => {
          lockSql = sqlText(query);
          return [locked];
        },
        user: {
          update: async (args) => {
            updates.push(args);
            return { ...locked, ...args.data };
          },
        },
      });
    },
  });
  const canonical = new Intl.DateTimeFormat("en-US", {
    timeZone: "US/Eastern",
  }).resolvedOptions().timeZone;

  const updated = await service.updateScheduleSettings(
    "user-1",
    {
      dailyPromptEnabled: true,
      dailyPromptHour: 9,
      dailyPromptMinute: 30,
      timezone: "US/Eastern",
    },
    now,
  );

  assert.equal(transactions, 1);
  assert.match(lockSql, /FOR UPDATE/);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    where: { id: "user-1" },
    data: {
      dailyPromptEnabled: true,
      dailyPromptHour: 9,
      dailyPromptMinute: 30,
      timezone: canonical,
      promptWeekdaysMask: 42,
      nextPromptAt: new Date("2026-08-06T13:30:00.000Z"),
    },
  });
  assert.equal(updated.timezone, canonical);
  assert.equal(
    updated.nextPromptAt.toISOString(),
    "2026-08-06T13:30:00.000Z",
  );
});

test("timezone schedule update and streak reschedule share rollback and one transaction client", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const initial = {
    id: "user-1",
    dailyPromptEnabled: true,
    dailyPromptHour: 13,
    dailyPromptMinute: 0,
    timezone: "Europe/Moscow",
    promptWeekdaysMask: 42,
    nextPromptAt: new Date("2026-08-07T10:00:00.000Z"),
  };

  for (const failStreak of [false, true]) {
    const state = { user: { ...initial }, streakRescheduled: false };
    let transactions = 0;
    let tx;
    const prisma = {
      user: {
        findUnique: async () => state.user,
      },
      $transaction: async (callback) => {
        transactions += 1;
        const snapshot = structuredClone(state);
        tx = {
          $queryRaw: async () => [{ ...state.user }],
          user: {
            findUnique: async () => state.user,
            update: async ({ data }) => Object.assign(state.user, data),
          },
          streakReminder: {
            updateMany: async () => ({ count: 0 }),
            createMany: async () => ({ count: 0 }),
          },
        };
        try {
          return await callback(tx);
        } catch (error) {
          state.user = snapshot.user;
          state.streakRescheduled = snapshot.streakRescheduled;
          throw error;
        }
      },
    };
    const streak = {
      rescheduleForTimezoneInTransaction: async (...args) => {
        assert.ok(args.includes(tx), "streak receives the schedule transaction client");
        state.streakRescheduled = true;
        if (failStreak) throw new Error("streak reschedule failed");
        return state.user;
      },
    };
    const service = new ScheduleService(prisma, streak);
    const operation = service.updateScheduleSettings(
      "user-1",
      { timezone: "America/Los_Angeles" },
      now,
    );

    if (failStreak) {
      await assert.rejects(operation, /streak reschedule failed/);
      assert.deepEqual(state.user, initial);
      assert.equal(state.streakRescheduled, false);
    } else {
      const updated = await operation;
      assert.equal(updated.timezone, "America/Los_Angeles");
      assert.equal(state.streakRescheduled, true);
    }
    assert.equal(transactions, 1);
  }
});

test("disabling a schedule atomically clears nextPromptAt", async () => {
  const locked = {
    id: "user-1",
    dailyPromptEnabled: true,
    dailyPromptHour: 13,
    dailyPromptMinute: 0,
    timezone: DEFAULT_USER_TIMEZONE,
    promptWeekdaysMask: 42,
    nextPromptAt: new Date("2026-08-07T10:00:00.000Z"),
  };
  let update;
  const service = new ScheduleService({
    $transaction: async (callback) =>
      callback({
        $queryRaw: async () => [locked],
        user: {
          update: async (args) => {
            update = args;
            return { ...locked, ...args.data };
          },
        },
      }),
  });

  const disabled = await service.updateScheduleSettings(
    "user-1",
    { dailyPromptEnabled: false },
    new Date("2026-08-06T12:00:00.000Z"),
  );

  assert.equal(update.data.dailyPromptEnabled, false);
  assert.equal(update.data.nextPromptAt, null);
  assert.equal(disabled.dailyPromptEnabled, false);
  assert.equal(disabled.nextPromptAt, null);
});

function createClaimPrisma({
  dueUsers = [],
  prompts = [],
  historyRows = [],
  reclaimRows = [],
  occurrenceKeys = new Set(),
} = {}) {
  const calls = {
    reclaimSql: [],
    dueSql: [],
    insertSql: [],
    insertValues: [],
    historySql: [],
    historyValues: [],
    occurrenceKeys,
    userUpdates: [],
    reclaimUpdates: [],
  };
  let reclaimRead = false;
  const tx = {
    $queryRaw: async (query) => {
      const text = sqlText(query);
      if (text.includes('SELECT recent."userId"')) {
        calls.historySql.push(text);
        calls.historyValues.push(query.values);
        return historyRows;
      }
      if (text.includes('FROM "user_prompts" up')) {
        calls.reclaimSql.push(text);
        const result = reclaimRead ? [] : reclaimRows;
        reclaimRead = true;
        return result;
      }
      if (text.includes('FROM "users"')) {
        calls.dueSql.push(text);
        return dueUsers;
      }
      if (text.includes('INSERT INTO "user_prompts"')) {
        calls.insertSql.push(text);
        calls.insertValues.push(query.values);
        const key = query.values.find(
          (value) =>
            typeof value === "string" && value.startsWith("scheduled:"),
        );
        if (occurrenceKeys.has(key)) return [];
        occurrenceKeys.add(key);
        return [{ id: `user-prompt-${occurrenceKeys.size}` }];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    prompt: {
      findMany: async () => prompts,
    },
    user: {
      update: async (args) => {
        calls.userUpdates.push(args);
        return args.data;
      },
    },
    userPrompt: {
      update: async (args) => {
        calls.reclaimUpdates.push(args);
        return args.data;
      },
    },
  };
  return {
    calls,
    prisma: {
      $transaction: async (callback) => callback(tx),
    },
  };
}

function createManualClaimPrisma({ prompts = [], historyRows = [], lockedUser } = {}) {
  const calls = {
    sql: [],
    historySql: [],
    creates: [],
  };
  const tx = {
    $queryRaw: async (query) => {
      const text = sqlText(query);
      if (text.includes('SELECT recent."userId"')) {
        calls.historySql.push(text);
        return historyRows;
      }
      calls.sql.push(text);
      return lockedUser ? [lockedUser] : [];
    },
    prompt: {
      findMany: async () => prompts,
    },
    userPrompt: {
      create: async (args) => {
        calls.creates.push(args);
        return { id: "manual-user-prompt" };
      },
    },
  };
  return {
    calls,
    prisma: { $transaction: async (callback) => callback(tx) },
  };
}

test("manual selection handles empty and single-prompt catalogs safely", async () => {
  const user = { id: "user-1", telegramId: 123n };
  const empty = createManualClaimPrisma({ lockedUser: user });
  assert.equal(
    await new ScheduleService(empty.prisma).createManualClaim(user),
    null,
  );
  assert.equal(empty.calls.creates.length, 0);

  const onlyPrompt = { id: "prompt-1", topic: "Only", audioFileId: null };
  const single = createManualClaimPrisma({
    lockedUser: user,
    prompts: [onlyPrompt],
    historyRows: [{ userId: user.id, promptId: onlyPrompt.id }],
  });
  const claim = await new ScheduleService(single.prisma).createManualClaim(user);

  assert.equal(claim.prompt.id, "prompt-1");
  assert.match(single.calls.sql[0], /FOR UPDATE/);
  assert.equal(single.calls.creates[0].data.promptId, "prompt-1");
});

test("manual selection uses pending and sent active history with a deterministic small-catalog fallback", async () => {
  const user = { id: "user-1", telegramId: 123n };
  const prompts = [
    { id: "prompt-1", topic: "One", audioFileId: null },
    { id: "prompt-2", topic: "Two", audioFileId: null },
    { id: "prompt-3", topic: "Three", audioFileId: null },
  ];
  const fixture = createManualClaimPrisma({
    lockedUser: user,
    prompts,
    historyRows: [
      { userId: user.id, promptId: "prompt-1" },
      { userId: user.id, promptId: "prompt-2" },
    ],
  });

  const claim = await new ScheduleService(fixture.prisma).createManualClaim(user);

  assert.equal(claim.prompt.id, "prompt-3");
  assert.match(fixture.calls.historySql[0], /"deliveryStatus" IN/);
  assert.match(fixture.calls.historySql[0], /'pending'/);
  assert.match(fixture.calls.historySql[0], /'sent'/);
  assert.doesNotMatch(fixture.calls.historySql[0], /'failed'/);
  assert.match(fixture.calls.historySql[0], /p\."isActive" = true/);
  assert.match(fixture.calls.historySql[0], /recent\.position <=/);
});

test("exact five-prompt catalog deterministically selects the prompt outside four recent reservations", async () => {
  const user = { id: "user-1", telegramId: 123n };
  const prompts = Array.from({ length: 5 }, (_, index) => ({
    id: `prompt-${index + 1}`,
    topic: `Topic ${index + 1}`,
    audioFileId: null,
  }));
  const fixture = createManualClaimPrisma({
    lockedUser: user,
    prompts,
    historyRows: prompts.slice(0, 4).map(({ id }) => ({
      userId: user.id,
      promptId: id,
    })),
  });

  const claim = await new ScheduleService(fixture.prisma).createManualClaim(user);

  assert.equal(claim.prompt.id, "prompt-5");
  assert.equal(fixture.calls.creates[0].data.promptId, "prompt-5");
});

test("scheduled selection batches histories and applies the repeat window independently per user", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const prompts = Array.from({ length: 7 }, (_, index) => ({
    id: `prompt-${index + 1}`,
    topic: `Topic ${index + 1}`,
    audioFileId: null,
  }));
  const dueUsers = [
    {
      id: "user-1",
      telegramId: 101n,
      timezone: "Europe/Moscow",
      promptWeekdaysMask: 127,
      dailyPromptHour: 13,
      dailyPromptMinute: 0,
    },
    {
      id: "user-2",
      telegramId: 202n,
      timezone: "Europe/Moscow",
      promptWeekdaysMask: 127,
      dailyPromptHour: 13,
      dailyPromptMinute: 0,
    },
  ];
  const historyRows = [
    ...Array.from({ length: 5 }, (_, index) => ({
      userId: "user-1",
      promptId: `prompt-${index + 1}`,
    })),
    ...["prompt-2", "prompt-3", "prompt-4", "prompt-5", "prompt-6"].map(
      (promptId) => ({ userId: "user-2", promptId }),
    ),
  ];
  const fixture = createClaimPrisma({ dueUsers, prompts, historyRows });
  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    const claims = await new ScheduleService(fixture.prisma).claimScheduledBatch(
      2,
      now,
    );

    assert.deepEqual(
      claims.map(({ user, prompt }) => [user.id, prompt.id]),
      [
        ["user-1", "prompt-6"],
        ["user-2", "prompt-1"],
      ],
    );
    assert.equal(fixture.calls.historySql.length, 1);
    assert.ok(fixture.calls.historyValues[0].includes("user-1"));
    assert.ok(fixture.calls.historyValues[0].includes("user-2"));
    assert.equal(fixture.calls.insertSql.length, 2);
  } finally {
    Math.random = originalRandom;
  }
});

test("same-day recovery collapses downtime to today’s occurrence and two workers conflict on its stable key", async () => {
  const now = new Date("2024-01-05T12:00:00.000Z");
  const occurrenceKeys = new Set();
  const options = {
    occurrenceKeys,
    dueUsers: [
      {
        id: "user-1",
        telegramId: 123n,
        timezone: "Europe/Moscow",
        promptWeekdaysMask: 127,
        dailyPromptHour: 13,
        dailyPromptMinute: 0,
      },
    ],
    prompts: [
      { id: "prompt-1", topic: "Travel", audioFileId: null },
    ],
  };
  const workerA = createClaimPrisma(options);
  const workerB = createClaimPrisma(options);
  const [claimsA, claimsB] = await Promise.all([
    new ScheduleService(workerA.prisma).claimScheduledBatch(1, now),
    new ScheduleService(workerB.prisma).claimScheduledBatch(1, now),
  ]);

  assert.equal(claimsA.length + claimsB.length, 1);
  assert.deepEqual([...occurrenceKeys], ["scheduled:user-1:2024-01-05"]);
  for (const worker of [workerA, workerB]) {
    assert.match(worker.calls.dueSql[0], /FOR UPDATE SKIP LOCKED/);
    assert.match(worker.calls.insertSql[0], /ON CONFLICT/);
    assert.equal(
      worker.calls.userUpdates[0].data.nextPromptAt.toISOString(),
      "2024-01-06T10:00:00.000Z",
    );
  }
});

test("expired unattempted scheduled claim is reclaimed with the same row and a fresh lease", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const oldToken = "00000000-0000-4000-8000-000000000000";
  const { calls, prisma } = createClaimPrisma({
    reclaimRows: [
      {
        userPromptId: "existing-user-prompt",
        userId: "user-1",
        telegramId: 123n,
        promptId: "prompt-1",
        topic: "Travel",
        audioFileId: null,
        claimToken: oldToken,
      },
    ],
  });

  const claims = await new ScheduleService(prisma).claimScheduledBatch(1, now);

  assert.equal(claims.length, 1);
  assert.equal(claims[0].userPromptId, "existing-user-prompt");
  assert.notEqual(claims[0].claimToken, oldToken);
  assert.match(calls.reclaimSql[0], /"source" = 'scheduled'/);
  assert.match(calls.reclaimSql[0], /"deliveryStatus" = 'pending'/);
  assert.match(calls.reclaimSql[0], /"deliveryAttemptedAt" IS NULL/);
  assert.match(calls.reclaimSql[0], /"claimExpiresAt" <=/);
  assert.match(calls.reclaimSql[0], /FOR UPDATE OF up SKIP LOCKED/);
  assert.equal(calls.reclaimUpdates.length, 1);
  assert.equal(calls.reclaimUpdates[0].where.id, "existing-user-prompt");
  assert.equal(
    calls.reclaimUpdates[0].data.claimToken,
    claims[0].claimToken,
  );
  assert.equal(
    calls.reclaimUpdates[0].data.claimExpiresAt.toISOString(),
    "2026-08-06T12:02:00.000Z",
  );
});


test("weekly schedule helpers skip unselected days and preserve local date", () => {
  const { nextWeeklySlotAtOrAfter, weeklySlotOnDate } = require("../dist/shared/time/weekday-schedule");
  const now = new Date("2026-08-07T09:00:00.000Z"); // Friday, 12:00 Moscow
  const slot = nextWeeklySlotAtOrAfter(now, 13, 0, "Europe/Moscow", 1);
  assert.equal(slot.localDate, "2026-08-10");
  assert.equal(slot.instant.toISOString(), "2026-08-10T10:00:00.000Z");
  assert.equal(weeklySlotOnDate({ year: 2026, month: 8, day: 7 }, 13, 0, "Europe/Moscow", 1), null);
});

test("weekly schedule helper handles a DST gap on the selected local date", () => {
  const { weeklySlotOnDate } = require("../dist/shared/time/weekday-schedule");
  const slot = weeklySlotOnDate({ year: 2026, month: 3, day: 8 }, 2, 30, "America/New_York", 64);
  assert.equal(slot.localDate, "2026-03-08");
  assert.equal(slot.instant.toISOString(), "2026-03-08T07:00:00.000Z");
});

test("weekly due processing advances without past-date claims on free days, before time, and with no catalogue", async () => {
  for (const [instant, mask, prompts, expected] of [
    ["2026-09-14T12:00:00Z", 21, [{ id: "p", topic: "t", audioFileId: null }], "2026-09-14T13:00:00.000Z"],
    ["2026-09-15T14:00:00Z", 21, [{ id: "p", topic: "t", audioFileId: null }], "2026-09-16T13:00:00.000Z"],
    ["2026-09-15T12:00:00Z", 127, [{ id: "p", topic: "t", audioFileId: null }], "2026-09-15T13:00:00.000Z"],
    ["2026-09-14T14:00:00Z", 21, [], "2026-09-16T13:00:00.000Z"],
  ]) {
    const env = createClaimPrisma({ dueUsers: [{ id: "weekly", telegramId: 1n, timezone: "UTC", dailyPromptHour: 13, dailyPromptMinute: 0, promptWeekdaysMask: mask }], prompts });
    assert.deepEqual(await new ScheduleService(env.prisma).claimScheduledBatch(1, new Date(instant)), []);
    assert.equal(env.calls.insertSql.length, 0);
    assert.equal(env.calls.userUpdates[0].data.nextPromptAt.toISOString(), expected);
  }
});

test("weekly normalization preserves today's due slot and repairs a cursor on an unselected future date", async () => {
  const now = new Date("2026-09-14T14:00:00Z");
  const rows = [
    { id: "due", timezone: "UTC", dailyPromptHour: 13, dailyPromptMinute: 0, dailyPromptEnabled: true, promptWeekdaysMask: 21, nextPromptAt: new Date("2026-09-14T13:00:00Z") },
    { id: "wrong", timezone: "UTC", dailyPromptHour: 13, dailyPromptMinute: 0, dailyPromptEnabled: true, promptWeekdaysMask: 21, nextPromptAt: new Date("2026-09-15T13:00:00Z") },
  ];
  const writes = [];
  const tx = { $queryRaw: async () => rows, user: { update: async ({ where, data }) => { writes.push({ where, data }); return data; } } };
  const schedule = new ScheduleService({ $transaction: async fn => fn(tx) });
  assert.equal(await schedule.normalizeAllSchedules(100, now), 1);
  assert.equal(writes[0].where.id, "wrong");
  assert.equal(writes[0].data.nextPromptAt.toISOString(), "2026-09-16T13:00:00.000Z");
});

test("legacy initialize and enable paths preserve weekly days, while an invalid mask rolls back", async () => {
  let row = { id: "weekly", timezone: "UTC", dailyPromptHour: 13, dailyPromptMinute: 0, dailyPromptEnabled: false, promptWeekdaysMask: 21, nextPromptAt: null };
  let writes = 0;
  const tx = { $queryRaw: async () => [{ ...row }], user: { update: async ({ data }) => { writes++; return row = { ...row, ...data }; } } };
  const schedule = new ScheduleService({ $transaction: async fn => fn(tx) });
  await schedule.initializeSchedule(row.id, 8, 45, "UTC");
  assert.equal(row.promptWeekdaysMask, 21); assert.equal(row.nextPromptAt, null);
  await schedule.enableSchedule(row.id);
  assert.equal(row.promptWeekdaysMask, 21); assert.ok(row.nextPromptAt);
  await schedule.disableSchedule(row.id);
  assert.equal(row.promptWeekdaysMask, 21); assert.equal(row.nextPromptAt, null);
  const savedWrites = writes;
  await assert.rejects(schedule.updateScheduleSettings(row.id, { promptWeekdaysMask: 0 }), /mask/i);
  assert.equal(writes, savedWrites);
});
