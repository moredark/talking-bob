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
  assert.deepEqual(config.tts, { enabled:false, apiKey:"", speed:1, maxTextCharacters:5000, request:{timeoutMs:20_000,maxResponseBytes:2*1024*1024} });
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

test("runtime config parses TTS settings", () => {
  const config = parseRuntimeConfig({...REQUIRED,TTS_ENABLED:"true",YANDEX_SPEECHKIT_API_KEY:"tts-secret",TTS_SPEED:"1.25",TTS_MAX_TEXT_CHARACTERS:"1200",TTS_REQUEST_TIMEOUT_MS:"5000",TTS_REQUEST_MAX_RESPONSE_BYTES:"4096"});
  assert.deepEqual(config.tts,{enabled:true,apiKey:"tts-secret",speed:1.25,maxTextCharacters:1200,request:{timeoutMs:5000,maxResponseBytes:4096}});
});
test("runtime config validates TTS enabled key and values", () => {
  assert.throws(()=>parseRuntimeConfig({...REQUIRED,TTS_ENABLED:"true"}),(e)=>e instanceof RuntimeConfigError&&e.issues.some((i)=>i.includes("YANDEX_SPEECHKIT_API_KEY")));
  assert.throws(()=>parseRuntimeConfig({...REQUIRED,TTS_ENABLED:"maybe"}),(e)=>e instanceof RuntimeConfigError&&e.issues.some((i)=>i.includes("TTS_ENABLED")));
  assert.throws(()=>parseRuntimeConfig({...REQUIRED,TTS_SPEED:"4"}),(e)=>e instanceof RuntimeConfigError&&e.issues.some((i)=>i.includes("TTS_SPEED")));
});


test("TTS config rejects invalid limits and header controls without leaking the API key", () => {
  const secret = "tts-do-not-log-this";
  const fields = {
    TTS_SPEED: "NaN",
    TTS_MAX_TEXT_CHARACTERS: "5001",
    TTS_REQUEST_TIMEOUT_MS: "20001",
    TTS_REQUEST_MAX_RESPONSE_BYTES: "2097153",
    YANDEX_SPEECHKIT_API_KEY: secret + String.fromCharCode(13, 10) + "header",
  };
  assert.throws(() => parseRuntimeConfig({ ...REQUIRED, TTS_ENABLED: "true", ...fields }), (error) => {
    assert.ok(error instanceof RuntimeConfigError);
    for (const key of Object.keys(fields)) assert.ok(error.message.includes(key), key);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("boot infrastructure overrides preserve all SpeechKit settings", () => {
  const { applyBootInfrastructure } = require("../dist/config/runtime-settings.service");
  const config = parseRuntimeConfig({
    ...REQUIRED, TTS_ENABLED: "true", YANDEX_SPEECHKIT_API_KEY: "private-key",
    TTS_SPEED: "0.95", TTS_REQUEST_TIMEOUT_MS: "15000",
  });
  const merged = applyBootInfrastructure(config, { AI_REQUEST_CONCURRENCY: 3, LLM_REQUEST_TIMEOUT_MS: 1500 });
  assert.deepEqual(merged.tts, config.tts);
  assert.equal(merged.concurrency.aiRequests, 3);
  assert.equal(merged.externalRequests.llm.timeoutMs, 1500);
  assert.notEqual(config.externalRequests.llm.timeoutMs, 1500);
});
