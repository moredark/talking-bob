const assert = require("node:assert/strict");
const test = require("node:test");
const { Module } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { Api, Context } = require("grammy");

const {
  TelegramService,
} = require("../dist/modules/telegram/telegram.service");

test("Nest closes a dependent runtime module before its imported database module", async () => {
  const events = [];
  const DATABASE_LIFECYCLE = Symbol("DATABASE_LIFECYCLE");
  const RUNTIME_LIFECYCLE = Symbol("RUNTIME_LIFECYCLE");

  class DbModule {}
  Module({
    providers: [
      {
        provide: DATABASE_LIFECYCLE,
        useFactory: () => ({
          onModuleDestroy: () => events.push("database"),
        }),
      },
    ],
    exports: [DATABASE_LIFECYCLE],
  })(DbModule);

  class RuntimeModule {}
  Module({
    imports: [DbModule],
    providers: [
      {
        provide: RUNTIME_LIFECYCLE,
        inject: [DATABASE_LIFECYCLE],
        useFactory: (database) => ({
          database,
          onModuleDestroy: () => events.push("runtime"),
        }),
      },
    ],
    exports: [RUNTIME_LIFECYCLE],
  })(RuntimeModule);

  class RootModule {}
  Module({ imports: [RuntimeModule] })(RootModule);

  const application = await NestFactory.createApplicationContext(RootModule, {
    logger: false,
  });
  await application.close();

  assert.deepEqual(events, ["runtime", "database"]);
  assert.equal(typeof TelegramService.prototype.onModuleDestroy, "function");
  assert.equal(TelegramService.prototype.onApplicationShutdown, undefined);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`Timed out waiting for ${description}`);
    }
    await tick();
  }
}

function createFakeBot() {
  const middleware = [];
  const commands = new Map();
  const events = new Map();
  const callbacks = [];

  const addRoute = (predicate, handler) => {
    middleware.push((ctx, next) =>
      predicate(ctx) ? handler(ctx) : next(),
    );
  };

  return {
    commands,
    events,
    callbacks,
    use(handler) {
      middleware.push(handler);
    },
    command(name, handler) {
      commands.set(name, handler);
      addRoute((ctx) => ctx.command === name, handler);
    },
    on(name, handler) {
      events.set(name, handler);
      addRoute(
        (ctx) => name === "message:voice" && Boolean(ctx.update.message?.voice),
        handler,
      );
    },
    callbackQuery(pattern, handler) {
      callbacks.push({ pattern, handler });
      addRoute((ctx) => {
        const data = ctx.callbackQuery?.data;
        return typeof pattern === "string"
          ? data === pattern
          : typeof data === "string" && pattern.test(data);
      }, handler);
    },
    catch() {},
    dispatch(ctx) {
      let index = -1;
      const next = (nextIndex) => {
        assert.ok(nextIndex > index, "next() must advance the middleware chain");
        index = nextIndex;
        const handler = middleware[nextIndex];
        if (!handler) return Promise.resolve();
        return Promise.resolve(handler(ctx, () => next(nextIndex + 1)));
      };
      return next(0);
    },
  };
}

function voiceContext(chatId, updateId, gate) {
  return {
    chat: { id: chatId },
    from: { id: chatId },
    update: { update_id: updateId, message: { voice: {} } },
    gate,
  };
}

function callbackContext(chatId, updateId, data = "report") {
  return {
    chat: { id: chatId },
    from: { id: chatId },
    update: { update_id: updateId, callback_query: { data } },
    callbackQuery: { data },
    answerCallbackQuery: async () => undefined,
  };
}

function createBareService({
  startHandle,
  startNewQuestionHandle,
  voiceHandle,
  reportHandle,
  settingsHandle,
  drainTimeoutMs = 1_000,
  telegramUpdates = 4,
  aiRequestLimiter,
} = {}) {
  return new TelegramService(
    {
      handle: startHandle || (async () => undefined),
      handleNewQuestion: startNewQuestionHandle || (async () => undefined),
    },
    { handle: voiceHandle || (async () => undefined) },
    { handle: reportHandle || (async () => undefined) },
    {
      handle: settingsHandle || (async () => undefined),
      handleToggle: async () => undefined,
      handleTimeSelect: async () => undefined,
      handleToneSelect: async () => undefined,
    },
    { setBot() {} },
    {
      telegramBotToken: "123456:test-token",
      telegram: { apiTimeoutMs: 5_000 },
      concurrency: {
        telegramUpdates,
        aiRequests: 2,
        aiRequestMaxPending: 8,
      },
      shutdown: { drainTimeoutMs },
    },
    aiRequestLimiter,
  );
}

function createService(options = {}) {
  const fakeBot = createFakeBot();
  const service = createBareService(options);
  service.bot = fakeBot;
  service.registerHandlers();
  return { fakeBot, service };
}

test("callback ACK starts before same-chat serialization and failure does not cancel business work", async () => {
  const voiceGate = deferred();
  const events = [];
  const { fakeBot } = createService({
    voiceHandle: async () => {
      events.push("voice:start");
      await voiceGate.promise;
      events.push("voice:end");
    },
    reportHandle: async () => events.push("handler"),
  });

  const voice = fakeBot.dispatch(voiceContext(1, 1, "slow"));
  await tick();

  const ctx = callbackContext(1, 2);
  ctx.answerCallbackQuery = async () => {
    events.push("answer");
    throw new Error("callback already answered");
  };
  const callback = fakeBot.dispatch(ctx);
  assert.equal(typeof callback.then, "function");
  await tick();
  assert.deepEqual(events, ["voice:start", "answer"]);

  voiceGate.resolve();
  await Promise.all([voice, callback]);
  assert.deepEqual(events, ["voice:start", "answer", "voice:end", "handler"]);
});

test("registered middleware preserves same-chat FIFO while different chats run concurrently", async () => {
  const gates = { a1: deferred(), a2: deferred(), b1: deferred() };
  const events = [];
  let active = 0;
  let peak = 0;
  const { fakeBot } = createService({
    voiceHandle: async (ctx) => {
      events.push(`${ctx.gate}:start`);
      active += 1;
      peak = Math.max(peak, active);
      await gates[ctx.gate].promise;
      active -= 1;
      events.push(`${ctx.gate}:end`);
    },
  });

  const a1 = fakeBot.dispatch(voiceContext(1, 1, "a1"));
  const a2 = fakeBot.dispatch(voiceContext(1, 2, "a2"));
  const b1 = fakeBot.dispatch(voiceContext(2, 3, "b1"));
  assert.equal(typeof a1.then, "function");
  assert.equal(typeof a2.then, "function");
  assert.equal(typeof b1.then, "function");
  await tick();

  assert.deepEqual(events, ["a1:start", "b1:start"]);
  assert.equal(active, 2);
  assert.equal(peak, 2);

  gates.b1.resolve();
  await b1;
  assert.equal(events.includes("a2:start"), false);

  gates.a1.resolve();
  await tick();
  assert.ok(events.indexOf("a1:end") < events.indexOf("a2:start"));

  gates.a2.resolve();
  await Promise.all([a1, a2]);
  assert.equal(active, 0);
  assert.equal(peak, 2);
});

test("registered command, event, and callback handlers return business promises", async () => {
  const { fakeBot } = createService();
  const promises = [
    fakeBot.commands.get("start")({}),
    fakeBot.events.get("message:voice")({}),
    fakeBot.callbacks.find(({ pattern }) => pattern === "report").handler({}),
  ];

  for (const promise of promises) assert.equal(typeof promise.then, "function");
  await Promise.all(promises);
});

test("new question callback returns the dedicated handler promise", async () => {
  const gate = deferred();
  const calls = [];
  const { fakeBot } = createService({
    startHandle: async () => calls.push("start"),
    startNewQuestionHandle: async () => {
      calls.push("new-question:start");
      await gate.promise;
      calls.push("new-question:end");
    },
  });

  const handling = fakeBot.callbacks
    .find(({ pattern }) => pattern === "new_question")
    .handler({});
  assert.equal(typeof handling.then, "function");
  await tick();
  assert.deepEqual(calls, ["new-question:start"]);

  gate.resolve();
  await handling;
  assert.deepEqual(calls, ["new-question:start", "new-question:end"]);
});

test("TelegramService caps the real runner initial poll at configured concurrency", async () => {
  const requests = [];
  const { fakeBot, service } = createService({ telegramUpdates: 3 });
  fakeBot.api = {
    setMyCommands: async () => undefined,
    getUpdates: async (args, signal) => {
      requests.push(args);
      if (requests.length === 1) return [];
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  fakeBot.init = async () => undefined;
  fakeBot.handleUpdate = async () => undefined;
  fakeBot.errorHandler = async () => undefined;

  await service.launchRunner();
  await waitFor(() => requests.length >= 2, "the runner's second poll");

  assert.equal(requests[0].limit, 3);
  assert.equal(requests[1].limit, 3);
  await service.onModuleDestroy();
});

test("Telegram lifecycle follows startup, restart wait, and shutdown transitions", async () => {
  const initGate = deferred();
  const requests = [];
  const { fakeBot, service } = createService({ telegramUpdates: 2 });
  fakeBot.api = {
    setMyCommands: async () => undefined,
    getUpdates: async (args, signal) => {
      requests.push(args);
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  fakeBot.init = () => initGate.promise;
  fakeBot.handleUpdate = async () => undefined;
  fakeBot.errorHandler = async () => undefined;

  assert.equal(service.getLifecycleState(), "starting");
  service.startRunner();
  await tick();
  assert.equal(service.getLifecycleState(), "starting");

  initGate.resolve();
  await waitFor(
    () => service.getLifecycleState() === "running" && requests.length > 0,
    "the Telegram runner to enter running state",
  );
  assert.equal(requests[0].limit, 2);

  const shutdown = service.onModuleDestroy();
  assert.equal(service.getLifecycleState(), "shutting_down");
  await shutdown;
  assert.equal(service.getLifecycleState(), "stopped");

  const failed = createBareService();
  failed.getBot().api.setMyCommands = async () => {
    throw new Error("Telegram startup failed: bot-token-must-not-leak");
  };
  failed.startRunner();
  await waitFor(
    () => failed.getLifecycleState() === "restart_wait",
    "the first failed startup to schedule a restart",
  );
  assert.notEqual(failed.botStartRetryTimer, undefined);
  await failed.onModuleDestroy();
  assert.equal(failed.getLifecycleState(), "stopped");
});

test("TelegramService drains all middleware accepted by the real runner before shutdown", async () => {
  const gates = new Map([
    [1, deferred()],
    [2, deferred()],
  ]);
  const started = [];
  let polls = 0;
  const { fakeBot, service } = createService({
    telegramUpdates: 2,
    voiceHandle: async (ctx) => {
      const updateId = ctx.update.update_id;
      started.push(updateId);
      await gates.get(updateId).promise;
    },
  });
  fakeBot.api = {
    setMyCommands: async () => undefined,
    getUpdates: async (_args, signal) => {
      polls += 1;
      if (polls === 1) {
        return [
          { update_id: 1, message: { voice: {} } },
          { update_id: 2, message: { voice: {} } },
        ];
      }
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  fakeBot.init = async () => undefined;
  fakeBot.errorHandler = async () => undefined;
  fakeBot.handleUpdate = (update) =>
    fakeBot.dispatch({
      chat: { id: update.update_id },
      from: { id: update.update_id },
      update,
    });

  await service.launchRunner();
  await waitFor(() => started.length === 2, "both accepted middleware tasks");

  let shutdownSettled = false;
  const shutdown = service.onModuleDestroy().then(() => {
    shutdownSettled = true;
  });
  gates.get(1).resolve();
  await tick();
  assert.equal(shutdownSettled, false);

  gates.get(2).resolve();
  await shutdown;
  assert.equal(service.telegramBusinessTasks.size, 0);
});

test("shared Telegram API transformer blocks dispatcher-like calls after shutdown", async () => {
  const service = createBareService();
  const [guard] = service.getBot().api.config.installedTransformers();
  let apiCalls = 0;
  service.telegramApiClosed = true;

  await assert.rejects(
    guard(
      async () => {
        apiCalls += 1;
        return { ok: true, result: true };
      },
      "sendMessage",
      { chat_id: 1, text: "late dispatcher reply" },
    ),
    { name: "TelegramRuntimeClosedError" },
  );
  assert.equal(apiCalls, 0);
});

test("absolute deadline closes Telegram API before its timeout callback runs", async () => {
  const service = createBareService();
  const [guard] = service.getBot().api.config.installedTransformers();
  const deadline = Date.now();
  const never = new Promise(() => undefined);
  let apiCalls = 0;
  service.shutdownDeadline = deadline;
  service.telegramApiClosed = false;

  const deadlineTimer = service.waitUntilDeadline(never, deadline);
  assert.equal(service.telegramApiClosed, false);
  await assert.rejects(
    guard(
      async () => {
        apiCalls += 1;
        return { ok: true, result: true };
      },
      "sendMessage",
      { chat_id: 1, text: "deadline race" },
    ),
    { name: "TelegramRuntimeClosedError" },
  );

  assert.equal(apiCalls, 0);
  assert.equal(service.telegramApiClosed, true);
  assert.equal(await deadlineTimer, false);
});

test("real Context.reply uses the shared shutdown transformer", async () => {
  const service = createBareService();
  const [guard] = service.getBot().api.config.installedTransformers();
  const calls = [];
  const api = new Api("123456:test-token");
  api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    return {
      ok: true,
      result: {
        message_id: 2,
        date: 0,
        chat: { id: 1, type: "private" },
        text: payload.text,
      },
    };
  });
  api.config.use(guard);
  const user = { id: 1, is_bot: false, first_name: "Test" };
  const ctx = new Context(
    {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: "private" },
        from: user,
        text: "hello",
      },
    },
    api,
    { id: 2, is_bot: true, first_name: "Bob", username: "talking_bob" },
  );

  await ctx.reply("before deadline");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");

  service.shutdownDeadline = Date.now() - 1;
  await assert.rejects(ctx.reply("after deadline"), {
    name: "TelegramRuntimeClosedError",
  });
  assert.equal(calls.length, 1);
});

test("shutdown uses one absolute deadline for stuck startup and runner stop and cannot restart", async () => {
  const startup = deferred();
  const never = new Promise(() => undefined);
  let stopCalls = 0;
  const { service } = createService({ drainTimeoutMs: 100 });
  service.startupPromise = startup.promise;
  service.runner = {
    isRunning: () => true,
    size: () => 1,
    stop: () => {
      stopCalls += 1;
      return never;
    },
    task: () => never,
  };
  service.runnerTask = never;

  const startedAt = Date.now();
  const shutdown = service.onModuleDestroy();
  setTimeout(() => startup.resolve(), 10);
  await shutdown;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(stopCalls, 1);
  assert.ok(elapsedMs < 300, `shutdown exceeded one deadline: ${elapsedMs}ms`);
  assert.equal(service.shuttingDown, true);

  service.scheduleRunnerRestart();
  assert.equal(service.botStartRetryTimer, undefined);
});
