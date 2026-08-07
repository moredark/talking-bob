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

test("findOrCreate returns the winning user after a Prisma P2002 race", async () => {
  const winner = {
    id: "winner",
    telegramId: 123n,
    timezone: DEFAULT_USER_TIMEZONE,
  };
  let lookups = 0;
  const service = new UserService({
    user: {
      findUnique: async () => {
        lookups += 1;
        return lookups === 1 ? null : winner;
      },
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError("unique conflict", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["telegramId"] },
        });
      },
    },
  });

  assert.equal(await service.findOrCreateByTelegramId(123n, "alice"), winner);
  assert.equal(lookups, 2);
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
