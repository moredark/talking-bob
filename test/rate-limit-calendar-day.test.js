const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULT_USER_TIMEZONE } = require("../dist/config/limits.config");
const {
  RateLimitService,
  getCalendarDayRange,
} = require("../dist/modules/rate-limit/rate-limit.service");

test("getCalendarDayRange returns exact Moscow UTC boundaries", () => {
  const now = new Date("2024-01-15T13:45:00Z");
  const range = getCalendarDayRange("Europe/Moscow", now);

  assert.equal(range.start.toISOString(), "2024-01-14T21:00:00.000Z");
  assert.equal(range.end.toISOString(), "2024-01-15T21:00:00.000Z");
});

test("getCalendarDayRange handles DST days with correct length", () => {
  const now = new Date("2024-03-10T12:00:00Z");
  const range = getCalendarDayRange("America/New_York", now);

  assert.equal(range.start.toISOString(), "2024-03-10T05:00:00.000Z");
  assert.equal(range.end.toISOString(), "2024-03-11T04:00:00.000Z");
  assert.equal(range.end.getTime() - range.start.getTime(), 23 * 60 * 60 * 1000);
});

test("getCalendarDayRange handles a skipped local midnight", () => {
  const now = new Date("2024-09-08T12:00:00Z");
  const range = getCalendarDayRange("America/Santiago", now);

  assert.equal(range.start.toISOString(), "2024-09-08T04:00:00.000Z");
  assert.equal(range.end.toISOString(), "2024-09-09T03:00:00.000Z");
});

test("getCalendarDayRange falls back to the default timezone for invalid input", () => {
  const now = new Date("2024-01-15T13:45:00Z");
  const fallbackRange = getCalendarDayRange(DEFAULT_USER_TIMEZONE, now);
  const invalidRange = getCalendarDayRange("Not/A_Timezone", now);

  assert.deepEqual(invalidRange, fallbackRange);
});

test("RateLimitService checks calendar-day range with gte and lt and respects the max count", async () => {
  const queries = [];
  const prisma = {
    userRequest: {
      count: async ({ where }) => {
        queries.push(where);
        return 0;
      },
    },
  };
  const service = new RateLimitService(prisma);
  const now = new Date("2024-01-15T13:45:00Z");

  const count = await service.getCalendarDayActionCount(
    "user-1",
    "dialog_start",
    "Europe/Moscow",
    now,
  );

  assert.equal(count, 0);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].userId, "user-1");
  assert.equal(queries[0].action, "dialog_start");
  assert.equal(queries[0].createdAt.gte.toISOString(), "2024-01-14T21:00:00.000Z");
  assert.equal(queries[0].createdAt.lt.toISOString(), "2024-01-15T21:00:00.000Z");

  const count19Prisma = {
    userRequest: {
      count: async () => 19,
    },
  };
  const count20Prisma = {
    userRequest: {
      count: async () => 20,
    },
  };

  assert.equal(
    await new RateLimitService(count19Prisma).checkCalendarDayLimit(
      "user-1",
      "dialog_start",
      "Europe/Moscow",
      20,
    ),
    true,
  );
  assert.equal(
    await new RateLimitService(count20Prisma).checkCalendarDayLimit(
      "user-1",
      "dialog_start",
      "Europe/Moscow",
      20,
    ),
    false,
  );
});

test("RateLimitService consumes a calendar-day slot in a serializable transaction", async () => {
  const createdActions = [];
  let transactionOptions;
  const transaction = {
    userRequest: {
      count: async () => 19,
      create: async ({ data }) => {
        createdActions.push(data);
        return { id: "request-20", ...data };
      },
    },
  };
  const prisma = {
    $transaction: async (callback, options) => {
      transactionOptions = options;
      return callback(transaction);
    },
  };

  const result = await new RateLimitService(prisma).consumeCalendarDayLimit(
    "user-1",
    "dialog_start",
    "Europe/Moscow",
    20,
  );

  assert.deepEqual(result, { allowed: true, requestId: "request-20" });
  assert.equal(createdActions.length, 1);
  assert.equal(createdActions[0].userId, "user-1");
  assert.equal(createdActions[0].action, "dialog_start");
  assert.ok(createdActions[0].createdAt instanceof Date);
  assert.equal(transactionOptions.isolationLevel, "Serializable");
});
