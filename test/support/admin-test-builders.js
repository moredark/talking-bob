const ADMIN_TIMESTAMP = "2026-08-10T09:30:00.000Z";
const ADMIN_IDS = Object.freeze({
  user: "11111111-1111-4111-8111-111111111111",
  prompt: "22222222-2222-4222-8222-222222222222",
  response: "33333333-3333-4333-8333-333333333333",
  errorLog: "44444444-4444-4444-8444-444444444444",
});

function adminUser(overrides = {}) {
  return {
    id: ADMIN_IDS.user, telegramId: 123n, username: "admin-fixture", createdAt: new Date(ADMIN_TIMESTAMP),
    dailyPromptEnabled: true, dailyPromptHour: 13, dailyPromptMinute: 0, timezone: "Europe/Moscow",
    languageLevel: "B1", status: "active", bannedAt: null, bannedReason: null,
    userPrompts: [], userResponses: [], ...overrides,
  };
}

function errorLog(overrides = {}) {
  return {
    id: ADMIN_IDS.errorLog, type: "system", service: "general", operation: "unknown",
    correlationId: "request-1", statusCode: 500, retryable: false, latencyMs: 12,
    errorKind: "UnknownError", message: "provider-secret-value", stack: "sensitive stack",
    metadata: { schemaVersion: 1, operation: "unknown", secret: "must-not-leak", nested: { token: "x" } },
    userId: null, createdAt: new Date(ADMIN_TIMESTAMP), ...overrides,
  };
}

function adminAuditHarness(client, calls = []) {
  return {
    calls,
    runSuccess: async (descriptor, callback) => {
      calls.push(descriptor);
      return (await callback(client)).result;
    },
  };
}

module.exports = { ADMIN_IDS, ADMIN_TIMESTAMP, adminAuditHarness, adminUser, errorLog };
