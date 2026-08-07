export const RATE_LIMITS = {
  voice_response: {
    maxRequests: 10,
    windowMinutes: 60,
  },
  command: {
    maxRequests: 30,
    windowMinutes: 60,
  },
  dialog_start: {
    maxRequests: 20,
  },
} as const;

export const VOICE_MESSAGE_LIMITS = {
  maxDurationSeconds: 5 * 60,
  maxFileSizeBytes: 20 * 1024 * 1024,
} as const;

export const EXTERNAL_REQUEST_LIMITS = {
  telegramFileDownload: {
    timeoutMs: 30_000,
    maxResponseBytes: VOICE_MESSAGE_LIMITS.maxFileSizeBytes,
  },
  whisper: {
    timeoutMs: 120_000,
    maxResponseBytes: 1024 * 1024,
  },
  llm: {
    timeoutMs: 90_000,
    maxResponseBytes: 1024 * 1024,
  },
} as const;

export const RUNTIME_CONCURRENCY_LIMITS = {
  telegramUpdates: 4,
  aiRequests: 2,
  aiRequestMaxPending: 8,
} as const;

export const RUNTIME_SHUTDOWN_LIMITS = {
  drainTimeoutMs: 30_000,
} as const;

export const DEFAULT_USER_TIMEZONE = "Europe/Moscow";
