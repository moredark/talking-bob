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
      nextPromptAt: null,
    },
    {
      id: "b-disabled-alias",
      timezone: "US/Eastern",
      dailyPromptHour: 9,
      dailyPromptMinute: 30,
      dailyPromptEnabled: false,
      nextPromptAt: new Date("2026-08-07T13:30:00.000Z"),
    },
    {
      id: "c-enabled-missing",
      timezone: DEFAULT_USER_TIMEZONE,
      dailyPromptHour: 13,
      dailyPromptMinute: 0,
      dailyPromptEnabled: true,
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
      nextPromptAt: new Date("2026-08-06T13:30:00.000Z"),
    },
  });
  assert.equal(updated.timezone, canonical);
  assert.equal(
    updated.nextPromptAt.toISOString(),
    "2026-08-06T13:30:00.000Z",
  );
});

test("disabling a schedule atomically clears nextPromptAt", async () => {
  const locked = {
    id: "user-1",
    dailyPromptEnabled: true,
    dailyPromptHour: 13,
    dailyPromptMinute: 0,
    timezone: DEFAULT_USER_TIMEZONE,
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
  reclaimRows = [],
  occurrenceKeys = new Set(),
} = {}) {
  const calls = {
    reclaimSql: [],
    dueSql: [],
    insertSql: [],
    occurrenceKeys,
    userUpdates: [],
    reclaimUpdates: [],
  };
  let reclaimRead = false;
  const tx = {
    $queryRaw: async (query) => {
      const text = sqlText(query);
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

test("catch-up collapses downtime to one latest occurrence and two workers conflict on its stable key", async () => {
  const now = new Date("2024-01-05T12:00:00.000Z");
  const occurrenceKeys = new Set();
  const options = {
    occurrenceKeys,
    dueUsers: [
      {
        id: "user-1",
        telegramId: 123n,
        timezone: "Europe/Moscow",
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
