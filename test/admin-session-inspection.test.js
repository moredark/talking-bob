const assert = require("node:assert/strict");
const test = require("node:test");

const { installRuntimeSettings } = require("./support/runtime-settings-test-harness");
const { AdminController } = require("../dist/modules/admin/admin.controller");
const { AdminSessionsQueryPipe } = require("../dist/modules/admin/admin-validation.pipe");
const { AdminSessionsService } = require("../dist/modules/admin/admin-sessions.service");
const { AdminUsersService } = require("../dist/modules/admin/admin-users.service");
const { AuthGuard } = require("../dist/modules/auth");
const { AiRequestLimiterService } = require("../dist/modules/ai/services/ai-request-limiter.service");
const { AiProviderTraceWriter } = require("../dist/modules/ai/services/ai-provider-trace-writer.service");
const { LLMService } = require("../dist/modules/ai/services/llm.service");
const { DataRetentionService } = require("../dist/modules/error-log/data-retention.service");
installRuntimeSettings(LLMService, DataRetentionService);

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const responseId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-08-10T12:00:00.000Z");
const config = () => ({ cloudRuApiKey: "secret", llm: { apiUrl: "https://provider.invalid/chat", model: "test-model", analysisMaxTokens: 256, followUpMaxTokens: 128 }, externalRequests: { llm: { timeoutMs: 100, maxResponseBytes: 8192 } } });
const response = (content, status = 200, usage) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status, headers: { "content-type": "application/json" } });

function routePipes(methodName) {
  const argumentsMetadata = Reflect.getMetadata("__routeArguments__", AdminController, methodName) ?? {};
  return Object.values(argumentsMetadata).flatMap((argument) => argument.pipes ?? []);
}

test("session query validation is strict and uses half-open UTC ranges", () => {
  const pipe = new AdminSessionsQueryPipe();
  const parsed = pipe.transform({ page: "2", limit: "10", userId, topic: " Travel ", source: "scheduled", deliveryStatus: "sent", conversationStatus: "closed", generationStatus: "generated", from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
  assert.equal(parsed.topic, "Travel");
  assert.equal(parsed.from.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.throws(() => pipe.transform({ sort: "createdAt" }), /unknown fields/);
  assert.throws(() => pipe.transform({ from: "2026-08-02T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }), /from must be before to/);
  assert.throws(() => pipe.transform({ userId: "bad" }), /UUID/);
});

test("session routes remain guarded, validate query and id, and return not-found", async () => {
  const guards = Reflect.getMetadata("__guards__", AdminController) ?? [];
  assert.ok(guards.includes(AuthGuard));
  assert.ok(routePipes("getSessions").includes(AdminSessionsQueryPipe));
  assert.ok(routePipes("getSessionById").some((pipe) => pipe?.name === "AdminUuidPipe"));

  const QueryPipe = routePipes("getSessions").find((pipe) => pipe === AdminSessionsQueryPipe);
  const queryPipe = new QueryPipe();
  assert.throws(() => queryPipe.transform({ unexpected: "raw-content" }), (error) => error.getStatus() === 422);

  const controller = new AdminController({ getSessionById: async () => null });
  await assert.rejects(
    () => controller.getSessionById(sessionId),
    (error) => error.getStatus() === 404 && error.message === "Session not found",
  );
});

test("session list selects no raw content and uses stable order", async () => {
  const queries = [];
  const prisma = { userPrompt: { findMany: async (q) => { queries.push(q); return [{ id: sessionId, source: "scheduled", deliveryStatus: "sent", conversationStatus: "closed", createdAt: now, sentAt: now, conversationClosedAt: now, contentPurgedAt: null, user: { id: userId, telegramId: 42n, username: "bob" }, prompt: { id: "p", topic: "Travel" }, userResponse: { generationStatus: "generated", generatedAt: now }, _count: { conversationMessages: 3 } }]; }, count: async () => 1 } };
  const result = await new AdminSessionsService(prisma).getSessions({ page: 1, limit: 10, userId, topic: "Travel", from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-02T00:00:00Z") });
  assert.equal(result.data[0].user.telegramId, "42");
  assert.deepEqual(queries[0].orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.equal(queries[0].select.conversationMessages, undefined);
  assert.deepEqual(queries[0].where.createdAt, { gte: new Date("2026-08-01T00:00:00Z"), lt: new Date("2026-08-02T00:00:00Z") });
});

test("session detail orders records and distinguishes purged/model/legacy content", async () => {
  let query;
  const row = { id: sessionId, source: "manual", deliveryStatus: "sent", conversationStatus: "closed", createdAt: now, sentAt: now, scheduledFor: null, deliveryAttemptedAt: now, lastDeliveryErrorCode: null, lastDeliveryErrorAt: null, conversationClosedAt: now, contentPurgedAt: now, aiTracePurgedAt: now, user: { id: userId, telegramId: 42n, username: null }, prompt: { id: "p", topic: "Travel" }, conversationMessages: [{ id: "m", role: "user", content: "private", voiceFileId: "private", createdAt: now }], userResponse: { id: responseId, transcript: null, analysis: JSON.stringify({ summary: "Good", improvementPoints: ["detail"], overallScore: 8 }), analysisKind: "model", analysisVersion: 1, generationStatus: "generated", generationAttemptedAt: now, generatedAt: now, lastGenerationErrorCode: null, lastGenerationErrorAt: null, sensitiveDataPurgedAt: now, createdAt: now, reportDeliveryRequests: [] }, aiProviderCalls: [], _count: { conversationMessages: 1 } };
  const service = new AdminSessionsService({ userPrompt: { findUnique: async (q) => { query = q; return row; } } });
  const detail = await service.getSessionById(sessionId);
  assert.deepEqual(query.include.conversationMessages.orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  assert.deepEqual(query.include.aiProviderCalls.orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  assert.equal(detail.messages[0].content, null);
  assert.equal(detail.response.analysis.kind, "model");
  row.contentPurgedAt = null; row.userResponse.analysis = "legacy";
  assert.deepEqual((await service.getSessionById(sessionId)).response.analysis, { kind: "legacy", raw: "legacy" });
});

test("LLM traces succeeded, empty, failed, and malformed JSON before parsing", async () => {
  const calls = [];
  const llm = new LLMService(config(), new AiRequestLimiterService(1), undefined, { write: (v) => calls.push(v) });
  const trace = { userId, userPromptId: sessionId, userResponseId: responseId, requestId: "request-1" };
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => response("Follow", 200, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
    assert.equal(await llm.generateFollowUp([], "Travel", "friendly", trace), "Follow"); assert.deepEqual([calls.at(-1).outcome, calls.at(-1).totalTokens], ["succeeded", 5]);
    global.fetch = async () => response(""); await llm.generateFollowUp([], "Travel", "friendly", trace); assert.equal(calls.at(-1).outcome, "empty");
    global.fetch = async () => response("denied", 503); await llm.generateFollowUp([], "Travel", "friendly", trace); assert.deepEqual([calls.at(-1).outcome, calls.at(-1).statusCode], ["failed", 503]);
    global.fetch = async () => response("not-json"); assert.equal((await llm.analyzeSpeech("I travelled", "Travel", "en", "friendly", trace)).kind, "fallback"); assert.deepEqual([calls.at(-1).outcome, calls.at(-1).responseContent], ["succeeded", "not-json"]);
  } finally { global.fetch = originalFetch; }
});

test("LLM writes exactly one trace per provider attempt and classifies invalid analysis JSON as succeeded", async () => {
  const originalFetch = global.fetch;
  try {
    const retryCalls = [];
    const retryLlm = new LLMService(config(), new AiRequestLimiterService(1), undefined, { write: (value) => retryCalls.push(value) });
    const retryResponses = [response(""), response(JSON.stringify({ summary: "Хорошо", improvementPoints: [], overallScore: 8 }))];
    global.fetch = async () => retryResponses.shift();
    const result = await retryLlm.analyzeSpeech("I travelled", "Travel", "en", "friendly", { userId, userPromptId: sessionId, userResponseId: responseId });
    assert.equal(result.kind, "model");
    assert.deepEqual(retryCalls.map(({ attempt, outcome }) => ({ attempt, outcome })), [
      { attempt: 1, outcome: "empty" },
      { attempt: 2, outcome: "succeeded" },
    ]);

    const invalidCalls = [];
    const invalidLlm = new LLMService(config(), new AiRequestLimiterService(1), undefined, { write: (value) => invalidCalls.push(value) });
    global.fetch = async () => response("not-json", 200);
    assert.equal((await invalidLlm.analyzeSpeech("I travelled", "Travel", "en", "friendly", { userId, userPromptId: sessionId, userResponseId: responseId })).kind, "fallback");
    assert.equal(invalidCalls.length, 1);
    assert.deepEqual({ attempt: invalidCalls[0].attempt, outcome: invalidCalls[0].outcome, statusCode: invalidCalls[0].statusCode, responseContent: invalidCalls[0].responseContent }, {
      attempt: 1, outcome: "succeeded", statusCode: 200, responseContent: "not-json",
    });

    const failedCalls = [];
    const failedLlm = new LLMService(config(), new AiRequestLimiterService(1), undefined, { write: (value) => failedCalls.push(value) });
    global.fetch = async () => response("denied", 503);
    await failedLlm.generateFollowUp([], "Travel", "friendly", { userId, userPromptId: sessionId });
    assert.equal(failedCalls.length, 1);
    assert.deepEqual({ attempt: failedCalls[0].attempt, outcome: failedCalls[0].outcome, statusCode: failedCalls[0].statusCode }, {
      attempt: 1, outcome: "failed", statusCode: 503,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("trace persistence and rejected fallback logging remain best effort", async () => {
  let captures = 0;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const writer = new AiProviderTraceWriter({ aiProviderCall: { create: async () => { throw new Error("db"); } } }, { capture: async () => { captures += 1; throw new Error("logger"); } });
  try {
    assert.doesNotThrow(() => writer.write({ userId, userPromptId: sessionId, operation: "follow_up", provider: "cloud.ru", model: "m", attempt: 1, outcome: "failed", latencyMs: 1, failureCode: "network_error" }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captures, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("AI trace retention is fixed at 30 days, marks affected sessions, and is idempotent", async () => {
  const cutoff = new Date("2026-07-11T12:00:00.000Z");
  const rows = Array.from({ length: 1002 }, (_, index) => ({ id: `old-${String(index).padStart(4, "0")}`, userPromptId: `session-${index % 3}`, createdAt: new Date(cutoff.getTime() - 1) }));
  rows.push({ id: "boundary", userPromptId: "partial", createdAt: cutoff });
  const marked = []; const batchSizes = []; const count = (value = 0) => ({ count: value });
  const tx = {
    aiProviderCall: {
      findMany: async ({ where, take }) => { const batch = rows.filter((row) => row.createdAt < where.createdAt.lt).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take); batchSizes.push(batch.length); return batch.map(({ id, userPromptId }) => ({ id, userPromptId })); },
      deleteMany: async ({ where }) => { const ids = new Set(where.id.in); const before = rows.length; for (let index = rows.length - 1; index >= 0; index -= 1) if (ids.has(rows[index].id)) rows.splice(index, 1); return count(before - rows.length); },
    },
    userPrompt: { updateMany: async ({ where, data }) => { if (where.id) marked.push({ ids: where.id.in, at: data.aiTracePurgedAt }); return count(); } },
    reportDeliveryRequest: { deleteMany: async () => count() }, conversationMessage: { deleteMany: async () => count() },
    userResponse: { updateMany: async () => count() }, userRequest: { deleteMany: async () => count() },
    quotaWindow: { deleteMany: async () => count() }, errorLog: { deleteMany: async () => count() }, adminAuditLog: { deleteMany: async () => count() },
    broadcast: { findMany: async () => [], updateMany: async () => count(), deleteMany: async () => count() },
    broadcastRecipient: { deleteMany: async () => count() },
  };
  let transactionCalls = 0;
  const service = new DataRetentionService({ $transaction: async (callback) => { transactionCalls += 1; return callback(tx); } }, { retention: { closedConversationContentDays: 7, rateLimitDays: 30, errorLogsDays: 30 } });
  assert.equal((await service.cleanup(now)).aiProviderCalls, 1002);
  assert.equal((await service.cleanup(now)).aiProviderCalls, 0);
  assert.deepEqual(rows.map((row) => row.id), ["boundary"]);
  assert.deepEqual(batchSizes, [500, 500, 2, 0, 0]);
  assert.equal(transactionCalls, 11);
  assert.deepEqual([...new Set(marked.flatMap(({ ids }) => ids))].sort(), ["session-0", "session-1", "session-2"]);
});

test("reset progress deletes provider traces before dependent sessions", async () => {
  const order = []; const count = { count: 1 }; let userUpdate;
  const tx = { $queryRaw: async (query) => { const sql = (query.strings || []).join("?"); if (sql.includes('FROM "user_prompts"')) { order.push("lock-prompts"); return [{ id: sessionId }]; } if (sql.includes('FROM "users"')) { order.push("lock-user"); return [{ id: userId }]; } throw new Error(`unexpected lock: ${sql}`); }, streakReminder: { deleteMany: async () => { order.push("streak-reminder"); return count; } }, streakDay: { deleteMany: async () => { order.push("streak-day"); return count; } }, reportDeliveryRequest: { deleteMany: async () => { order.push("report"); return count; } }, aiProviderCall: { deleteMany: async () => { order.push("trace"); return count; } }, userActivityDay: { deleteMany: async () => { order.push("activity"); return count; } }, conversationMessage: { deleteMany: async () => { order.push("message"); return count; } }, userResponse: { deleteMany: async () => { order.push("response"); return count; } }, userPrompt: { deleteMany: async () => { order.push("session"); return count; } }, user: { update: async (args) => { order.push("user"); userUpdate = args; } } };
  const audit = { runSuccess: async (_metadata, callback) => (await callback(tx)).result };
  assert.equal(await new AdminUsersService({ user: { findUnique: async () => ({ id: userId }) } }, audit).resetUserProgress(userId), true);
  assert.deepEqual(order, ["lock-prompts", "lock-user", "streak-reminder", "streak-day", "report", "trace", "activity", "message", "response", "session", "user"]);
  assert.deepEqual(userUpdate, {
    where: { id: userId },
    data: {
      lastUserMessageAt: null,
      currentStreak: 0,
      longestStreak: 0,
      lastStreakLocalDate: null,
      streakExpiresAt: null,
      nextStreakReminderAt: null,
    },
  });
});
