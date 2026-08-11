import {
  EXTERNAL_REQUEST_LIMITS,
  RUNTIME_CONCURRENCY_LIMITS,
  RUNTIME_SHUTDOWN_LIMITS,
  VOICE_MESSAGE_LIMITS,
} from "./limits.config";

export interface RuntimeConfig {
  databaseUrl: string;
  telegramBotToken: string;
  cloudRuApiKey: string;
  jwtSecret: string;
  server: {
    port: number;
  };
  telegram: {
    apiTimeoutMs: number;
  };
  llm: {
    apiUrl: string;
    model: string;
    analysisMaxTokens: number;
    followUpMaxTokens: number;
  };
  concurrency: {
    telegramUpdates: number;
    aiRequests: number;
    aiRequestMaxPending: number;
  };
  shutdown: {
    drainTimeoutMs: number;
  };
  retention: {
    errorLogsDays: number;
    rateLimitDays: number;
    closedConversationContentDays: number;
  };
  voice: {
    maxDurationSeconds: number;
    maxFileSizeBytes: number;
  };
  externalRequests: {
    telegramFileDownload: RuntimeRequestLimits;
    whisper: RuntimeRequestLimits;
    llm: RuntimeRequestLimits;
  };
}

export interface RuntimeRequestLimits {
  timeoutMs: number;
  maxResponseBytes: number;
}

export class RuntimeConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid runtime configuration: ${issues.join("; ")}`);
    this.name = "RuntimeConfigError";
    this.issues = [...issues];
  }
}

interface NumberRule {
  defaultValue: number;
  min: number;
  max: number;
}

export function parseRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const issues: string[] = [];
  const databaseUrl = required(env, "DATABASE_URL", issues);
  const telegramBotToken = required(env, "TELEGRAM_BOT_TOKEN", issues);
  const cloudRuApiKey = required(env, "CLOUD_RU_API_KEY", issues);
  const jwtSecret = required(env, "JWT_SECRET", issues);
  if (jwtSecret === "default-secret-change-me") {
    issues.push("JWT_SECRET must not use the retired public fallback");
  }

  if (databaseUrl && !isUrl(databaseUrl, ["postgres:", "postgresql:"])) {
    issues.push("DATABASE_URL must be a valid PostgreSQL URL");
  }

  const llmApiUrl =
    optional(env, "LLM_API_URL") ||
    "https://foundation-models.api.cloud.ru/v1/chat/completions";
  if (!isUrl(llmApiUrl, ["http:", "https:"])) {
    issues.push("LLM_API_URL must be a valid HTTP(S) URL");
  }
  const llmModel = optional(env, "LLM_MODEL") || "zai-org/GLM-4.7";
  if (llmModel.length > 160 || /[\u0000-\u001f\u007f]/.test(llmModel)) {
    issues.push("LLM_MODEL must be a trimmed control-free string of at most 160 characters");
  }

  const number = (name: string, rule: NumberRule): number => {
    const raw = optional(env, name);
    if (raw === undefined) return rule.defaultValue;

    const parsed = Number(raw);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < rule.min ||
      parsed > rule.max
    ) {
      issues.push(
        `${name} must be an integer between ${rule.min} and ${rule.max}`,
      );
      return rule.defaultValue;
    }
    return parsed;
  };

  const telegramUpdates = number("TELEGRAM_UPDATE_CONCURRENCY", {
    defaultValue: RUNTIME_CONCURRENCY_LIMITS.telegramUpdates,
    min: 1,
    max: 100,
  });
  const port = number("PORT", {
    defaultValue: 3000,
    min: 1,
    max: 65_535,
  });
  const telegramApiTimeoutMs = number("TELEGRAM_API_TIMEOUT_MS", {
    defaultValue: 40_000,
    min: 5_000,
    max: 120_000,
  });
  const aiRequests = number("AI_REQUEST_CONCURRENCY", {
    defaultValue: RUNTIME_CONCURRENCY_LIMITS.aiRequests,
    min: 1,
    max: 50,
  });
  const aiRequestMaxPending = number("AI_REQUEST_MAX_PENDING", {
    defaultValue: RUNTIME_CONCURRENCY_LIMITS.aiRequestMaxPending,
    min: 0,
    max: 1000,
  });
  const drainTimeoutMs = number("RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS", {
    defaultValue: RUNTIME_SHUTDOWN_LIMITS.drainTimeoutMs,
    min: 100,
    max: 10 * 60_000,
  });
  const errorLogsDays = number("RETENTION_ERROR_LOGS_DAYS", {
    defaultValue: 30, min: 1, max: 3650,
  });
  const rateLimitDays = number("RETENTION_RATE_LIMIT_DAYS", {
    defaultValue: 30, min: 1, max: 3650,
  });
  const closedConversationContentDays = number(
    "RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS",
    { defaultValue: 30, min: 1, max: 3650 },
  );
  const analysisMaxTokens = number("LLM_ANALYSIS_MAX_TOKENS", {
    defaultValue: 2500,
    min: 64,
    max: 32_000,
  });
  const followUpMaxTokens = number("LLM_FOLLOWUP_MAX_TOKENS", {
    defaultValue: 1200,
    min: 64,
    max: 32_000,
  });
  const maxDurationSeconds = number("VOICE_MAX_DURATION_SECONDS", {
    defaultValue: VOICE_MESSAGE_LIMITS.maxDurationSeconds,
    min: 1,
    max: VOICE_MESSAGE_LIMITS.maxDurationSeconds,
  });
  const maxFileSizeBytes = number("VOICE_MAX_FILE_SIZE_BYTES", {
    defaultValue: VOICE_MESSAGE_LIMITS.maxFileSizeBytes,
    min: 1,
    max: VOICE_MESSAGE_LIMITS.maxFileSizeBytes,
  });

  const requestLimits = (
    prefix: string,
    defaults: RuntimeRequestLimits,
  ): RuntimeRequestLimits => ({
    timeoutMs: number(`${prefix}_TIMEOUT_MS`, {
      defaultValue: defaults.timeoutMs,
      min: 100,
      max: defaults.timeoutMs,
    }),
    maxResponseBytes: number(`${prefix}_MAX_RESPONSE_BYTES`, {
      defaultValue: defaults.maxResponseBytes,
      min: 1,
      max: defaults.maxResponseBytes,
    }),
  });

  const config: RuntimeConfig = {
    databaseUrl, jwtSecret,
    telegramBotToken,
    cloudRuApiKey,
    server: { port },
    telegram: { apiTimeoutMs: telegramApiTimeoutMs },
    llm: {
      apiUrl: llmApiUrl,
      model: llmModel,
      analysisMaxTokens,
      followUpMaxTokens,
    },
    concurrency: { telegramUpdates, aiRequests, aiRequestMaxPending },
    shutdown: { drainTimeoutMs },
    retention: { errorLogsDays, rateLimitDays, closedConversationContentDays },
    voice: { maxDurationSeconds, maxFileSizeBytes },
    externalRequests: {
      telegramFileDownload: requestLimits(
        "TELEGRAM_FILE_DOWNLOAD",
        EXTERNAL_REQUEST_LIMITS.telegramFileDownload,
      ),
      whisper: requestLimits(
        "WHISPER_REQUEST",
        EXTERNAL_REQUEST_LIMITS.whisper,
      ),
      llm: requestLimits("LLM_REQUEST", EXTERNAL_REQUEST_LIMITS.llm),
    },
  };

  if (issues.length > 0) throw new RuntimeConfigError(issues);
  return config;
}

function required(
  env: NodeJS.ProcessEnv,
  name: string,
  issues: string[],
): string {
  const value = optional(env, name);
  if (value === undefined) {
    issues.push(`${name} is required`);
    return "";
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function isUrl(value: string, allowedProtocols: readonly string[]): boolean {
  try {
    return allowedProtocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
