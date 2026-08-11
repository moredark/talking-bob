const assert = require("node:assert/strict");
const test = require("node:test");
const { GrammyError, HttpError } = require("grammy");
const { ReportHandler } = require("../dist/modules/telegram/handlers/report.handler");
const { ObservabilityContextService } = require("../dist/modules/error-log");

const feedback = {
  summary: "Good answer.",
  improvementPoints: ["Use a more specific verb."],
  overallScore: 8,
  version: 1,
  kind: "model",
};

function generationClaim(id = "response-1") {
  return {
    responseId: id,
    userId: "user-1",
    userPromptId: "user-prompt-1",
    claimToken: `generation-${id}`,
    claimExpiresAt: new Date("2026-08-08T10:00:00.000Z"),
  };
}

function deliveryClaim(chunks, requestId = "delivery-1", nextChunkIndex = 0) {
  return {
    requestId,
    claimToken: `delivery-token-${nextChunkIndex}`,
    claimExpiresAt: new Date("2026-08-08T10:00:00.000Z"),
    nextChunkIndex,
    chunks,
  };
}

function telegramRejection() {
  return new GrammyError(
    "Telegram rejected request",
    { ok: false, error_code: 400, description: "Bad Request" },
    "sendMessage",
    {},
  );
}

function context(messageId = 10, replyImpl) {
  const replies = [];
  return {
    replies,
    ctx: {
      from: { id: 123 },
      chat: { id: 123 },
      message: { message_id: messageId, chat: { id: 123 } },
      update: { update_id: messageId },
      api: { sendChatAction: async () => undefined },
      reply: async (...args) => {
        replies.push(args);
        if (replyImpl) return replyImpl(...args);
      },
    },
  };
}

function createSubject({ claimResult, response = {}, llm = {}, messages, observability } = {}) {
  const calls = {
    claim: [], completeGeneration: [], createDelivery: [], begin: [],
    completeChunk: [], failGeneration: [], definite: [], ambiguous: [], llm: [],
  };
  const responseService = {
    claimGeneration: async (data) => {
      calls.claim.push(data);
      return claimResult ?? { outcome: "claimed", claim: generationClaim() };
    },
    completeGeneration: async (data) => {
      calls.completeGeneration.push(data);
      if (response.completeGeneration) return response.completeGeneration(data);
      return { outcome: "claimed", claim: deliveryClaim(data.chunks) };
    },
    failGeneration: async (...args) => {
      calls.failGeneration.push(args);
      return true;
    },
    createOrClaimDeliveryRequest: async (...args) => {
      calls.createDelivery.push(args);
      if (response.createOrClaimDeliveryRequest) return response.createOrClaimDeliveryRequest(...args);
      return { outcome: "claimed", claim: deliveryClaim(args[2]) };
    },
    beginDeliveryChunk: async (...args) => {
      calls.begin.push(args);
      if (response.beginDeliveryChunk) return response.beginDeliveryChunk(...args);
      const index = Number(args[1].split("-").at(-1));
      return {
        outcome: "begun",
        chunk: response.activeChunks[index],
        chunkIndex: index,
        attemptedAt: new Date(`2026-08-08T10:00:0${index}.000Z`),
      };
    },
    completeDeliveryChunk: async (...args) => {
      calls.completeChunk.push(args);
      if (response.completeDeliveryChunk) return response.completeDeliveryChunk(...args);
      const next = args[1] + 1;
      return next === response.activeChunks.length
        ? { outcome: "delivered", request: { id: args[0] } }
        : { outcome: "claimed_next", claim: deliveryClaim(response.activeChunks, args[0], next) };
    },
    failDeliveryDefinite: async (...args) => {
      calls.definite.push(args);
      return true;
    },
    failDeliveryAmbiguous: async (...args) => {
      calls.ambiguous.push(args);
      return true;
    },
  };
  const handler = new ReportHandler(
    { findByTelegramId: async () => ({ id: "user-1", agentTone: "friendly" }) },
    {
      getLatestUserPrompt: async () => ({ id: "user-prompt-1", promptId: "prompt-1" }),
      getPromptById: async () => ({ id: "prompt-1", topic: "Travel" }),
    },
    responseService,
    {
      getMessages: async () => messages ?? [
        { role: "user", content: "I visited Rome", voiceFileId: "voice-1" },
      ],
    },
    { consumeLimit: async () => ({ allowed: true, requestId: "request-1" }) },
    {
      analyzeSpeech: async (...args) => {
        calls.llm.push(args);
        return llm.analyzeSpeech ? llm.analyzeSpeech(...args) : feedback;
      },
    },
    undefined,
    observability,
  );
  return { calls, handler };
}


test("report AI trace inherits the active update correlation", async () => {
  const observability = new ObservabilityContextService();
  const response = { activeChunks: [] };
  const { calls, handler } = createSubject({ response, observability });
  response.completeGeneration = async (data) => { response.activeChunks = data.chunks; return { outcome: "claimed", claim: deliveryClaim(data.chunks) }; };
  const { ctx } = context();
  await observability.run({ correlationId: "tg-report-10" }, () => handler.handle(ctx));
  assert.deepEqual(calls.llm[0][4], {
    userId: "user-1", userPromptId: "user-prompt-1", userResponseId: "response-1",
    requestId: "response-1", correlationId: "tg-report-10",
  });
});
test("ReportHandler manual claim generates and persists once, then delivers plain chunks with only a final keyboard", async () => {
  const longFeedback = { ...feedback, summary: `${"clear explanation ".repeat(270)}done` };
  const response = { activeChunks: [] };
  const { calls, handler } = createSubject({
    response,
    llm: { analyzeSpeech: async () => longFeedback },
  });
  response.completeGeneration = async (data) => {
    response.activeChunks = data.chunks;
    return { outcome: "claimed", claim: deliveryClaim(data.chunks) };
  };
  const { ctx, replies } = context();

  await handler.handle(ctx);

  assert.equal(calls.llm.length, 1);
  assert.equal(calls.completeGeneration.length, 1);
  assert.equal(calls.completeGeneration[0].transcript, "I visited Rome");
  assert.equal(calls.completeGeneration[0].analysis, JSON.stringify(longFeedback));
  assert.equal(calls.completeGeneration[0].analysisVersion, 1);
  assert.equal(calls.completeGeneration[0].analysisKind, "model");
  assert.equal(calls.completeGeneration[0].overallScore, 8);
  assert.ok(calls.completeGeneration[0].chunks.length > 1);
  assert.deepEqual(replies.map(([text]) => text), calls.completeGeneration[0].chunks);
  for (const [, options] of replies) assert.equal(options?.parse_mode, undefined);
  assert.equal(replies.slice(0, -1).every(([, options]) => options === undefined), true);
  assert.equal(replies.at(-1)[1].reply_markup.inline_keyboard[0][0].callback_data, "new_question");
});

test("ReportHandler resends generated persisted output without invoking the LLM", async () => {
  const response = { activeChunks: [] };
  response.createOrClaimDeliveryRequest = async (_id, _key, chunks) => {
    response.activeChunks = chunks;
    return { outcome: "claimed", claim: deliveryClaim(chunks) };
  };
  const { calls, handler } = createSubject({
    claimResult: {
      outcome: "generated",
      response: {
        id: "response-saved",
        transcript: "Persisted transcript",
        analysis: JSON.stringify({ ...feedback, kind: "fallback" }),
      },
    },
    response,
  });
  const { ctx, replies } = context(11);

  await handler.handle(ctx);

  assert.equal(calls.llm.length, 0);
  assert.equal(calls.completeGeneration.length, 0);
  assert.equal(calls.createDelivery.length, 1);
  assert.equal(calls.createDelivery[0][0], "response-saved");
  assert.equal(calls.createDelivery[0][1], "message:123:11");
  assert.match(replies[0][0], /Persisted transcript/);
  assert.match(replies[0][0], /базовый автоматический отчёт/i);
});

test("ReportHandler explains when a generated report expired under data retention", async () => {
  const { calls, handler } = createSubject({
    claimResult: {
      outcome: "generated",
      response: {
        id: "response-purged",
        transcript: null,
        analysis: null,
        sensitiveDataPurgedAt: new Date("2026-08-08T10:00:00.000Z"),
      },
    },
  });
  const { ctx, replies } = context(12);

  await handler.handle(ctx);

  assert.equal(calls.llm.length, 0);
  assert.equal(calls.createDelivery.length, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0][0], /сроку хранения/i);
  assert.match(replies[0][0], /\/start/);
});

test("ReportHandler duplicate request states do not duplicate report delivery", async (t) => {
  await t.test("busy generation", async () => {
    const { calls, handler } = createSubject({
      claimResult: { outcome: "busy", response: { id: "response-1" } },
    });
    const { ctx, replies } = context();
    await handler.handle(ctx);
    assert.equal(calls.llm.length, 0);
    assert.equal(calls.createDelivery.length, 0);
    assert.equal(calls.begin.length, 0);
    assert.equal(replies.length, 1);
    assert.match(replies[0][0], /уже формируется/i);
  });

  await t.test("already delivered saved request", async () => {
    const { calls, handler } = createSubject({
      claimResult: {
        outcome: "generated",
        response: { id: "response-1", transcript: "Saved", analysis: JSON.stringify(feedback) },
      },
      response: {
        createOrClaimDeliveryRequest: async () => ({
          outcome: "delivered",
          request: { id: "delivery-1" },
        }),
      },
    });
    const { ctx, replies } = context();
    await handler.handle(ctx);
    assert.equal(calls.llm.length, 0);
    assert.equal(calls.begin.length, 0);
    assert.equal(replies.length, 0);
  });

  await t.test("failed duplicate explains how to create a new request", async () => {
    const { calls, handler } = createSubject({
      claimResult: { outcome: "failed_same_request", response: { id: "response-1" } },
    });
    const { ctx, replies } = context();
    await handler.handle(ctx);
    assert.equal(calls.llm.length, 0);
    assert.equal(calls.createDelivery.length, 0);
    assert.match(replies[0][0], /новую команду \/report/i);
  });
});

test("ReportHandler does not reclassify post-send persistence failure as generation failure", async () => {
  const response = {
    activeChunks: ["one chunk"],
    completeDeliveryChunk: async () => {
      throw new Error("database unavailable");
    },
  };
  const { calls, handler } = createSubject({ response });
  response.completeGeneration = async (data) => ({
    outcome: "claimed",
    claim: deliveryClaim(data.chunks),
  });
  const { ctx, replies } = context();

  await handler.handle(ctx);

  assert.equal(replies.length, 1);
  assert.equal(calls.failGeneration.length, 0);
});

test("ReportHandler serializes parallel auto generation and manual report through lifecycle outcomes", async () => {
  let signalAnalysisStarted;
  const analysisStarted = new Promise((resolve) => { signalAnalysisStarted = resolve; });
  let continueAnalysis;
  const analysisGate = new Promise((resolve) => { continueAnalysis = resolve; });
  const response = { activeChunks: [] };
  const { calls, handler } = createSubject({
    claimResult: { outcome: "busy", response: { id: "response-auto" } },
    response,
    llm: {
      analyzeSpeech: async () => {
        signalAnalysisStarted();
        await analysisGate;
        return feedback;
      },
    },
  });
  response.completeGeneration = async (data) => {
    response.activeChunks = data.chunks;
    return { outcome: "claimed", claim: deliveryClaim(data.chunks, "auto-delivery") };
  };
  const autoContext = context(20);
  const manualContext = context(21);
  const auto = handler.generateClaimedReport(
    autoContext.ctx, "user-prompt-1", "Travel", "friendly", generationClaim("response-auto"),
  );
  await analysisStarted;
  await handler.handle(manualContext.ctx);
  continueAnalysis();
  await auto;

  assert.equal(calls.llm.length, 1);
  assert.equal(calls.completeGeneration.length, 1);
  assert.equal(calls.claim.length, 1);
  assert.equal(manualContext.replies.length, 1);
  assert.match(manualContext.replies[0][0], /уже формируется/i);
  assert.equal(autoContext.replies.length, 1);
});

test("ReportHandler records GrammyError as definite and HttpError as ambiguous delivery", async (t) => {
  for (const scenario of [
    { name: "GrammyError", error: telegramRejection(), field: "definite" },
    { name: "HttpError", error: new HttpError("network unavailable", new Error("socket reset")), field: "ambiguous" },
  ]) {
    await t.test(scenario.name, async () => {
      const attemptedAt = new Date("2026-08-08T12:00:00.000Z");
      const { calls, handler } = createSubject({
        response: {
          beginDeliveryChunk: async () => ({
            outcome: "begun", chunk: "one chunk", chunkIndex: 0, attemptedAt,
          }),
        },
      });
      const { ctx } = context(30, async () => { throw scenario.error; });

      await handler.generateClaimedReport(
        ctx, "user-prompt-1", "Travel", "friendly", generationClaim(),
      );

      assert.equal(calls[scenario.field].length, 1);
      assert.deepEqual(calls[scenario.field][0].slice(0, 3), ["delivery-1", 0, attemptedAt]);
      assert.equal(calls[scenario.field === "definite" ? "ambiguous" : "definite"].length, 0);
      if (scenario.field === "ambiguous") assert.equal(calls.ambiguous[0][3], "http_error");
    });
  }
});

test("ReportHandler can resend generated output under a new request after definite delivery failure", async () => {
  let deliveryNumber = 0;
  const chunksByRequest = new Map();
  const response = {
    createOrClaimDeliveryRequest: async (_responseId, _requestKey, chunks) => {
      deliveryNumber += 1;
      const requestId = `delivery-${deliveryNumber}`;
      chunksByRequest.set(requestId, chunks);
      return { outcome: "claimed", claim: deliveryClaim(chunks, requestId) };
    },
    beginDeliveryChunk: async (requestId) => ({
      outcome: "begun",
      chunk: chunksByRequest.get(requestId)[0],
      chunkIndex: 0,
      attemptedAt: new Date(`2026-08-08T12:00:0${deliveryNumber}.000Z`),
    }),
    completeDeliveryChunk: async (requestId) => ({
      outcome: "delivered", request: { id: requestId },
    }),
  };
  const { calls, handler } = createSubject({
    claimResult: {
      outcome: "generated",
      response: {
        id: "response-generated",
        transcript: "Saved transcript",
        analysis: JSON.stringify(feedback),
      },
    },
    response,
  });
  const first = context(40, async () => { throw telegramRejection(); });
  const second = context(41);

  await handler.handle(first.ctx);
  await handler.handle(second.ctx);

  assert.equal(calls.llm.length, 0);
  assert.equal(calls.createDelivery.length, 2);
  assert.deepEqual(calls.createDelivery.map((args) => args[1]), ["message:123:40", "message:123:41"]);
  assert.equal(calls.definite.length, 1);
  assert.equal(calls.completeChunk.length, 1);
  assert.equal(second.replies.length, 1);
  assert.match(second.replies[0][0], /Saved transcript/);
});
