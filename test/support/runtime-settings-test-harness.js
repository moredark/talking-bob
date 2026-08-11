const DEFAULTS = Object.freeze({
  VOICE_RESPONSE_MAX_REQUESTS: 10,
  VOICE_RESPONSE_WINDOW_MINUTES: 60,
  COMMAND_MAX_REQUESTS: 30,
  COMMAND_WINDOW_MINUTES: 60,
  DIALOGS_PER_DAY: 20,
  LLM_ANALYSIS_MAX_TOKENS: 256,
  LLM_FOLLOWUP_MAX_TOKENS: 128,
  VOICE_MAX_DURATION_SECONDS: 300,
  VOICE_MAX_FILE_SIZE_BYTES: 20 * 1024 * 1024,
  RETENTION_ERROR_LOGS_DAYS: 30,
  RETENTION_RATE_LIMIT_DAYS: 30,
  RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS: 30,
});

const TEST_RUNTIME_SETTINGS = Object.freeze({
  productNumber(key) {
    if (!(key in DEFAULTS)) throw new Error(`Missing test runtime setting: ${key}`);
    return DEFAULTS[key];
  },
});

function installRuntimeSettings(...classes) {
  for (const Type of classes) {
    Object.defineProperty(Type.prototype, "settings", {
      configurable: true,
      writable: true,
      value: TEST_RUNTIME_SETTINGS,
    });
  }
}

module.exports = { installRuntimeSettings, TEST_RUNTIME_SETTINGS };
