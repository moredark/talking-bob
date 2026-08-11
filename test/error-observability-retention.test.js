const assert = require("node:assert/strict");
const test = require("node:test");

const { installRuntimeSettings } = require("./support/runtime-settings-test-harness");
const {
  AiRequestLimiterService,
} = require("../dist/modules/ai/services/ai-request-limiter.service");
const {
  BoundedHttpError,
} = require("../dist/infrastructure/http/bounded-http");
const {
  LLMService,
} = require("../dist/modules/ai/services/llm.service");
const {
  DataRetentionService,
  ErrorLogService,
  ObservabilityContextService,
} = require("../dist/modules/error-log");
const {
  VoiceHandler,
} = require("../dist/modules/telegram/handlers/voice.handler");
const {
  DailyPromptDispatcher,
} = require("../dist/modules/schedule/daily-prompt.dispatcher");
installRuntimeSettings(LLMService, DataRetentionService, VoiceHandler);

function createErrorLogSubject({ create } = {}) {
  const creates = [];
  const queries = [];
  const prisma = {
    errorLog: {
      create: create ?? (async (query) => {
        creates.push(query);
        return query.data;
      }),
      findMany: async (query) => {
        queries.push(["findMany", query]);
        return [];
      },
      count: async (query) => {
        queries.push(["count", query]);
        return 0;
      },
    },
  };
  const observability = new ObservabilityContextService();
  return {
    creates,
    queries,
    observability,
    service: new ErrorLogService(prisma, observability),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("ErrorLogService persists only allowlisted dimensions and supports correlation lookup", async () => {
  const token = "telegram-token-should-never-be-persisted";
  const transcript = "student private transcript";
  const providerBody = "provider response body with private details";
  const { creates, queries, observability, service } = createErrorLogSubject();

  await observability.run(
    {
      correlationId: "tg-correlation-42",
      telegramUpdateId: "9001",
      requestId: "update:9001",
      userId: "user-42",
    },
    () => service.capture({
      type: "ai",
      service: "llm",
      operation: "analyze_speech",
      message: `Bearer ${token}`,
      stack: `Error: ${transcript}`,
      metadata: {
        prompt: transcript,
        providerBody,
        authorization: token,
        statusCode: 503,
        latencyMs: 12.4,
        retryable: true,
      },
      error: new Error(`provider rejected ${providerBody}`),
      code: "not-allowlisted",
    }),
  );

  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].data, {
    type: "ai",
    service: "llm",
    operation: "analyze_speech",
    correlationId: "tg-correlation-42",
    statusCode: 503,
    retryable: true,
    latencyMs: 12,
    errorKind: "Error",
    message: "Error",
    stack: null,
    metadata: {
      schemaVersion: 1,
      operation: "analyze_speech",
      correlationId: "tg-correlation-42",
      telegramUpdateId: "9001",
      requestId: "update:9001",
      latencyMs: 12,
      statusCode: 503,
      retryable: true,
      errorKind: "Error",
    },
    userId: "user-42",
  });
  const serialized = JSON.stringify(creates[0].data);
  for (const secret of [token, transcript, providerBody, "Bearer", "prompt", "authorization"]) {
    assert.equal(serialized.includes(secret), false, `persisted private value: ${secret}`);
  }

  assert.deepEqual(
    await service.getLogs({ correlationId: "tg-correlation-42", limit: 7, offset: 2 }),
    { logs: [], total: 0 },
  );
  assert.deepEqual(queries, [
    ["findMany", {
      where: { correlationId: "tg-correlation-42" },
      orderBy: { createdAt: "desc" },
      take: 7,
      skip: 2,
    }],
    ["count", { where: { correlationId: "tg-correlation-42" } }],
  ]);

  queries.length = 0;
  assert.deepEqual(await service.getLogs({ correlationId: transcript }), { logs: [], total: 0 });
  assert.deepEqual(queries, []);
});

test("ObservabilityContextService propagates across awaits and isolates concurrent enrichment", async () => {
  const observability = new ObservabilityContextService();
  const firstGate = deferred();
  const secondGate = deferred();

  const first = observability.run({ correlationId: "tg-first" }, async () => {
    observability.enrich({ userId: "user-first" });
    firstGate.resolve();
    await secondGate.promise;
    return observability.current();
  });
  const second = observability.run({ correlationId: "tg-second" }, async () => {
    await firstGate.promise;
    assert.deepEqual(observability.current(), { correlationId: "tg-second" });
    observability.enrich({ requestId: "request-second" });
    secondGate.resolve();
    await Promise.resolve();
    return observability.current();
  });

  assert.deepEqual(await Promise.all([first, second]), [
    { correlationId: "tg-first", userId: "user-first" },
    { correlationId: "tg-second", requestId: "request-second" },
  ]);
  assert.equal(observability.current(), undefined);
});

test("DailyPromptDispatcher gives each claim an isolated delivery correlation inside one scheduler context", async () => {
  const observability = new ObservabilityContextService();
  const seen = [];
  const dispatcher = new DailyPromptDispatcher(
    {
      beginDeliveryAttempt: async (claim) => {
        seen.push({ claim: claim.userPromptId, context: { ...observability.current() } });
        return null;
      },
    },
    undefined,
    observability,
  );
  dispatcher.setBot({ api: {} });
  const claim = (suffix) => ({
    userPromptId: `user-prompt-${suffix}`,
    claimToken: `claim-${suffix}`,
    user: { id: `user-${suffix}`, telegramId: BigInt(suffix) },
    prompt: { id: `prompt-${suffix}`, topic: "Travel", audioFileId: null },
  });
  const parent = {
    correlationId: "schedule-parent",
    requestId: "scheduler-tick",
    telegramUpdateId: "parent-marker",
  };

  await observability.run(parent, async () => {
    assert.deepEqual(observability.current(), parent);
    assert.deepEqual(
      await Promise.all([dispatcher.dispatch(claim("101")), dispatcher.dispatch(claim("202"))]),
      ["not_attempted", "not_attempted"],
    );
    assert.deepEqual(observability.current(), parent);
  });

  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(({ claim: id }) => id).sort(), [
    "user-prompt-101",
    "user-prompt-202",
  ]);
  for (const { claim: id, context } of seen) {
    const suffix = id.endsWith("101") ? "101" : "202";
    assert.match(context.correlationId, /^delivery-[0-9a-f-]{36}$/);
    assert.equal(context.userId, `user-${suffix}`);
    assert.equal(context.requestId, id);
    assert.equal(context.telegramUpdateId, "parent-marker");
  }
  assert.notEqual(seen[0].context.correlationId, seen[1].context.correlationId);
  assert.equal(observability.current(), undefined);
});

test("ErrorLogService storage rejection resolves with one fixed minimal fallback", async () => {
  const storageError = new Error("database contains a private provider body");
  const { service } = createErrorLogSubject({
    create: async () => {
      throw storageError;
    },
  });
  const originalConsoleError = console.error;
  const fallback = [];
  console.error = (...args) => fallback.push(args);

  try {
    await assert.doesNotReject(service.capture({
      type: "system",
      service: "general",
      operation: "update.handle",
      error: new Error("original private error"),
    }));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(fallback, [["Structured error log storage failed"]]);
  assert.equal(JSON.stringify(fallback).includes(storageError.message), false);
  assert.equal(JSON.stringify(fallback).includes("original private error"), false);
});

test("LLM provider failure is correlated and classified without prompt, body, or token", async () => {
  const transcript = "my private speech transcript";
  const topic = "private conversation topic";
  const providerBody = "private provider diagnostic body";
  const token = "cloud-provider-secret-token";
  const { creates, observability, service: errorLog } = createErrorLogSubject();
  const llm = new LLMService(
    {
      cloudRuApiKey: token,
      llm: {
        apiUrl: "https://provider.invalid/chat",
        model: "test-model",
        analysisMaxTokens: 256,
        followUpMaxTokens: 128,
      },
      externalRequests: { llm: { timeoutMs: 100, maxResponseBytes: 1024 } },
    },
    new AiRequestLimiterService(1),
    errorLog,
  );
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(providerBody, { status: 503 });

  try {
    const result = await observability.run(
      { correlationId: "tg-provider-503", requestId: "message:1:2" },
      () => llm.analyzeSpeech(transcript, topic),
    );
    assert.equal(result.kind, "fallback");
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(creates.length, 1);
  const data = creates[0].data;
  assert.equal(data.correlationId, "tg-provider-503");
  assert.equal(data.operation, "analyze_speech");
  assert.equal(data.statusCode, 503);
  assert.equal(data.retryable, true);
  assert.equal(data.errorKind, "LlmProviderStatusError");
  assert.equal(Number.isInteger(data.latencyMs), true);
  assert.equal(data.latencyMs >= 0, true);
  assert.equal(data.metadata.requestId, "message:1:2");
  const serialized = JSON.stringify(data);
  for (const secret of [transcript, topic, providerBody, token, "Bearer", "messages"]) {
    assert.equal(serialized.includes(secret), false, `persisted provider input: ${secret}`);
  }
});

test("full voice flow preserves update correlation without logging token, transcript, or provider body", async () => {
  const token = "123456:telegram-secret-token";
  const transcript = "I privately visited Reykjavík last winter";
  const providerBody = "upstream body contains private diagnostics";
  const { creates, observability, service: errorLog } = createErrorLogSubject();
  const replies = [];
  let followUpTrace;
  const handler = new VoiceHandler(
    {
      findByTelegramId: async () => ({
        id: "user-private-flow",
        agentTone: "friendly",
      }),
    },
    {
      getLatestUserPrompt: async () => ({
        id: "user-prompt-private-flow",
        promptId: "prompt-private-flow",
      }),
      getPromptById: async () => ({
        id: "prompt-private-flow",
        topic: "Private travel details",
      }),
    },
    {
      precheckVoiceAcceptance: async () => ({ outcome: "accepted" }),
      acceptVoiceAndMaybeClaimGeneration: async ({ content }) => {
        assert.equal(content, transcript);
        return {
          outcome: "accepted",
          message: { id: "message-private-flow" },
          userMessageCount: 1,
          generationClaim: null,
        };
      },
      getMessages: async () => [{ role: "user", content: transcript }],
      addAssistantMessageIfOpen: async () => {
        assert.fail("assistant message must not be persisted after provider failure");
      },
    },
    { consumeLimit: async () => ({ allowed: true, requestId: "quota-1" }) },
    {
      transcribe: async () => ({ text: transcript, language: "en" }),
    },
    {
      generateFollowUp: async (history, _topic, _tone, trace) => {
        followUpTrace = trace;
        assert.equal(history[0].content, transcript);
        throw new BoundedHttpError("network", 1, {
          cause: new Error(`${providerBody}; token=${token}`),
        });
      },
    },
    {
      generateClaimedReport: async () => {
        assert.fail("report must not run for the first voice message");
      },
    },
    {
      telegramBotToken: token,
      voice: { maxDurationSeconds: 300, maxFileSizeBytes: 20 * 1024 * 1024 },
      externalRequests: {
        telegramFileDownload: { timeoutMs: 100, maxResponseBytes: 1024 },
      },
    },
    errorLog,
    observability,
  );
  const context = {
    from: { id: 123456 },
    chat: { id: 123456 },
    message: {
      message_id: 77,
      chat: { id: 123456 },
      voice: { file_id: "telegram-file-id", duration: 8, file_size: 128 },
    },
    update: { update_id: 8123 },
    api: {
      getFile: async () => ({ file_path: "voice/private-file.ogg" }),
      sendChatAction: async () => undefined,
    },
    reply: async (message) => replies.push(message),
  };
  const originalFetch = global.fetch;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.fetch = async () => new Response("mock audio bytes");
  global.setInterval = () => ({ fakeTimer: true });
  global.clearInterval = () => undefined;

  try {
    await observability.run(
      {
        correlationId: "tg-full-voice-8123",
        telegramUpdateId: "8123",
        requestId: "update:8123",
      },
      () => handler.handle(context),
    );
  } finally {
    global.fetch = originalFetch;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }

  assert.equal(creates.length, 1);
  assert.equal(followUpTrace.correlationId, "tg-full-voice-8123");
  const data = creates[0].data;
  assert.equal(data.correlationId, "tg-full-voice-8123");
  assert.equal(data.metadata.telegramUpdateId, "8123");
  assert.equal(data.metadata.requestId, "message:123456:77");
  assert.equal(data.userId, "user-private-flow");
  assert.equal(data.operation, "voice.process");
  assert.equal(data.service, "llm");
  assert.equal(data.errorKind, "BoundedHttpError");
  assert.match(replies.at(-1), /ошибка при обработке/i);

  const serialized = JSON.stringify(data);
  for (const secret of [
    token,
    transcript,
    providerBody,
    "private-file.ogg",
    "telegram-file-id",
  ]) {
    assert.equal(serialized.includes(secret), false, `persisted voice-flow secret: ${secret}`);
  }
});

test("DataRetentionService applies fixed cutoffs and purges only old closed content in dependency order", async () => {
  const calls = [];
  const count = (value) => ({ count: value });
  const tx = {
    aiProviderCall: { findMany: async (query) => { calls.push(["aiProviderCall.findMany", query]); return []; }, deleteMany: async (query) => { calls.push(["aiProviderCall.deleteMany", query]); return count(0); } },
    broadcast: { findMany: async () => [], updateMany: async () => count(), deleteMany: async () => count() },
    broadcastRecipient: { deleteMany: async () => count() },
    userPrompt: { updateMany: async (query) => { calls.push(["userPrompt.updateMany", query]); return count(8); } },
    reportDeliveryRequest: {
      deleteMany: async (query) => {
        calls.push(["reportDeliveryRequest.deleteMany", query]);
        return count(2);
      },
    },
    conversationMessage: {
      deleteMany: async (query) => {
        calls.push(["conversationMessage.deleteMany", query]);
        return count(3);
      },
    },
    userResponse: {
      updateMany: async (query) => {
        calls.push(["userResponse.updateMany", query]);
        return count(1);
      },
    },
    userRequest: {
      deleteMany: async (query) => {
        calls.push(["userRequest.deleteMany", query]);
        return count(4);
      },
    },
    quotaWindow: {
      deleteMany: async (query) => {
        calls.push(["quotaWindow.deleteMany", query]);
        return count(5);
      },
    },
    errorLog: {
      deleteMany: async (query) => {
        calls.push(["errorLog.deleteMany", query]);
        return count(6);
      },
    },
    adminAuditLog: {
      deleteMany: async (query) => {
        calls.push(["adminAuditLog.deleteMany", query]);
        return count(7);
      },
    },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const service = new DataRetentionService(prisma, {
    retention: {
      closedConversationContentDays: 7,
      rateLimitDays: 30,
      errorLogsDays: 14,
    },
  });
  service.settings = {
    productNumber: (key) => ({
      RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS: 7,
      RETENTION_RATE_LIMIT_DAYS: 30,
      RETENTION_ERROR_LOGS_DAYS: 14,
    })[key],
  };
  const now = new Date("2026-08-08T12:00:00.000Z");

  assert.deepEqual(await service.cleanup(now), {
    reportDeliveryRequests: 2,
    aiProviderCalls: 0,
    userPrompts: 8,
    conversationMessages: 3,
    userResponses: 1,
    userRequests: 4,
    quotaWindows: 5,
    errorLogs: 6,
    adminAuditLogs: 7,
    broadcastRecipients: 0,
    broadcasts: 0,
  });

  const oldClosed = {
    conversationStatus: "closed",
    conversationClosedAt: { lt: new Date("2026-08-01T12:00:00.000Z") },
  };
  assert.deepEqual(calls, [
    ["aiProviderCall.findMany", { where: { createdAt: { lt: new Date("2026-07-09T12:00:00.000Z") } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500, select: { id: true, userPromptId: true } }],
    ["reportDeliveryRequest.deleteMany", {
      where: { userResponse: { userPrompt: oldClosed } },
    }],
    ["conversationMessage.deleteMany", {
      where: { userPrompt: oldClosed },
    }],
    ["userResponse.updateMany", {
      where: { userPrompt: oldClosed, sensitiveDataPurgedAt: null },
      data: {
        voiceFileId: null,
        transcript: null,
        analysis: null,
        sensitiveDataPurgedAt: now,
      },
    }],
    ["userPrompt.updateMany", { where: { ...oldClosed, contentPurgedAt: null }, data: { contentPurgedAt: now } }],
    ["userRequest.deleteMany", {
      where: {
        createdAt: { lt: new Date("2026-07-09T12:00:00.000Z") },
        OR: [
          { quotaWindowId: null },
          { quotaWindow: { windowEnd: { lte: now } } },
        ],
      },
    }],
    ["quotaWindow.deleteMany", {
      where: {
        windowEnd: { lt: new Date("2026-07-09T12:00:00.000Z") },
        userRequests: { none: {} },
      },
    }],
    ["errorLog.deleteMany", {
      where: { createdAt: { lt: new Date("2026-07-25T12:00:00.000Z") } },
    }],
    ["adminAuditLog.deleteMany", {
      where: { createdAt: { lt: new Date("2025-08-08T12:00:00.000Z") } },
    }],
  ]);
});

test("DataRetentionService removes only audit rows older than 365 days and is idempotent", async () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const rows = [
    { id: "old", createdAt: new Date("2025-08-10T11:59:59.999Z") },
    { id: "boundary", createdAt: new Date("2025-08-10T12:00:00.000Z") },
    { id: "new", createdAt: new Date("2026-08-10T11:00:00.000Z") },
  ];
  const count = (value = 0) => ({ count: value });
  const tx = {
    reportDeliveryRequest: { deleteMany: async () => count() },
    aiProviderCall: { findMany: async () => [], deleteMany: async () => count() },
    broadcast: { findMany: async () => [], updateMany: async () => count(), deleteMany: async () => count() },
    broadcastRecipient: { deleteMany: async () => count() },
    userPrompt: { updateMany: async () => count() },
    conversationMessage: { deleteMany: async () => count() },
    userResponse: { updateMany: async () => count() },
    userRequest: { deleteMany: async () => count() },
    quotaWindow: { deleteMany: async () => count() },
    errorLog: { deleteMany: async () => count() },
    adminAuditLog: {
      deleteMany: async ({ where }) => {
        const before = rows.length;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index].createdAt < where.createdAt.lt) rows.splice(index, 1);
        }
        return count(before - rows.length);
      },
    },
  };
  const service = new DataRetentionService(
    { $transaction: async (callback) => callback(tx) },
    { retention: { closedConversationContentDays: 30, rateLimitDays: 30, errorLogsDays: 30 } },
  );

  assert.equal((await service.cleanup(now)).adminAuditLogs, 1);
  assert.equal((await service.cleanup(now)).adminAuditLogs, 0);
  assert.deepEqual(rows.map(({ id }) => id), ["boundary", "new"]);
});

test("DataRetentionService preserves an old request while its 25-hour quota window is active", async () => {
  const now = new Date("2026-11-02T04:30:00.000Z");
  const windowEnd = new Date("2026-11-02T05:00:00.000Z");
  const request = {
    createdAt: new Date("2026-11-01T04:15:00.000Z"),
    quotaWindowId: "new-york-fall-back-window",
    quotaWindow: { windowEnd },
  };
  let deletedRequests = -1;
  const count = (value = 0) => ({ count: value });
  const tx = {
    reportDeliveryRequest: { deleteMany: async () => count() },
    conversationMessage: { deleteMany: async () => count() },
    aiProviderCall: { findMany: async () => [], deleteMany: async () => count() },
    broadcast: { findMany: async () => [], updateMany: async () => count(), deleteMany: async () => count() },
    broadcastRecipient: { deleteMany: async () => count() },
    userPrompt: { updateMany: async () => count() },
    userResponse: { updateMany: async () => count() },
    userRequest: {
      deleteMany: async ({ where }) => {
        const oldEnough = request.createdAt < where.createdAt.lt;
        const unattached = request.quotaWindowId === null;
        const attachedWindowExpired = request.quotaWindow.windowEnd <= where.OR[1].quotaWindow.windowEnd.lte;
        deletedRequests = oldEnough && (unattached || attachedWindowExpired) ? 1 : 0;
        return count(deletedRequests);
      },
    },
    quotaWindow: { deleteMany: async () => count() },
    errorLog: { deleteMany: async () => count() },
    adminAuditLog: { deleteMany: async () => count() },
  };
  const service = new DataRetentionService(
    { $transaction: async (callback) => callback(tx) },
    {
      retention: {
        closedConversationContentDays: 30,
        rateLimitDays: 1,
        errorLogsDays: 30,
      },
    },
  );

  const result = await service.cleanup(now);

  assert.equal(request.createdAt < new Date(now.getTime() - 24 * 60 * 60 * 1000), true);
  assert.equal(now < windowEnd, true);
  assert.equal(deletedRequests, 0);
  assert.equal(result.userRequests, 0);
});

test("DataRetentionService cron captures cleanup failure under a dedicated correlation", async () => {
  const creates = [];
  const cleanupError = new Error("database diagnostic with private content");
  const prisma = {
    $transaction: async () => {
      throw cleanupError;
    },
    errorLog: {
      create: async (query) => {
        creates.push(query);
        return query.data;
      },
    },
  };
  const observability = new ObservabilityContextService();
  const errorLog = new ErrorLogService(prisma, observability);
  const service = new DataRetentionService(
    prisma,
    {
      retention: {
        closedConversationContentDays: 30,
        rateLimitDays: 30,
        errorLogsDays: 30,
      },
    },
    observability,
    errorLog,
  );

  await assert.doesNotReject(service.runDailyCleanup());

  assert.equal(creates.length, 1);
  assert.equal(creates[0].data.operation, "retention.cleanup");
  assert.equal(creates[0].data.service, "scheduler");
  assert.equal(creates[0].data.retryable, true);
  assert.match(creates[0].data.correlationId, /^retention-[0-9a-f-]{36}$/);
  assert.equal(observability.current(), undefined);
  assert.equal(JSON.stringify(creates[0].data).includes(cleanupError.message), false);
});
