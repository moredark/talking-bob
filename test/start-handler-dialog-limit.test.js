const assert = require("node:assert/strict");
const test = require("node:test");

const {
  StartHandler,
} = require("../dist/modules/telegram/handlers/start.handler");

function createContext() {
  const replies = [];

  return {
    context: {
      from: { id: 123, username: "alice" },
      reply: async (message) => {
        replies.push(message);
      },
    },
    replies,
  };
}

function createUserService() {
  return {
    findOrCreateByTelegramId: async () => ({
      id: "user-1",
      timezone: "Europe/Moscow",
    }),
  };
}

test("StartHandler does not consume the quota when no prompt is available", async () => {
  const { context, replies } = createContext();
  let limitChecks = 0;
  let recordedActions = 0;
  const handler = new StartHandler(
    createUserService(),
    {
      consumeCalendarDayLimit: async () => {
        limitChecks += 1;
        return { allowed: true, requestId: "request-1" };
      },
      releaseAction: async () => {
        recordedActions += 1;
      },
    },
    { getRandomActivePrompt: async () => null },
  );

  await handler.handle(context);

  assert.equal(limitChecks, 0);
  assert.equal(recordedActions, 0);
  assert.deepEqual(replies, ["К сожалению, сейчас нет доступных вопросов."]);
});

test("StartHandler rejects the 21st dialog without recording or scheduling it", async () => {
  const { context, replies } = createContext();
  let recordedActions = 0;
  let promptRecords = 0;
  const handler = new StartHandler(
    createUserService(),
    {
      consumeCalendarDayLimit: async () => ({ allowed: false }),
      releaseAction: async () => {
        recordedActions += 1;
      },
    },
    {
      getRandomActivePrompt: async () => ({ id: "prompt-1" }),
      recordPromptSent: async () => {
        promptRecords += 1;
      },
    },
  );

  await handler.handle(context);

  assert.equal(recordedActions, 0);
  assert.equal(promptRecords, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /20/);
  assert.match(replies[0], /завтра/);
});

test("StartHandler releases the quota when session persistence fails", async () => {
  const { context } = createContext();
  const releasedRequests = [];
  const handler = new StartHandler(
    createUserService(),
    {
      consumeCalendarDayLimit: async () => ({
        allowed: true,
        requestId: "request-1",
      }),
      releaseAction: async (requestId) => {
        releasedRequests.push(requestId);
      },
    },
    {
      getRandomActivePrompt: async () => ({ id: "prompt-1" }),
      recordPromptSent: async () => {
        throw new Error("database unavailable");
      },
    },
  );

  await assert.rejects(handler.handle(context), /database unavailable/);
  assert.deepEqual(releasedRequests, ["request-1"]);
});

test("StartHandler records an allowed dialog and schedules its prompt", async () => {
  const { context, replies } = createContext();
  const actions = [];
  const promptRecords = [];
  const originalSetTimeout = global.setTimeout;
  let scheduledDelay;

  global.setTimeout = (callback, delay) => {
    scheduledDelay = delay;
    callback();
    return 1;
  };

  try {
    const handler = new StartHandler(
      createUserService(),
      {
        consumeCalendarDayLimit: async (
          userId,
          action,
          timeZone,
          maxRequests,
        ) => {
          assert.equal(userId, "user-1");
          assert.equal(action, "dialog_start");
          assert.equal(timeZone, "Europe/Moscow");
          assert.equal(maxRequests, 20);
          return { allowed: true, requestId: "request-1" };
        },
        releaseAction: async (requestId) => {
          actions.push({ requestId, released: true });
        },
      },
      {
        getRandomActivePrompt: async () => ({
          id: "prompt-1",
          topic: "Introduce yourself",
          audioFileId: null,
        }),
        recordPromptSent: async (userId, promptId) => {
          promptRecords.push({ userId, promptId });
        },
      },
    );

    await handler.handle(context);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(actions, []);
    assert.deepEqual(promptRecords, [
      { userId: "user-1", promptId: "prompt-1" },
    ]);
    assert.equal(scheduledDelay, 5000);
    assert.equal(replies.length, 2);
    assert.match(replies[1], /Introduce yourself/);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
