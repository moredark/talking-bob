const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");

const { DEFAULT_USER_TIMEZONE } = require("../dist/config/limits.config");
const {
  PromptService,
} = require("../dist/modules/prompt/prompt.service");
const {
  SettingsHandler,
} = require("../dist/modules/telegram/handlers/settings.handler");
const { UserService } = require("../dist/modules/user/user.service");

test("new user persists an enabled default schedule with its initial slot atomically", async () => {
  const fixedNow = new Date("2026-08-06T09:00:00.000Z");
  const RealDate = global.Date;
  let createData;
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedNow.getTime()] : args));
    }
    static now() {
      return fixedNow.getTime();
    }
  };

  try {
    const service = new UserService({
      user: {
        create: async ({ data }) => {
          createData = data;
          return { id: "user-1", ...data };
        },
      },
    });
    const created = await service.createUser({
      telegramId: 123n,
      username: "alice",
    });

    assert.equal(created.id, "user-1");
    assert.equal(createData.dailyPromptEnabled, true);
    assert.equal(createData.dailyPromptHour, 13);
    assert.equal(createData.dailyPromptMinute, 0);
    assert.equal(createData.timezone, DEFAULT_USER_TIMEZONE);
    assert.equal(
      createData.nextPromptAt.toISOString(),
      "2026-08-06T10:00:00.000Z",
    );
  } finally {
    global.Date = RealDate;
  }
});

test("parallel findOrCreate calls use atomic upsert and resolve one logical user", async () => {
  const users = new Map();
  let logicalCreates = 0;
  const service = new UserService({
    user: {
      upsert: async ({ where, create }) => {
        const key = where.telegramId.toString();
        if (!users.has(key)) {
          logicalCreates += 1;
          users.set(key, { id: "winner", ...create });
        }
        await new Promise((resolve) => setImmediate(resolve));
        return users.get(key);
      },
    },
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      service.findOrCreateByTelegramId(123n, "alice"),
    ),
  );

  assert.equal(logicalCreates, 1);
  assert.equal(users.size, 1);
  assert.deepEqual(new Set(results.map(({ id }) => id)), new Set(["winner"]));
});

test("findOrCreate returns the concurrent winner after a P2002 upsert conflict", async () => {
  const conflict = new Prisma.PrismaClientKnownRequestError(
    "unique constraint conflict",
    { code: "P2002", clientVersion: "test" },
  );
  const winner = { id: "winner", telegramId: 123n, username: "alice" };
  let lookup;
  const service = new UserService({
    user: {
      upsert: async () => {
        throw conflict;
      },
      findUnique: async (args) => {
        lookup = args;
        return winner;
      },
    },
  });

  assert.equal(await service.findOrCreateByTelegramId(123n, "alice"), winner);
  assert.deepEqual(lookup, { where: { telegramId: 123n } });
});

test("findOrCreate rethrows the original P2002 when no concurrent winner exists", async () => {
  const conflict = new Prisma.PrismaClientKnownRequestError(
    "unique constraint conflict",
    { code: "P2002", clientVersion: "test" },
  );
  const service = new UserService({
    user: {
      upsert: async () => {
        throw conflict;
      },
      findUnique: async () => null,
    },
  });

  await assert.rejects(
    service.findOrCreateByTelegramId(123n, "alice"),
    (error) => error === conflict,
  );
});

test("findOrCreate rethrows a non-P2002 error without a fallback lookup", async () => {
  const failure = new Error("database unavailable");
  let lookupCalled = false;
  const service = new UserService({
    user: {
      upsert: async () => {
        throw failure;
      },
      findUnique: async () => {
        lookupCalled = true;
        return null;
      },
    },
  });

  await assert.rejects(
    service.findOrCreateByTelegramId(123n, "alice"),
    (error) => error === failure,
  );
  assert.equal(lookupCalled, false);
});

test("latest prompt lookup accepts only sent deliveries in deterministic order", async () => {
  let query;
  const expected = { id: "sent-1", deliveryStatus: "sent" };
  const service = new PromptService({
    userPrompt: {
      findFirst: async (args) => {
        query = args;
        return expected;
      },
    },
  });

  assert.equal(await service.getLatestUserPrompt("user-1"), expected);
  assert.deepEqual(query, {
    where: { userId: "user-1", deliveryStatus: "sent" },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
  });
});

test("active prompt preflight uses a cheap existence query", async () => {
  let query;
  const service = new PromptService({
    prompt: {
      findFirst: async (args) => {
        query = args;
        return { id: "prompt-1" };
      },
    },
  });

  assert.equal(await service.hasActivePrompt(), true);
  assert.deepEqual(query, {
    where: { isActive: true },
    select: { id: true },
  });
});

test("settings display uses canonical effective timezone and actual schedule status", async () => {
  const cases = [
    {
      timezone: "US/Eastern",
      enabled: true,
      expectedZone: new Intl.DateTimeFormat("en-US", {
        timeZone: "US/Eastern",
      }).resolvedOptions().timeZone,
      expectedStatus: "включена",
    },
    {
      timezone: "Not/A_Timezone",
      enabled: false,
      expectedZone: DEFAULT_USER_TIMEZONE,
      expectedStatus: "выключена",
    },
  ];

  for (const entry of cases) {
    const replies = [];
    const handler = new SettingsHandler(
      {
        findByTelegramId: async () => ({
          id: "user-1",
          dailyPromptEnabled: entry.enabled,
          dailyPromptHour: 9,
          dailyPromptMinute: 5,
          timezone: entry.timezone,
          agentTone: "friendly",
        }),
      },
      {},
      { getStatus: async () => null },
    );

    await handler.handle({
      from: { id: 123 },
      reply: async (text) => replies.push(text),
    });

    assert.equal(replies.length, 1);
    assert.match(replies[0], new RegExp(entry.expectedStatus));
    assert.match(replies[0], new RegExp(entry.expectedZone.replace("/", "\\/")));
    assert.match(replies[0], /09:05/);
  }
});
