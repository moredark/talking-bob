const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../dist/config/runtime-settings.registry.js");
const { RuntimeSettingsService, loadRuntimeSettingsBootstrap } = require("../dist/config/runtime-settings.service.js");
const { parseRuntimeConfig } = require("../dist/config/runtime.config.js");
const { AdminRuntimeSettingsPatchPipe } = require("../dist/modules/admin/admin-validation.pipe.js");
const { AdminSettingsService } = require("../dist/modules/admin/admin-settings.service.js");

function row(overrides = {}) {
  return {
    id: "singleton",
    productOverrides: overrides.product || {},
    infrastructureOverrides: overrides.infrastructure || {},
    productVersion: overrides.productVersion || 0,
    infrastructureVersion: overrides.infrastructureVersion || 0,
    updatedById: null,
    updatedByUsername: null,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
  };
}

function bootstrap(current, env = {}) {
  return { row: current, env: Object.freeze(env), bootInfrastructure: Object.freeze(current.infrastructureOverrides) };
}

test("runtime registry is closed, typed, bounded, and documents every consumer/env resolver", () => {
  const entries = registry.RUNTIME_SETTINGS_REGISTRY;
  assert.equal(new Set(entries.map((entry) => entry.key)).size, entries.length);
  assert.ok(entries.every((entry) => entry.consumer && ("envKey" in entry)));
  assert.deepEqual(
    entries.filter((entry) => entry.group === "secret").map((entry) => entry.key),
    ["DATABASE_URL", "TELEGRAM_BOT_TOKEN", "CLOUD_RU_API_KEY", "JWT_SECRET", "ADMIN_PASSWORD", "POSTGRES_PASSWORD"],
  );
  const rate = registry.registryEntry("VOICE_RESPONSE_MAX_REQUESTS");
  assert.deepEqual([rate.defaultValue, rate.min, rate.max, rate.envKey], [10, 1, 1000, undefined]);
  const window = registry.registryEntry("COMMAND_WINDOW_MINUTES");
  assert.deepEqual([window.defaultValue, window.min, window.max], [60, 1, 10080]);
  const model = registry.registryEntry("LLM_MODEL");
  assert.equal(registry.validateRuntimeOverride(model, "  model/name  "), true);
  assert.equal(registry.normalizeRuntimeOverride(model, "  model/name  "), "model/name");
  assert.equal(registry.validateRuntimeOverride(model, "x".repeat(161)), false);
});

test("settings PATCH validation is strict, group-scoped, normalized, and rejects empty/unknown bodies", () => {
  const product = new AdminRuntimeSettingsPatchPipe("product");
  assert.deepEqual(product.transform({
    expectedVersion: 0,
    values: { LLM_ANALYSIS_MAX_TOKENS: 3000 },
  }), { expectedVersion: 0, values: { LLM_ANALYSIS_MAX_TOKENS: 3000 } });
  assert.throws(() => product.transform({ expectedVersion: 0, values: { LLM_MODEL: "model" } }), /allowed product/);
  assert.throws(() => product.transform({ expectedVersion: 0, values: {} }), /must not be empty/);
  assert.throws(() => product.transform({ expectedVersion: 0, values: { COMMAND_MAX_REQUESTS: 1001 } }), /invalid value/);
  assert.throws(() => product.transform({ expectedVersion: 0, values: {}, extra: true }), /unknown fields/);
  const infrastructure = new AdminRuntimeSettingsPatchPipe("infrastructure");
  assert.deepEqual(infrastructure.transform({ expectedVersion: 2, values: { LLM_MODEL: "  next/model  " } }),
    { expectedVersion: 2, values: { LLM_MODEL: "next/model" } });
});

test("runtime resolution uses override > env > default without mutating process.env", () => {
  const before = process.env.LLM_ANALYSIS_MAX_TOKENS;
  const current = row({ product: { LLM_ANALYSIS_MAX_TOKENS: 3100 } });
  const service = new RuntimeSettingsService({}, bootstrap(current, {
    LLM_ANALYSIS_MAX_TOKENS: "2800",
    LLM_FOLLOWUP_MAX_TOKENS: "1300",
  }));
  assert.equal(service.productNumber("LLM_ANALYSIS_MAX_TOKENS"), 3100);
  assert.equal(service.productNumber("LLM_FOLLOWUP_MAX_TOKENS"), 1300);
  assert.equal(service.productNumber("DIALOGS_PER_DAY"), 20);
  assert.equal(process.env.LLM_ANALYSIS_MAX_TOKENS, before);
});

test("GET projection separates current infrastructure from pending and never exposes secret values", async () => {
  const current = row({ infrastructure: { LLM_MODEL: "boot/model" }, infrastructureVersion: 1 });
  const persisted = { ...current, infrastructureOverrides: { LLM_MODEL: "pending/model" }, infrastructureVersion: 2 };
  const runtime = new RuntimeSettingsService(
    { runtimeSettings: { findUnique: async () => persisted } },
    bootstrap(current, { LLM_MODEL: "env/model", JWT_SECRET: "do-not-leak", POSTGRES_PASSWORD: "also-secret" }),
  );
  const service = new AdminSettingsService(runtime, {}, { current: () => undefined, fallback: () => ({ actorId: "system", actorUsername: "system" }) });
  const response = await service.getSettings();
  const model = response.infrastructure.entries.find((entry) => entry.key === "LLM_MODEL");
  assert.equal(model.effectiveValue, "boot/model");
  assert.equal(model.pendingValue, "pending/model");
  assert.equal(model.source, "override");
  assert.equal(model.restartRequired, true);
  assert.deepEqual(Object.keys(response).sort(), ["infrastructure", "product", "readonly", "secret"]);
  assert.equal(JSON.stringify(response).includes("do-not-leak"), false);
  assert.deepEqual(Object.keys(response.secret.find((entry) => entry.key === "JWT_SECRET")).sort(), ["configured", "description", "key"]);
});

test("product CAS update commits mutation and key-only audit together, attributes actor, and refreshes hot snapshot", async () => {
  let current = row();
  let auditInput;
  let auditMutation;
  const actor = { actorId: "admin-id", actorUsername: "admin", requestId: "r", correlationId: "c" };
  const tx = {
    runtimeSettings: {
      findUnique: async () => current,
      updateMany: async ({ where, data }) => {
        if (where.productVersion !== current.productVersion) return { count: 0 };
        current = {
          ...current,
          productOverrides: data.productOverrides,
          productVersion: current.productVersion + 1,
          updatedById: data.updatedById,
          updatedByUsername: data.updatedByUsername,
        };
        return { count: 1 };
      },
    },
  };
  const runtime = new RuntimeSettingsService(
    { runtimeSettings: { findUnique: async () => current } },
    bootstrap(current),
  );
  const audit = {
    runSuccess: async (input, callback) => {
      auditInput = input;
      auditMutation = await callback(tx);
      return auditMutation.result;
    },
  };
  const service = new AdminSettingsService(runtime, audit, { current: () => actor, fallback: () => actor });
  const group = await service.updateProduct({ expectedVersion: 0, values: { COMMAND_MAX_REQUESTS: 44 } });
  assert.equal(group.version, 1);
  assert.equal(runtime.productNumber("COMMAND_MAX_REQUESTS"), 44);
  assert.deepEqual(auditInput, { action: "settings.product.update", entityType: "runtime_settings" });
  assert.deepEqual(auditMutation.before, { version: 0, overrideKeys: [] });
  assert.deepEqual(auditMutation.after, { version: 1, changedKeys: ["COMMAND_MAX_REQUESTS"], resetKeys: [], overrideKeys: ["COMMAND_MAX_REQUESTS"] });
  assert.equal(current.updatedById, "admin-id");
  assert.equal(current.updatedByUsername, "admin");
});

test("stale CAS is a 409 and cannot mutate settings", async () => {
  const current = row({ productVersion: 2 });
  const runtime = new RuntimeSettingsService({}, bootstrap(current));
  const audit = {
    runSuccess: async (_input, callback) => callback({ runtimeSettings: { findUnique: async () => current } }),
  };
  const service = new AdminSettingsService(runtime, audit, { current: () => undefined, fallback: () => ({ actorId: "system", actorUsername: "system" }) });
  await assert.rejects(() => service.updateProduct({ expectedVersion: 1, values: { COMMAND_MAX_REQUESTS: 40 } }), (error) => error.getStatus() === 409);
});

test("product snapshot ignores an out-of-order older committed version", () => {
  const service = new RuntimeSettingsService({}, bootstrap(row({
    productVersion: 0,
    product: { COMMAND_MAX_REQUESTS: 30 },
  })));

  service.refreshProduct(row({
    productVersion: 2,
    product: { COMMAND_MAX_REQUESTS: 52 },
  }));
  service.refreshProduct(row({
    productVersion: 1,
    product: { COMMAND_MAX_REQUESTS: 41 },
  }));

  assert.equal(service.productNumber("COMMAND_MAX_REQUESTS"), 52);
});

test("controller source exposes exactly the three authenticated settings routes and key-only audit metadata", () => {
  const fs = require("node:fs");
  const controller = fs.readFileSync("src/modules/admin/admin.controller.ts", "utf8");
  assert.equal((controller.match(/@(Get|Patch)\("settings(?:\/(?:product|infrastructure))?"\)/g) || []).length, 3);
  assert.match(controller, /@AdminAuditMutation\("settings\.product\.update", "runtime_settings"\)/);
  assert.match(controller, /@AdminAuditMutation\("settings\.infrastructure\.update", "runtime_settings"\)/);
  const service = fs.readFileSync("src/modules/admin/admin-settings.service.ts", "utf8");
  assert.doesNotMatch(service, /after:\s*\{[^}]*values/s);
});
test("rolling rate limits read hot max/window values on each admission", async () => {
  const { RateLimitService } = require("../dist/modules/rate-limit/rate-limit.service.js");
  const observed = [];
  const prisma = {
    userRequest: {
      count: async ({ where }) => {
        observed.push(where.createdAt.gte);
        return 9;
      },
    },
  };
  const values = { VOICE_RESPONSE_MAX_REQUESTS: 10, VOICE_RESPONSE_WINDOW_MINUTES: 5 };
  const service = new RateLimitService(prisma);
  service.settings = { productNumber: (key) => values[key] };
  assert.equal(await service.checkLimit("u", "voice_response"), true);
  values.VOICE_RESPONSE_MAX_REQUESTS = 9;
  values.VOICE_RESPONSE_WINDOW_MINUTES = 7;
  assert.equal(await service.checkLimit("u", "voice_response"), false);
  assert.ok(observed[1].getTime() < observed[0].getTime() - 100_000);
});

test("start admission reads hot dialogs/day and reflects it in the rejection message", async () => {
  const { StartHandler } = require("../dist/modules/telegram/handlers/start.handler.js");
  let admittedMax;
  const replies = [];
  const handler = new StartHandler(
    { findOrCreateByTelegramId: async () => ({ id: "u", timezone: "Europe/Moscow" }) },
    { consumeCalendarDayLimit: async (_id, _action, _zone, max) => { admittedMax = max; return { allowed: false }; } },
    { hasActivePrompt: async () => true },
    {},
    {},
  );
  handler.settings = { productNumber: () => 37 };
  await handler.handle({ from: { id: 1 }, reply: async (message) => replies.push(message) });
  assert.equal(admittedMax, 37);
  assert.match(replies[0], /37/);
});

test("LLM snapshots analysis tokens once across retry and reads follow-up tokens per request", async () => {
  const { LLMService } = require("../dist/modules/ai/services/llm.service.js");
  const config = {
    llm: { apiUrl: "https://example.test", model: "model", analysisMaxTokens: 2500, followUpMaxTokens: 1200 },
    externalRequests: { llm: { timeoutMs: 1000, maxResponseBytes: 10000 } },
  };
  const service = new LLMService(config, {});
  let analysisReads = 0;
  const payloads = [];
  service.settings = {
    productNumber: (key) => {
      if (key === "LLM_ANALYSIS_MAX_TOKENS") { analysisReads += 1; return analysisReads === 1 ? 3000 : 9000; }
      return 1400;
    },
  };
  service.requestTracedCompletion = async (payload) => { payloads.push(payload); return { content: null }; };
  await service.analyzeSpeech("hello", "travel");
  assert.equal(analysisReads, 1);
  assert.deepEqual(payloads.map((payload) => payload.max_tokens), [3000, 3500]);
  payloads.length = 0;
  await service.generateFollowUp([], "travel");
  assert.equal(payloads[0].max_tokens, 1400);
});

test("voice limits are captured once before user-flow awaits", async () => {
  const { VoiceHandler } = require("../dist/modules/telegram/handlers/voice.handler.js");
  const calls = [];
  const handler = new VoiceHandler({}, {}, {}, {}, {}, {}, {}, {
    telegramBotToken: "token",
    voice: { maxDurationSeconds: 300, maxFileSizeBytes: 1000 },
    externalRequests: { telegramFileDownload: { timeoutMs: 1000, maxResponseBytes: 1000 } },
  });
  handler.settings = { productNumber: (key) => { calls.push(key); return key === "VOICE_MAX_DURATION_SECONDS" ? 2 : 500; } };
  const replies = [];
  await handler.handle({
    from: { id: 1 },
    message: { voice: { duration: 3, file_size: 100 }, chat: { id: 1 }, message_id: 1 },
    update: { update_id: 1 },
    reply: async (message) => replies.push(message),
  });
  assert.deepEqual(calls, ["VOICE_MAX_DURATION_SECONDS", "VOICE_MAX_FILE_SIZE_BYTES"]);
  assert.match(replies[0], /2 секунд/);
});

test("retention reads hot cutoffs on every cleanup while AI trace retention remains fixed", async () => {
  const { DataRetentionService } = require("../dist/modules/error-log/data-retention.service.js");
  const captured = [];
  const empty = async (args = {}) => { captured.push(args.where); return { count: 0 }; };
  const tx = {
    reportDeliveryRequest: { deleteMany: empty },
    conversationMessage: { deleteMany: empty },
    userResponse: { updateMany: empty },
    userPrompt: { updateMany: empty },
    userRequest: { deleteMany: empty },
    quotaWindow: { deleteMany: empty },
    errorLog: { deleteMany: empty },
    adminAuditLog: { deleteMany: empty },
    broadcast: { findMany: async () => [], updateMany: empty, deleteMany: empty },
    broadcastRecipient: { deleteMany: empty },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const service = new DataRetentionService(prisma, { retention: { closedConversationContentDays: 30, rateLimitDays: 30, errorLogsDays: 30 } });
  service.purgeAiProviderCalls = async (cutoff) => { captured.push({ aiCutoff: cutoff }); return 0; };
  const values = {
    RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS: 7,
    RETENTION_RATE_LIMIT_DAYS: 8,
    RETENTION_ERROR_LOGS_DAYS: 9,
  };
  service.settings = { productNumber: (key) => values[key] };
  const now = new Date("2026-08-10T00:00:00.000Z");
  await service.cleanup(now);
  values.RETENTION_ERROR_LOGS_DAYS = 10;
  await service.cleanup(now);
  const ai = captured.filter((value) => value.aiCutoff).map((value) => value.aiCutoff.toISOString());
  assert.deepEqual(ai, ["2026-07-11T00:00:00.000Z", "2026-07-11T00:00:00.000Z"]);
  const errorCutoffs = captured.filter((value) => value?.createdAt?.lt).map((value) => value.createdAt.lt.toISOString());
  assert.ok(errorCutoffs.includes("2026-08-01T00:00:00.000Z"));
  assert.ok(errorCutoffs.includes("2026-07-31T00:00:00.000Z"));
});
test("invalid legacy overrides fall back per key with sanitized key-only diagnostics", () => {
  const messages = [];
  const original = console.error;
  console.error = (message) => messages.push(String(message));
  try {
    const current = row({ product: {
      COMMAND_MAX_REQUESTS: "do-not-log-this-value",
      UNKNOWN_KEY: "another-secret",
      "\nsecret-key": "third-secret",
    } });
    const service = new RuntimeSettingsService({}, bootstrap(current));
    assert.equal(service.productNumber("COMMAND_MAX_REQUESTS"), 30);
  } finally {
    console.error = original;
  }
  assert.ok(messages.some((message) => message.includes("COMMAND_MAX_REQUESTS")));
  assert.ok(messages.some((message) => message.includes("UNKNOWN_KEY")));
  assert.ok(messages.some((message) => message.endsWith("unknown")));
  assert.equal(messages.join(" ").includes("do-not-log-this-value"), false);
  assert.equal(messages.join(" ").includes("another-secret"), false);
  assert.equal(messages.join(" ").includes("third-secret"), false);
});

test("pre-Nest loader treats database and singleton-row failures as fatal", async () => {
  const config = { databaseUrl: "postgresql://readonly.invalid/db" };
  let disconnected = 0;
  const unavailable = {
    $connect: async () => { throw new Error("database unavailable"); },
    $disconnect: async () => { disconnected += 1; },
    runtimeSettings: { findUnique: async () => { throw new Error("must not query"); } },
  };
  await assert.rejects(() => loadRuntimeSettingsBootstrap(config, {}, unavailable), /database unavailable/);
  assert.equal(disconnected, 1);
  const missing = {
    $connect: async () => undefined,
    $disconnect: async () => { disconnected += 1; },
    runtimeSettings: { findUnique: async () => null },
  };
  await assert.rejects(() => loadRuntimeSettingsBootstrap(config, {}, missing), /singleton is missing/);
  assert.equal(disconnected, 2);
});

test("runtime parser rejects overlong LLM model identifiers after trimming", () => {
  assert.throws(() => parseRuntimeConfig({
    DATABASE_URL: "postgresql://bob:pw@localhost/db",
    TELEGRAM_BOT_TOKEN: "token",
    CLOUD_RU_API_KEY: "key",
    JWT_SECRET: "private-secret",
    LLM_MODEL: `  ${"x".repeat(161)}  `,
  }), /LLM_MODEL/);
});
