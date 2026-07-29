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

export const DEFAULT_USER_TIMEZONE = "Europe/Moscow";
