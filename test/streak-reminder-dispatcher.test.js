const assert = require("node:assert/strict");
const test = require("node:test");
const { GrammyError, HttpError } = require("grammy");

const {
  StreakReminderDispatcher,
} = require("../dist/modules/streak/streak-reminder.dispatcher");

const claim = { reminderId: "reminder-1", userId: "user-1", claimToken: "claim-1" };
const attempt = {
  reminderId: "reminder-1",
  claimToken: "claim-1",
  userId: "user-1",
  telegramId: 4242n,
  currentStreak: 7,
  attemptedAt: new Date("2026-08-02T21:00:00.000Z"),
};

function grammyError(errorCode, parameters) {
  return new GrammyError(
    "Telegram rejected request",
    {
      ok: false,
      error_code: errorCode,
      description: "rejected",
      ...(parameters ? { parameters } : {}),
    },
    "sendMessage",
    {},
  );
}

function createSubject(sendMessage = async () => undefined, overrides = {}) {
  const calls = { begin: [], send: [], success: [], retry: [], terminal: [], logs: [] };
  const streak = {
    beginReminderAttempt: async (...args) => {
      calls.begin.push(args);
      return overrides.begin === undefined ? attempt : overrides.begin;
    },
    completeReminderSuccess: async (...args) => {
      calls.success.push(args);
      if (overrides.successError) throw overrides.successError;
      return true;
    },
    completeReminderRetryableFailure: async (...args) => {
      calls.retry.push(args);
      return true;
    },
    completeReminderTerminalFailure: async (...args) => {
      calls.terminal.push(args);
      return true;
    },
  };
  const dispatcher = new StreakReminderDispatcher(streak, {
    capture: async (entry) => calls.logs.push(entry),
  });
  if (!overrides.missingBot) {
    dispatcher.setBot({
      api: {
        sendMessage: async (...args) => {
          calls.send.push(args);
          return sendMessage(...args);
        },
      },
    });
  }
  return { calls, dispatcher };
}

test("streak reminder skips without a bot or without a durable eligible attempt", async () => {
  const missing = createSubject(undefined, { missingBot: true });
  assert.equal(await missing.dispatcher.dispatch(claim), "skipped");
  assert.equal(missing.calls.begin.length, 0);

  const ineligible = createSubject(undefined, { begin: null });
  assert.equal(await ineligible.dispatcher.dispatch(claim), "skipped");
  assert.equal(ineligible.calls.send.length, 0);
});

test("streak reminder success sends once before durable success and never retries persistence failure", async () => {
  let subject;
  subject = createSubject(async () => {
    assert.equal(subject.calls.success.length, 0, "success is not persisted before Telegram I/O");
  });

  assert.equal(await subject.dispatcher.dispatch(claim), "sent");
  assert.deepEqual(subject.calls.send[0], [
    "4242",
    "🔥 Ваш стрик — 7 дней.\n\nЗавершите диалог сегодня до полуночи, иначе стрик пропадёт.",
  ]);
  assert.deepEqual(subject.calls.success, [[attempt]]);

  const failedPersistence = createSubject(undefined, {
    successError: new Error("database unavailable"),
  });
  assert.equal(await failedPersistence.dispatcher.dispatch(claim), "terminal");
  assert.equal(failedPersistence.calls.send.length, 1);
  assert.equal(failedPersistence.calls.retry.length, 0);
  assert.equal(failedPersistence.calls.terminal.length, 0);
  assert.equal(failedPersistence.calls.logs[0].operation, "reminder.persist_success");
  assert.equal(failedPersistence.calls.logs[0].retryable, false);
});

test("429 uses nested retry_after and 5xx are retryable definite failures", async (t) => {
  for (const scenario of [
    { name: "429", error: grammyError(429, { retry_after: 37 }), retryAfter: 37 },
    { name: "5xx", error: grammyError(503), retryAfter: undefined },
  ]) {
    await t.test(scenario.name, async () => {
      const subject = createSubject(async () => { throw scenario.error; });
      assert.equal(await subject.dispatcher.dispatch(claim), "retry");
      assert.equal(subject.calls.retry.length, 1);
      assert.equal(subject.calls.retry[0][0], attempt);
      assert.equal(subject.calls.retry[0][1], `telegram_api_${scenario.error.error_code}`);
      assert.ok(subject.calls.retry[0][2] instanceof Date);
      assert.equal(subject.calls.retry[0][3], scenario.retryAfter);
      assert.equal(subject.calls.terminal.length, 0);
      assert.equal(subject.calls.logs[0].retryable, true);
    });
  }
});

test("permanent 4xx, HttpError, and unknown outcomes are terminal after I/O", async (t) => {
  for (const scenario of [
    { name: "4xx", error: grammyError(400), code: "telegram_api_400" },
    {
      name: "HttpError",
      error: new HttpError("network unavailable", new Error("socket reset")),
      code: "telegram_transport_ambiguous",
    },
    { name: "unknown", error: new Error("unknown send outcome"), code: "Error" },
  ]) {
    await t.test(scenario.name, async () => {
      const subject = createSubject(async () => { throw scenario.error; });
      assert.equal(await subject.dispatcher.dispatch(claim), "terminal");
      assert.deepEqual(subject.calls.terminal, [[attempt, scenario.code]]);
      assert.equal(subject.calls.retry.length, 0);
      assert.equal(subject.calls.logs[0].retryable, false);
    });
  }
});
