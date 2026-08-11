const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseRuntimeConfig,
  RuntimeConfigError,
} = require("../dist/config/runtime.config");

const REQUIRED = {
  DATABASE_URL: "postgresql://user:secret@localhost:5432/talking_bob",
  TELEGRAM_BOT_TOKEN: "123456:secret-token",
  CLOUD_RU_API_KEY: "secret-cloud-key",
  JWT_SECRET: "test-jwt-secret",
};

test("runtime config parses required values and bounded defaults", () => {
  const config = parseRuntimeConfig(REQUIRED);

  assert.equal(config.databaseUrl, REQUIRED.DATABASE_URL);
  assert.equal(config.server.port, 3000);
  assert.equal(config.concurrency.telegramUpdates, 4);
  assert.equal(config.jwtSecret, REQUIRED.JWT_SECRET);
  assert.equal(config.concurrency.aiRequests, 2);
  assert.equal(config.concurrency.aiRequestMaxPending, 8);
  assert.equal(config.voice.maxFileSizeBytes, 20 * 1024 * 1024);
  assert.equal(config.externalRequests.whisper.timeoutMs, 120_000);
});

test("runtime config parses numeric overrides without mutating input", () => {
  const env = {
    ...REQUIRED,
    TELEGRAM_UPDATE_CONCURRENCY: "8",
    AI_REQUEST_CONCURRENCY: "3",
    AI_REQUEST_MAX_PENDING: "0",
    PORT: "8080",
    LLM_ANALYSIS_MAX_TOKENS: "3000",
    WHISPER_REQUEST_TIMEOUT_MS: "1500",
    TELEGRAM_FILE_DOWNLOAD_MAX_RESPONSE_BYTES: "2048",
  };
  const before = { ...env };

  const config = parseRuntimeConfig(env);

  assert.deepEqual(env, before);
  assert.equal(config.concurrency.telegramUpdates, 8);
  assert.equal(config.concurrency.aiRequests, 3);
  assert.equal(config.concurrency.aiRequestMaxPending, 0);
  assert.equal(config.server.port, 8080);
  assert.equal(config.llm.analysisMaxTokens, 3000);
  assert.equal(config.externalRequests.whisper.timeoutMs, 1500);
  assert.equal(
    config.externalRequests.telegramFileDownload.maxResponseBytes,
    2048,
  );
});

test("runtime config reports all invalid fields without exposing secrets", () => {
  const secret = "do-not-leak-this";
  assert.throws(
    () =>
      parseRuntimeConfig({
        DATABASE_URL: `not-a-url-${secret}`,
        TELEGRAM_BOT_TOKEN: secret,
        CLOUD_RU_API_KEY: secret,
        LLM_API_URL: `invalid-${secret}`,
        PORT: "70000",
        LLM_FOLLOWUP_MAX_TOKENS: "63",
        AI_REQUEST_CONCURRENCY: "0",
        AI_REQUEST_MAX_PENDING: "1001",
        LLM_REQUEST_TIMEOUT_MS: "1.5",
        WHISPER_REQUEST_TIMEOUT_MS: "120001",
        VOICE_MAX_DURATION_SECONDS: "301",
        VOICE_MAX_FILE_SIZE_BYTES: "9999999999",
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /LLM_API_URL/);
      assert.match(error.message, /PORT/);
      assert.match(error.message, /LLM_FOLLOWUP_MAX_TOKENS/);
      assert.match(error.message, /AI_REQUEST_CONCURRENCY/);
      assert.match(error.message, /AI_REQUEST_MAX_PENDING/);
      assert.match(error.message, /WHISPER_REQUEST_TIMEOUT_MS/);
      assert.match(error.message, /VOICE_MAX_DURATION_SECONDS/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("runtime config treats blank required values as missing", () => {
  assert.throws(
    () =>
      parseRuntimeConfig({
        DATABASE_URL: " ",
        TELEGRAM_BOT_TOKEN: "",
        CLOUD_RU_API_KEY: "\t",
        JWT_SECRET: "",
      }),
    (error) => {
      assert.equal(error.issues.length, 4);
      return true;
    },
  );
});

test("runtime config rejects the retired public JWT fallback", () => {
  assert.throws(
    () => parseRuntimeConfig({ ...REQUIRED, JWT_SECRET: "default-secret-change-me" }),
    (error) => error instanceof RuntimeConfigError
      && error.issues.includes("JWT_SECRET must not use the retired public fallback"),
  );
});
