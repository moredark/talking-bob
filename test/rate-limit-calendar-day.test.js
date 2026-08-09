const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");

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

test("getCalendarDayRange handles a 25-hour DST day", () => {
  const now = new Date("2024-11-03T12:00:00Z");
  const range = getCalendarDayRange("America/New_York", now);

  assert.equal(range.start.toISOString(), "2024-11-03T04:00:00.000Z");
  assert.equal(range.end.toISOString(), "2024-11-04T05:00:00.000Z");
  assert.equal(range.end.getTime() - range.start.getTime(), 25 * 60 * 60 * 1000);
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

test("RateLimitService counts only requests linked to the active persisted window", async () => {
  const queries = [];
  const prisma = {
    quotaWindow: {
      findFirst: async () => ({ id: "window-current" }),
    },
    userRequest: {
      count: async ({ where }) => {
        queries.push(where);
        return 19;
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

  assert.equal(count, 19);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0], {
    userId: "user-1",
    action: "dialog_start",
    quotaWindowId: "window-current",
  });

  const count19Prisma = {
    quotaWindow: { findFirst: async () => ({ id: "window-current" }) },
    userRequest: {
      count: async () => 19,
    },
  };
  const count20Prisma = {
    quotaWindow: { findFirst: async () => ({ id: "window-current" }) },
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
    $queryRaw: async () => [{ timezone: "Europe/Moscow" }],
    quotaWindow: {
      findFirst: async () => ({ id: "window-1" }),
    },
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
  assert.equal(createdActions[0].quotaWindowId, "window-1");
  assert.ok(createdActions[0].createdAt instanceof Date);
  assert.equal(transactionOptions.isolationLevel, "Serializable");
});

function withFixedDate(iso, callback) {
  const RealDate = global.Date;
  const instant = new RealDate(iso);
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [instant.getTime()] : args));
    }
    static now() {
      return instant.getTime();
    }
  };
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      global.Date = RealDate;
    });
}

function createSerializedStore({ timezone = "Europe/Moscow", windows = [], requests = [] } = {}) {
  const state = {
    timezone,
    windows: windows.map((window) => ({ ...window })),
    requests: requests.map((request) => ({ ...request })),
    nextWindow: windows.length + 1,
    nextRequest: requests.length + 1,
  };
  let tail = Promise.resolve();

  const transaction = {
    $queryRaw: async () => [{ timezone: state.timezone }],
    quotaWindow: {
      findFirst: async ({ where }) =>
        state.windows
          .filter(
            (window) =>
              window.userId === where.userId &&
              window.action === where.action &&
              window.windowStart <= where.windowStart.lte &&
              window.windowEnd > where.windowEnd.gt,
          )
          .sort((a, b) => b.windowEnd - a.windowEnd)[0] ?? null,
      create: async ({ data }) => {
        const window = { id: `window-${state.nextWindow++}`, ...data };
        state.windows.push(window);
        return window;
      },
      deleteMany: async ({ where }) => {
        const before = state.windows.length;
        state.windows = state.windows.filter(
          (window) =>
            window.id !== where.id ||
            state.requests.some((request) => request.quotaWindowId === window.id),
        );
        return { count: before - state.windows.length };
      },
    },
    userRequest: {
      count: async ({ where }) =>
        state.requests.filter(
          (request) =>
            request.userId === where.userId &&
            request.action === where.action &&
            (where.quotaWindowId === undefined ||
              request.quotaWindowId === where.quotaWindowId) &&
            (where.createdAt?.gte === undefined || request.createdAt >= where.createdAt.gte),
        ).length,
      create: async ({ data }) => {
        const request = { id: `request-${state.nextRequest++}`, ...data };
        state.requests.push(request);
        return request;
      },
      findUnique: async ({ where, select }) => {
        const request = state.requests.find(({ id }) => id === where.id);
        if (!request) return null;
        return Object.fromEntries(
          Object.keys(select).map((key) => [key, request[key]]),
        );
      },
      deleteMany: async ({ where }) => {
        const before = state.requests.length;
        state.requests = state.requests.filter(({ id }) => id !== where.id);
        return { count: before - state.requests.length };
      },
    },
  };

  const prisma = {
    $transaction: (callback, options) => {
      const run = tail.then(() => callback(transaction));
      tail = run.catch(() => undefined);
      prisma.lastOptions = options;
      return run;
    },
  };
  return { prisma, state };
}

test("parallel rolling-window consumption never exceeds the configured max", async () => {
  await withFixedDate("2026-08-08T12:00:00Z", async () => {
    const { prisma, state } = createSerializedStore();
    const service = new RateLimitService(prisma);

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.consumeLimit("user-1", "command", {
          maxRequests: 5,
          windowMinutes: 10,
        }),
      ),
    );

    assert.equal(results.filter(({ allowed }) => allowed).length, 5);
    assert.equal(state.requests.length, 5);
    assert.equal(prisma.lastOptions.isolationLevel, "Serializable");
  });
});

test("active calendar window is reused after a timezone change", async () => {
  await withFixedDate("2026-08-08T12:00:00Z", async () => {
    const active = {
      id: "window-old-zone",
      userId: "user-1",
      action: "dialog_start",
      timezoneSnapshot: "Europe/Moscow",
      windowStart: new Date("2026-08-07T21:00:00Z"),
      windowEnd: new Date("2026-08-08T21:00:00Z"),
    };
    const { prisma, state } = createSerializedStore({
      timezone: "America/New_York",
      windows: [active],
    });

    const result = await new RateLimitService(prisma).consumeCalendarDayLimit(
      "user-1",
      "dialog_start",
      "America/New_York",
      20,
    );

    assert.equal(result.allowed, true);
    assert.equal(state.windows.length, 1);
    assert.equal(state.requests[0].quotaWindowId, "window-old-zone");
    assert.equal(state.windows[0].timezoneSnapshot, "Europe/Moscow");
  });
});

test("exact window-end boundary creates a new window with the current timezone snapshot", async () => {
  await withFixedDate("2026-08-08T21:00:00Z", async () => {
    const { prisma, state } = createSerializedStore({
      timezone: "America/New_York",
      windows: [
        {
          id: "expired",
          userId: "user-1",
          action: "dialog_start",
          timezoneSnapshot: "Europe/Moscow",
          windowStart: new Date("2026-08-07T21:00:00Z"),
          windowEnd: new Date("2026-08-08T21:00:00Z"),
        },
      ],
    });

    const result = await new RateLimitService(prisma).consumeCalendarDayLimit(
      "user-1",
      "dialog_start",
      "America/New_York",
      1,
    );

    assert.equal(result.allowed, true);
    assert.equal(state.windows.length, 2);
    assert.equal(state.windows[1].timezoneSnapshot, "America/New_York");
    assert.equal(state.requests[0].quotaWindowId, state.windows[1].id);
  });
});

test("concurrent consumption at reset shares one new window and one quota", async () => {
  await withFixedDate("2026-08-08T21:00:00Z", async () => {
    const { prisma, state } = createSerializedStore({
      windows: [
        {
          id: "expired",
          userId: "user-1",
          action: "dialog_start",
          timezoneSnapshot: "Europe/Moscow",
          windowStart: new Date("2026-08-07T21:00:00Z"),
          windowEnd: new Date("2026-08-08T21:00:00Z"),
        },
      ],
    });
    const service = new RateLimitService(prisma);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.consumeCalendarDayLimit(
          "user-1",
          "dialog_start",
          "Europe/Moscow",
          2,
        ),
      ),
    );

    assert.equal(results.filter(({ allowed }) => allowed).length, 2);
    assert.equal(state.windows.length, 2);
    assert.equal(state.requests.length, 2);
    assert.equal(new Set(state.requests.map(({ quotaWindowId }) => quotaWindowId)).size, 1);
  });
});

test("release removes the request and deletes its window only when orphaned", async () => {
  const window = {
    id: "window-1",
    userId: "user-1",
    action: "dialog_start",
    timezoneSnapshot: "Europe/Moscow",
    windowStart: new Date("2026-08-07T21:00:00Z"),
    windowEnd: new Date("2026-08-08T21:00:00Z"),
  };
  const { prisma, state } = createSerializedStore({
    windows: [window],
    requests: [
      { id: "request-1", userId: "user-1", action: "dialog_start", quotaWindowId: "window-1" },
      { id: "request-2", userId: "user-1", action: "dialog_start", quotaWindowId: "window-1" },
    ],
  });
  const service = new RateLimitService(prisma);

  await service.releaseAction("request-1");
  assert.deepEqual(state.requests.map(({ id }) => id), ["request-2"]);
  assert.deepEqual(state.windows.map(({ id }) => id), ["window-1"]);

  await service.releaseAction("request-2");
  assert.equal(state.requests.length, 0);
  assert.equal(state.windows.length, 0);
});

test("serializable P2034 conflicts retry the complete transaction up to success", async () => {
  let attempts = 0;
  const transaction = {
    userRequest: {
      count: async () => 0,
      create: async ({ data }) => ({ id: "request-1", ...data }),
    },
  };
  const prisma = {
    $transaction: async (callback) => {
      attempts += 1;
      if (attempts < 3) {
        throw new Prisma.PrismaClientKnownRequestError("write conflict", {
          code: "P2034",
          clientVersion: "test",
        });
      }
      return callback(transaction);
    },
  };

  const result = await new RateLimitService(prisma).consumeLimit(
    "user-1",
    "command",
    { maxRequests: 1, windowMinutes: 1 },
  );

  assert.equal(attempts, 3);
  assert.deepEqual(result, { allowed: true, requestId: "request-1" });
});

test("calendar count ignores legacy unlinked requests and uses only the current window", async () => {
  const countQueries = [];
  const service = new RateLimitService({
    quotaWindow: {
      findFirst: async () => ({ id: "current-window" }),
    },
    userRequest: {
      count: async ({ where }) => {
        countQueries.push(where);
        return 3;
      },
    },
  });

  assert.equal(
    await service.getCalendarDayActionCount(
      "user-1",
      "dialog_start",
      "Europe/Moscow",
      new Date("2026-08-08T12:00:00Z"),
    ),
    3,
  );
  assert.equal(countQueries[0].quotaWindowId, "current-window");

  const withoutWindow = new RateLimitService({
    quotaWindow: { findFirst: async () => null },
    userRequest: {
      count: async () => {
        throw new Error("legacy rows must not be counted without an active window");
      },
    },
  });
  assert.equal(
    await withoutWindow.getCalendarDayActionCount(
      "user-1",
      "dialog_start",
      "Europe/Moscow",
    ),
    0,
  );
});
