const assert = require("node:assert/strict");
const test = require("node:test");

const {
  StartHandler,
} = require("../dist/modules/telegram/handlers/start.handler");

const user = {
  id: "user-1",
  telegramId: 123n,
  timezone: "Europe/Moscow",
};
const prompt = {
  id: "prompt-1",
  topic: "Introduce yourself",
  audioFileId: null,
};
const claim = {
  userPromptId: "user-prompt-1",
  claimToken: "claim-token",
  user: { id: user.id, telegramId: user.telegramId },
  prompt,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSubject({
  hasActivePrompt = true,
  admission = { allowed: true, requestId: "request-1" },
  createClaim = async () => claim,
  dispatch = async () => "sent",
} = {}) {
  const calls = {
    quota: [],
    release: [],
    createClaim: [],
    dispatch: [],
    replies: [],
  };
  const handler = new StartHandler(
    {
      findOrCreateByTelegramId: async () => user,
    },
    {
      consumeCalendarDayLimit: async (...args) => {
        calls.quota.push(args);
        return admission;
      },
      releaseAction: async (...args) => calls.release.push(args),
    },
    {
      hasActivePrompt: async () => hasActivePrompt,
    },
    {
      createManualClaim: async (...args) => {
        calls.createClaim.push(args);
        return createClaim(...args);
      },
    },
    {
      dispatch: async (...args) => {
        calls.dispatch.push(args);
        return dispatch(...args);
      },
    },
  );
  const context = {
    from: { id: 123, username: "alice" },
    reply: async (message) => calls.replies.push(message),
  };
  return { calls, context, handler };
}

function createCallbackContext() {
  const replies = [];
  return {
    ctx: {
      from: { id: 123, username: "alice" },
      callbackQuery: { id: "cb-1", data: "new_question" },
      reply: async (message) => replies.push(message),
    },
    replies,
  };
}

test("does not consume quota or create a claim when no prompt is available", async () => {
  const { calls, context, handler } = createSubject({
    hasActivePrompt: false,
  });

  await handler.handle(context);

  assert.equal(calls.quota.length, 0);
  assert.equal(calls.createClaim.length, 0);
  assert.equal(calls.dispatch.length, 0);
  assert.deepEqual(calls.replies, ["К сожалению, сейчас нет доступных вопросов."]);
});

test("rejects the 21st dialog without creating or dispatching a claim", async () => {
  const { calls, context, handler } = createSubject({
    admission: { allowed: false },
  });

  await handler.handle(context);

  assert.equal(calls.release.length, 0);
  assert.equal(calls.createClaim.length, 0);
  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0], /20/);
  assert.match(calls.replies[0], /завтра/);
});

test("releases quota only when manual claim persistence fails", async () => {
  const failure = new Error("database unavailable");
  const { calls, context, handler } = createSubject({
    createClaim: async () => {
      throw failure;
    },
  });

  await assert.rejects(handler.handle(context), failure);
  assert.deepEqual(calls.release, [["request-1"]]);
  assert.equal(calls.dispatch.length, 0);
});

test("releases quota when the atomic manual claim finds no prompt", async () => {
  const { calls, context, handler } = createSubject({
    createClaim: async () => null,
  });

  await handler.handleNewQuestion(context);

  assert.deepEqual(calls.quota, [
    ["user-1", "dialog_start", "Europe/Moscow", 20],
  ]);
  assert.deepEqual(calls.createClaim, [[user]]);
  assert.deepEqual(calls.release, [["request-1"]]);
  assert.equal(calls.dispatch.length, 0);
  assert.deepEqual(calls.replies, ["К сожалению, сейчас нет доступных вопросов."]);
});

test("does not release quota after a persisted claim when dispatch fails", async () => {
  const failure = new Error("Telegram unavailable");
  const { calls, context, handler } = createSubject({
    dispatch: async () => {
      throw failure;
    },
  });

  await assert.rejects(handler.handle(context), failure);
  assert.equal(calls.createClaim.length, 1);
  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.release.length, 0);
});

test("creates a manual claim and awaits dispatch without scheduling a timer", async () => {
  const gate = deferred();
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = () => {
    throw new Error("StartHandler must not schedule detached timers");
  };
  const { calls, context, handler } = createSubject({
    dispatch: async () => {
      await gate.promise;
      return "sent";
    },
  });

  let finished = false;
  try {
    const handling = handler.handle(context).then(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(finished, false);
    assert.deepEqual(calls.quota, [
      ["user-1", "dialog_start", "Europe/Moscow", 20],
    ]);
    assert.deepEqual(calls.createClaim, [[user]]);
    assert.deepEqual(calls.dispatch, [[claim]]);
    assert.equal(calls.replies.length, 1);
    assert.match(calls.replies[0], /Сейчас пришлю/);
    assert.equal(calls.release.length, 0);

    gate.resolve();
    await handling;
    assert.equal(finished, true);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("new question skips welcome text but still creates a claim", async () => {
  const { replies, ctx } = createCallbackContext();
  const calls = {
    quota: [],
    release: [],
    createClaim: [],
    dispatch: [],
  };
  const handler = new StartHandler(
    {
      findOrCreateByTelegramId: async () => user,
    },
    {
      consumeCalendarDayLimit: async (...args) => {
        calls.quota.push(args);
        return { allowed: true, requestId: "request-1" };
      },
      releaseAction: async (...args) => calls.release.push(args),
    },
    {
      hasActivePrompt: async () => true,
    },
    {
      createManualClaim: async (...args) => {
        calls.createClaim.push(args);
        return claim;
      },
    },
    {
      dispatch: async (...args) => {
        calls.dispatch.push(args);
        return "sent";
      },
    },
  );

  await handler.handleNewQuestion(ctx);

  assert.deepEqual(replies, []);
  assert.deepEqual(calls.quota, [["user-1", "dialog_start", "Europe/Moscow", 20]]);
  assert.deepEqual(calls.createClaim, [[user]]);
  assert.deepEqual(calls.dispatch, [[claim]]);
});
