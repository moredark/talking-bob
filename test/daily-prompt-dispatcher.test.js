const assert = require("node:assert/strict");
const test = require("node:test");
const { GrammyError, HttpError } = require("grammy");

const {
  DailyPromptDispatcher,
} = require("../dist/modules/schedule/daily-prompt.dispatcher");

const attemptedAt = new Date("2026-08-06T10:00:00.000Z");
const claim = {
  userPromptId: "user-prompt-1",
  claimToken: "11111111-1111-4111-8111-111111111111",
  user: { id: "user-1", telegramId: 123456789n },
  prompt: { id: "prompt-1", topic: "Travel", audioFileId: null },
};

function telegramRejection(method = "sendMessage") {
  return new GrammyError(
    "Telegram rejected request",
    { ok: false, error_code: 400, description: "Bad Request" },
    method,
    {},
  );
}

function createSubject({
  audioFileId = null,
  beginResult = attemptedAt,
  successResult = true,
  successError,
  sendMessage = async () => undefined,
  sendVoice = async () => undefined,
} = {}) {
  const calls = {
    begin: [],
    success: [],
    definite: [],
    ambiguous: [],
    sendMessage: [],
    sendVoice: [],
  };
  const scheduleService = {
    beginDeliveryAttempt: async (...args) => {
      calls.begin.push(args);
      return beginResult;
    },
    completeDeliverySuccess: async (...args) => {
      calls.success.push(args);
      if (successError) throw successError;
      return successResult;
    },
    completeDeliveryDefiniteFailure: async (...args) => {
      calls.definite.push(args);
      return true;
    },
    completeDeliveryAmbiguousFailure: async (...args) => {
      calls.ambiguous.push(args);
      return true;
    },
  };
  const dispatcher = new DailyPromptDispatcher(scheduleService);
  dispatcher.setBot({
    api: {
      sendMessage: async (...args) => {
        calls.sendMessage.push(args);
        return sendMessage(...args);
      },
      sendVoice: async (...args) => {
        calls.sendVoice.push(args);
        return sendVoice(...args);
      },
    },
  });
  return {
    calls,
    dispatcher,
    deliveryClaim: {
      ...claim,
      prompt: { ...claim.prompt, audioFileId },
    },
  };
}

test("text delivery is marked sent only after Telegram succeeds", async () => {
  const { calls, dispatcher, deliveryClaim } = createSubject();

  assert.equal(await dispatcher.dispatch(deliveryClaim), "sent");
  assert.deepEqual(calls.begin, [[deliveryClaim]]);
  assert.deepEqual(calls.success, [[deliveryClaim, attemptedAt]]);
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0][0], "123456789");
  assert.match(calls.sendMessage[0][1], /Travel/);
  assert.equal(calls.definite.length, 0);
  assert.equal(calls.ambiguous.length, 0);
});

test("voice delivery succeeds without text fallback", async () => {
  const { calls, dispatcher, deliveryClaim } = createSubject({
    audioFileId: "telegram-file-id",
  });

  assert.equal(await dispatcher.dispatch(deliveryClaim), "sent");
  assert.equal(calls.sendVoice.length, 1);
  assert.equal(calls.sendVoice[0][0], "123456789");
  assert.equal(calls.sendVoice[0][1], "telegram-file-id");
  assert.equal(calls.sendMessage.length, 0);
  assert.equal(calls.success.length, 1);
});

test("definite voice rejection falls back to text and can still complete sent", async () => {
  const { calls, dispatcher, deliveryClaim } = createSubject({
    audioFileId: "telegram-file-id",
    sendVoice: async () => {
      throw telegramRejection("sendVoice");
    },
  });

  assert.equal(await dispatcher.dispatch(deliveryClaim), "sent");
  assert.equal(calls.sendVoice.length, 1);
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.success.length, 1);
  assert.equal(calls.definite.length, 0);
});

test("final GrammyError is classified as a definite failed delivery", async () => {
  const { calls, dispatcher, deliveryClaim } = createSubject({
    sendMessage: async () => {
      throw telegramRejection();
    },
  });

  assert.equal(await dispatcher.dispatch(deliveryClaim), "failed");
  assert.deepEqual(calls.definite, [[deliveryClaim, attemptedAt]]);
  assert.equal(calls.ambiguous.length, 0);
  assert.equal(calls.success.length, 0);
});

test("HttpError remains pending as an ambiguous transport outcome", async () => {
  const { calls, dispatcher, deliveryClaim } = createSubject({
    sendMessage: async () => {
      throw new HttpError("network unavailable", new Error("socket reset"));
    },
  });

  assert.equal(await dispatcher.dispatch(deliveryClaim), "pending");
  assert.deepEqual(calls.ambiguous, [[deliveryClaim, attemptedAt]]);
  assert.equal(calls.definite.length, 0);
});

test("unknown delivery error remains pending without automatic retry", async () => {
  const { calls, dispatcher, deliveryClaim } = createSubject({
    sendMessage: async () => {
      throw new Error("unknown transport result");
    },
  });

  assert.equal(await dispatcher.dispatch(deliveryClaim), "pending");
  assert.equal(calls.sendMessage.length, 1);
  assert.deepEqual(calls.ambiguous, [[deliveryClaim, attemptedAt]]);
});

test("a lost claim token is not sent to Telegram", async () => {
  const { calls, dispatcher, deliveryClaim } = createSubject({
    beginResult: null,
  });

  assert.equal(await dispatcher.dispatch(deliveryClaim), "not_attempted");
  assert.equal(calls.sendMessage.length, 0);
  assert.equal(calls.sendVoice.length, 0);
  assert.equal(calls.success.length, 0);
  assert.equal(calls.definite.length, 0);
  assert.equal(calls.ambiguous.length, 0);
});

test("successful Telegram send stays pending when durable success loses ownership", async () => {
  const { calls, dispatcher, deliveryClaim } = createSubject({
    successResult: false,
  });

  assert.equal(await dispatcher.dispatch(deliveryClaim), "pending");
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.success.length, 1);
});

test("successful Telegram send stays pending when completion persistence throws", async () => {
  const rawFailure = new Error("database connection secret details");
  const { calls, dispatcher, deliveryClaim } = createSubject({
    successError: rawFailure,
  });

  const outcome = await dispatcher.dispatch(deliveryClaim);

  assert.equal(outcome, "pending");
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.success.length, 1);
  assert.equal(calls.definite.length, 0);
  assert.equal(calls.ambiguous.length, 0);
});
