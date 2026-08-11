import { EXTERNAL_REQUEST_LIMITS, RATE_LIMITS, RUNTIME_CONCURRENCY_LIMITS, RUNTIME_SHUTDOWN_LIMITS, VOICE_MESSAGE_LIMITS } from "./limits.config";

export type RuntimeSettingGroup = "product" | "infrastructure" | "readonly" | "secret";
export type RuntimeSettingValue = string | number;
export interface RuntimeSettingDefinition {
  key: string;
  group: RuntimeSettingGroup;
  description: string;
  type: "integer" | "string";
  defaultValue?: RuntimeSettingValue;
  min?: number;
  max?: number;
  consumer: string;
  envKey?: string;
  applyMode: "hot" | "restart" | "readonly" | "secret";
}
type RuntimeSettingBaseDefinition = Omit<RuntimeSettingDefinition, "consumer" | "envKey">;


const integer = (key: string, group: "product" | "infrastructure", description: string, defaultValue: number, min: number, max: number): RuntimeSettingBaseDefinition => ({
  key, group, description, type: "integer", defaultValue, min, max,
  applyMode: group === "product" ? "hot" : "restart",
});

const RUNTIME_SETTINGS_BASE = [
  integer("VOICE_RESPONSE_MAX_REQUESTS", "product", "Voice responses per rolling window", RATE_LIMITS.voice_response.maxRequests, 1, 1000),
  integer("VOICE_RESPONSE_WINDOW_MINUTES", "product", "Voice response rolling window", RATE_LIMITS.voice_response.windowMinutes, 1, 10080),
  integer("COMMAND_MAX_REQUESTS", "product", "Commands per rolling window", RATE_LIMITS.command.maxRequests, 1, 1000),
  integer("COMMAND_WINDOW_MINUTES", "product", "Command rolling window", RATE_LIMITS.command.windowMinutes, 1, 10080),
  integer("DIALOGS_PER_DAY", "product", "Dialogs per Moscow calendar day", RATE_LIMITS.dialog_start.maxRequests, 1, 1000),
  integer("LLM_ANALYSIS_MAX_TOKENS", "product", "Analysis token cap", 2500, 64, 32000),
  integer("LLM_FOLLOWUP_MAX_TOKENS", "product", "Follow-up token cap", 1200, 64, 32000),
  integer("VOICE_MAX_DURATION_SECONDS", "product", "Voice duration cap", VOICE_MESSAGE_LIMITS.maxDurationSeconds, 1, VOICE_MESSAGE_LIMITS.maxDurationSeconds),
  integer("VOICE_MAX_FILE_SIZE_BYTES", "product", "Voice file size cap", VOICE_MESSAGE_LIMITS.maxFileSizeBytes, 1, VOICE_MESSAGE_LIMITS.maxFileSizeBytes),
  integer("RETENTION_ERROR_LOGS_DAYS", "product", "Error-log retention", 30, 1, 3650),
  integer("RETENTION_RATE_LIMIT_DAYS", "product", "Rate-limit retention", 30, 1, 3650),
  integer("RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS", "product", "Closed session content retention", 30, 1, 3650),
  { key: "LLM_MODEL", group: "infrastructure", description: "LLM provider model", type: "string", defaultValue: "zai-org/GLM-4.7", applyMode: "restart" },
  integer("TELEGRAM_UPDATE_CONCURRENCY", "infrastructure", "Telegram update concurrency", RUNTIME_CONCURRENCY_LIMITS.telegramUpdates, 1, 100),
  integer("AI_REQUEST_CONCURRENCY", "infrastructure", "AI request concurrency", RUNTIME_CONCURRENCY_LIMITS.aiRequests, 1, 50),
  integer("AI_REQUEST_MAX_PENDING", "infrastructure", "AI pending queue bound", RUNTIME_CONCURRENCY_LIMITS.aiRequestMaxPending, 0, 1000),
  integer("TELEGRAM_API_TIMEOUT_MS", "infrastructure", "Telegram API timeout", 40000, 5000, 120000),
  integer("TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS", "infrastructure", "Telegram file timeout", EXTERNAL_REQUEST_LIMITS.telegramFileDownload.timeoutMs, 100, EXTERNAL_REQUEST_LIMITS.telegramFileDownload.timeoutMs),
  integer("TELEGRAM_FILE_DOWNLOAD_MAX_RESPONSE_BYTES", "infrastructure", "Telegram file response bound", EXTERNAL_REQUEST_LIMITS.telegramFileDownload.maxResponseBytes, 1, EXTERNAL_REQUEST_LIMITS.telegramFileDownload.maxResponseBytes),
  integer("WHISPER_REQUEST_TIMEOUT_MS", "infrastructure", "Whisper timeout", EXTERNAL_REQUEST_LIMITS.whisper.timeoutMs, 100, EXTERNAL_REQUEST_LIMITS.whisper.timeoutMs),
  integer("WHISPER_REQUEST_MAX_RESPONSE_BYTES", "infrastructure", "Whisper response bound", EXTERNAL_REQUEST_LIMITS.whisper.maxResponseBytes, 1, EXTERNAL_REQUEST_LIMITS.whisper.maxResponseBytes),
  integer("LLM_REQUEST_TIMEOUT_MS", "infrastructure", "LLM timeout", EXTERNAL_REQUEST_LIMITS.llm.timeoutMs, 100, EXTERNAL_REQUEST_LIMITS.llm.timeoutMs),
  integer("LLM_REQUEST_MAX_RESPONSE_BYTES", "infrastructure", "LLM response bound", EXTERNAL_REQUEST_LIMITS.llm.maxResponseBytes, 1, EXTERNAL_REQUEST_LIMITS.llm.maxResponseBytes),
  integer("RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS", "infrastructure", "Shutdown drain timeout", RUNTIME_SHUTDOWN_LIMITS.drainTimeoutMs, 100, 600000),
  ...[
    "PORT", "LLM_API_URL", "ADMIN_CORS_ORIGIN", "ADMIN_PORT", "ADMIN_USERNAME",
    "POSTGRES_USER", "POSTGRES_DB", "TALKING_BOB_RUNTIME_IMAGE",
    "TALKING_BOB_RUNTIME_DIGEST", "TALKING_BOB_INIT_IMAGE",
    "TALKING_BOB_INIT_DIGEST", "TALKING_BOB_ADMIN_IMAGE",
    "TALKING_BOB_ADMIN_DIGEST",
  ].map((key) => ({
    key, group: "readonly" as const, description: key,
    type: ["PORT", "ADMIN_PORT"].includes(key) ? "integer" as const : "string" as const,
    applyMode: "readonly" as const,
  })),
  ...["DATABASE_URL", "TELEGRAM_BOT_TOKEN", "CLOUD_RU_API_KEY", "JWT_SECRET", "ADMIN_PASSWORD", "POSTGRES_PASSWORD"].map((key) => ({ key, group: "secret" as const, description: key, type: "string" as const, applyMode: "secret" as const })),
] as const satisfies readonly RuntimeSettingBaseDefinition[];

const CONSUMERS: Readonly<Record<string, string>> = {
  VOICE_RESPONSE_MAX_REQUESTS: "RateLimitService", VOICE_RESPONSE_WINDOW_MINUTES: "RateLimitService",
  COMMAND_MAX_REQUESTS: "RateLimitService", COMMAND_WINDOW_MINUTES: "RateLimitService",
  DIALOGS_PER_DAY: "StartHandler", LLM_ANALYSIS_MAX_TOKENS: "LLMService",
  LLM_FOLLOWUP_MAX_TOKENS: "LLMService", VOICE_MAX_DURATION_SECONDS: "VoiceHandler",
  VOICE_MAX_FILE_SIZE_BYTES: "VoiceHandler", RETENTION_ERROR_LOGS_DAYS: "DataRetentionService",
  RETENTION_RATE_LIMIT_DAYS: "DataRetentionService", RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS: "DataRetentionService",
  LLM_MODEL: "LLMService", TELEGRAM_UPDATE_CONCURRENCY: "TelegramService",
  AI_REQUEST_CONCURRENCY: "AiRequestLimiterService", AI_REQUEST_MAX_PENDING: "AiRequestLimiterService",
  TELEGRAM_API_TIMEOUT_MS: "TelegramService", TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS: "TelegramFileService",
  TELEGRAM_FILE_DOWNLOAD_MAX_RESPONSE_BYTES: "TelegramFileService", WHISPER_REQUEST_TIMEOUT_MS: "WhisperService",
  WHISPER_REQUEST_MAX_RESPONSE_BYTES: "WhisperService", LLM_REQUEST_TIMEOUT_MS: "LLMService",
  LLM_REQUEST_MAX_RESPONSE_BYTES: "LLMService", RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS: "TelegramService",
};

const NO_ENV_KEYS = new Set([
  "VOICE_RESPONSE_MAX_REQUESTS", "VOICE_RESPONSE_WINDOW_MINUTES", "COMMAND_MAX_REQUESTS",
  "COMMAND_WINDOW_MINUTES", "DIALOGS_PER_DAY",
]);

export const RUNTIME_SETTINGS_REGISTRY: readonly RuntimeSettingDefinition[] = RUNTIME_SETTINGS_BASE.map((entry) => ({
  ...entry,
  consumer: CONSUMERS[entry.key] ?? "bootstrap",
  envKey: NO_ENV_KEYS.has(entry.key) ? undefined : entry.key,
}));
export const PRODUCT_SETTING_KEYS = RUNTIME_SETTINGS_REGISTRY.filter((entry) => entry.group === "product").map(({ key }) => key);
export const INFRASTRUCTURE_SETTING_KEYS = RUNTIME_SETTINGS_REGISTRY.filter((entry) => entry.group === "infrastructure").map(({ key }) => key);

export function validateRuntimeOverride(entry: RuntimeSettingDefinition, value: unknown): value is RuntimeSettingValue {
  if (entry.type === "integer") return typeof value === "number" && Number.isSafeInteger(value) && value >= (entry.min ?? 0) && value <= (entry.max ?? Number.MAX_SAFE_INTEGER);
  return typeof value === "string" && value.trim().length >= 1 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeRuntimeOverride(entry: RuntimeSettingDefinition, value: RuntimeSettingValue): RuntimeSettingValue {
  return entry.type === "string" ? String(value).trim() : value;
}

export function registryEntry(key: string): RuntimeSettingDefinition | undefined {
  return RUNTIME_SETTINGS_REGISTRY.find((entry) => entry.key === key);
}
