export const ADMIN_ERROR_TYPES = ["ai", "telegram", "system"] as const;
export const ADMIN_ERROR_SERVICES = [
  "whisper", "llm", "tts", "telegram", "scheduler", "general",
] as const;
export const ADMIN_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const ADMIN_PROMPT_TAGS = [
  "grammar", "vocabulary", "tense", "pronunciation", "fluency", "conversation",
] as const;
export const ADMIN_LANGUAGE_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export const ADMIN_USER_STATUSES = ["active", "banned"] as const;

export type AdminErrorType = (typeof ADMIN_ERROR_TYPES)[number];
export type AdminErrorService = (typeof ADMIN_ERROR_SERVICES)[number];
export type PromptDifficulty = (typeof ADMIN_DIFFICULTIES)[number];
export type PromptTag = (typeof ADMIN_PROMPT_TAGS)[number];
export type LanguageLevel = (typeof ADMIN_LANGUAGE_LEVELS)[number];
export type UserStatus = (typeof ADMIN_USER_STATUSES)[number];

export interface PaginationQuery { page: number; limit: number }
export interface ErrorLogsQuery extends PaginationQuery {
  type?: AdminErrorType;
  service?: AdminErrorService;
  correlationId?: string;
}

export interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  newUsersThisWeek: number;
  totalPromptsSent: number;
  totalResponses: number;
  responseRate: number;
  averageScore: number | null;
  usersWithDailyEnabled: number;
}

export interface UserListItem {
  id: string;
  telegramId: string;
  username: string | null;
  createdAt: Date;
  dailyPromptEnabled: boolean;
  promptsReceived: number;
  responsesCount: number;
  averageScore: number | null;
  lastActivityAt: Date | null;
}

export interface UserDetail {
  id: string;
  telegramId: string;
  username: string | null;
  createdAt: Date;
  dailyPromptEnabled: boolean;
  dailyPromptHour: number;
  dailyPromptMinute: number;
  timezone: string;
  languageLevel: string | null;
  status: string;
  bannedAt: Date | null;
  bannedReason: string | null;
  promptsReceived: number;
  responsesCount: number;
  averageScore: number | null;
}

export interface TopicStats {
  id: string;
  topic: string;
  isActive: boolean;
  timesSent: number;
  responsesCount: number;
  responseRate: number;
  averageScore: number | null;
}

export interface PromptItem {
  id: string;
  topic: string;
  textContent: string | null;
  audioFileId: string | null;
  difficulty: string;
  tags: string[];
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  timesSent: number;
}

export interface CreatePromptDto {
  topic: string;
  textContent?: string;
  audioFileId?: string | null;
  difficulty?: PromptDifficulty;
  tags?: PromptTag[];
  isActive?: boolean;
  sortOrder?: number;
}
export type UpdatePromptDto = Partial<CreatePromptDto>;

export interface UpdateUserDto {
  dailyPromptEnabled?: boolean;
  languageLevel?: LanguageLevel | null;
  status?: UserStatus;
  bannedReason?: string;
}

export interface ErrorLogItem {
  id: string;
  type: string;
  service: string;
  operation: string;
  correlationId: string | null;
  statusCode: number | null;
  retryable: boolean | null;
  latencyMs: number | null;
  errorKind: string;
  message: string;
  stack: null;
  metadata: Record<string, string | number | boolean> | null;
  userId: string | null;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const ADMIN_AUDIT_ACTIONS = [
  "user.update",
  "user.reset_progress",
  "prompt.create",
  "prompt.update",
  "prompt.delete",
  "error_log.clear_old",
  "settings.product.update",
  "settings.infrastructure.update",
  "broadcast.create",
  "broadcast.cancel",
] as const;
export const ADMIN_AUDIT_ENTITY_TYPES = ["user", "prompt", "error_log", "runtime_settings", "broadcast"] as const;
export const ADMIN_AUDIT_OUTCOMES = ["success", "failure"] as const;
export const ADMIN_AUDIT_FAILURE_CODES = [
  "validation_failed",
  "not_found",
  "conflict",
  "audit_write_failed",
  "internal_error",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];
export type AdminAuditEntityType = (typeof ADMIN_AUDIT_ENTITY_TYPES)[number];
export type AdminAuditOutcome = (typeof ADMIN_AUDIT_OUTCOMES)[number];
export type AdminAuditFailureCode = (typeof ADMIN_AUDIT_FAILURE_CODES)[number];

export interface AdminAuditLogsQuery extends PaginationQuery {
  actorId?: string;
  action?: AdminAuditAction;
  entityType?: AdminAuditEntityType;
  entityId?: string;
  outcome?: AdminAuditOutcome;
  from?: Date;
  to?: Date;
}
export const ADMIN_SESSION_SOURCES = ["manual", "scheduled", "legacy"] as const;
export const ADMIN_SESSION_DELIVERY_STATUSES = ["pending", "sent", "failed"] as const;
export const ADMIN_CONVERSATION_STATUSES = ["open", "closed"] as const;
export const ADMIN_GENERATION_STATUSES = ["generating", "generated", "failed"] as const;

export interface AdminSessionsQuery extends PaginationQuery {
  userId?: string;
  topic?: string;
  source?: (typeof ADMIN_SESSION_SOURCES)[number];
  deliveryStatus?: (typeof ADMIN_SESSION_DELIVERY_STATUSES)[number];
  conversationStatus?: (typeof ADMIN_CONVERSATION_STATUSES)[number];
  generationStatus?: (typeof ADMIN_GENERATION_STATUSES)[number];
  from?: Date;
  to?: Date;
}

export interface AdminSessionListItem {
  id: string;
  user: { id: string; telegramId: string; username: string | null };
  prompt: { id: string; topic: string };
  source: (typeof ADMIN_SESSION_SOURCES)[number];
  deliveryStatus: (typeof ADMIN_SESSION_DELIVERY_STATUSES)[number];
  conversationStatus: (typeof ADMIN_CONVERSATION_STATUSES)[number];
  generationStatus: (typeof ADMIN_GENERATION_STATUSES)[number] | null;
  turnCount: number;
  createdAt: Date;
  sentAt: Date | null;
  conversationClosedAt: Date | null;
  generatedAt: Date | null;
  contentPurged: boolean;
}

export type AdminSessionAnalysis =
  | { kind: "model" | "fallback"; version: 1; summary: string; improvementPoints: string[]; overallScore: number }
  | { kind: "legacy"; raw: string };

export interface AdminSessionDetail extends AdminSessionListItem {
  contentPurgedAt: Date | null;
  aiTracePurgedAt: Date | null;
  delivery: {
    scheduledFor: Date | null;
    deliveryAttemptedAt: Date | null;
    lastErrorCode: string | null;
    lastErrorAt: Date | null;
  };
  messages: Array<{ id: string; role: string; content: string | null; voiceFileId: string | null; createdAt: Date }>;
  response: {
    id: string;
    transcript: string | null;
    analysis: AdminSessionAnalysis | null;
    generationStatus: (typeof ADMIN_GENERATION_STATUSES)[number];
    generationAttemptedAt: Date;
    generatedAt: Date | null;
    lastErrorCode: string | null;

    lastErrorAt: Date | null;
    sensitiveDataPurgedAt: Date | null;
    createdAt: Date;
  } | null;
  reportDeliveries: Array<{
    id: string; status: "pending" | "delivered" | "failed"; nextChunkIndex: number;
    deliveryAttemptedAt: Date | null; deliveredAt: Date | null;
    lastErrorCode: string | null; lastErrorAt: Date | null;
    createdAt: Date; updatedAt: Date;
  }>;
  providerCalls: Array<{
    id: string; operation: "follow_up" | "analysis"; provider: string; model: string;
    attempt: number; outcome: "succeeded" | "empty" | "failed"; statusCode: number | null;
    latencyMs: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
    responseContent: string | null; failureCode: string | null;
    correlationId: string | null; requestId: string | null; createdAt: Date;
  }>;
}

export interface AdminAuditListItem {
  id: string;
  actorId: string;
  actorUsername: string;
  action: AdminAuditAction;
  entityType: AdminAuditEntityType;
  entityId: string | null;
  outcome: AdminAuditOutcome;
  requestId: string;
  correlationId: string;
  failureCode: AdminAuditFailureCode | null;
  createdAt: Date;
}

export interface AdminAuditDetail extends AdminAuditListItem {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export type AdminRuntimeSettingValue = string | number;
export type AdminRuntimeSettingSource = "override" | "env" | "default";

export interface AdminRuntimeSettingEntry {
  key: string;
  description: string;
  consumer: string;
  type: "integer" | "string";
  min?: number;
  max?: number;
  envValue: AdminRuntimeSettingValue | null;
  overrideValue: AdminRuntimeSettingValue | null;
  effectiveValue: AdminRuntimeSettingValue;
  pendingValue: AdminRuntimeSettingValue;
  source: AdminRuntimeSettingSource;
  applyMode: "hot" | "restart";
  restartRequired: boolean;
}

export interface AdminRuntimeSettingsGroup {
  version: number;
  applyMode: "hot" | "restart";
  restartRequired: boolean;
  entries: AdminRuntimeSettingEntry[];
}

export interface AdminReadonlySettingEntry {
  key: string;
  description: string;
  consumer: string;
  value?: AdminRuntimeSettingValue | null;
  configured?: boolean;
  source: "env" | "default";
  applyMode: "readonly";
}

export interface AdminSecretSettingEntry {
  key: string;
  description: string;
  configured: boolean;
}

export interface AdminRuntimeSettingsResponse {
  product: AdminRuntimeSettingsGroup;
  infrastructure: AdminRuntimeSettingsGroup;
  readonly: AdminReadonlySettingEntry[];
  secret: AdminSecretSettingEntry[];
}

export interface UpdateRuntimeSettingsDto {
  expectedVersion: number;
  values: Record<string, AdminRuntimeSettingValue | null>;
}

export * from "../broadcast/broadcast.contracts";

export type AnalyticsDays = 7 | 30 | 90;
export type RetentionPoint = { retainedUsers: number; ratePct: number | null };
export type RetentionSummary = { eligibleUsers: number; retainedUsers: number; ratePct: number };
export type TokenUsage = { callsWithUsage: number; sum: number | null; usageCoveragePct: number | null };

export interface AdminAnalytics {
  version: 1;
  generatedAt: Date;
  timezone: "Europe/Moscow";
  days: AnalyticsDays;
  period: { startAt: Date; endAt: Date; observedThrough: Date };
  coverage: {
    status: "complete" | "partial" | "unavailable";
    completeFrom: Date;
    incompleteBefore: Date | null;
  };
  daily: Array<{
    localDate: string; startAt: Date; endAt: Date;
    newUsers: number; activeUsers: number; promptsSent: number; responsesReceived: number;
  }>;
  funnel: {
    population: "sent_prompts";
    responseRatePct: number | null;
    stages: Array<{
      key: "sent" | "message" | "closed" | "generated" | "delivered";
      count: number; rateFromSentPct: number | null;
      dropOffFromPreviousCount: number | null; dropOffFromPreviousPct: number | null;
    }>;
  };
  retention: {
    cohorts: Array<{
      localDate: string; cohortSize: number;
      d1: RetentionPoint | null; d7: RetentionPoint | null; d30: RetentionPoint | null;
    }>;
    summary: { d1: RetentionSummary | null; d7: RetentionSummary | null; d30: RetentionSummary | null };
  };
  scores: {
    generatedModelLegacyCount: number; scoredCount: number; invalidScoreCount: number; fallbackCount: number;
    averageScore: number | null;
    distribution: Array<{ score: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10; count: number }>;
    topics: Array<{ topic: string; reportCount: number; scoredCount: number; invalidScoreCount: number; fallbackCount: number; averageScore: number | null }>;
  };
  ai: {
    coverageFrom: Date | null;
    outcomes: { total: number; succeeded: number; empty: number; failed: number; successRatePct: number | null };
    latency: { averageMs: number | null; p50Ms: number | null; p95Ms: number | null; daily: Array<{ localDate: string; calls: number; averageMs: number | null; p95Ms: number | null }> };
    tokens: { input: TokenUsage; output: TokenUsage; total: TokenUsage };
  };
  broadcasts: {
    terminal: { total: number; completed: number; completedWithErrors: number; cancelled: number };
    recipients: { total: number; sent: number; failed: number; ambiguous: number; skipped: number; deliveryRatePct: number | null };
    errorCodes: Array<{ code: string; count: number }>;
  };
}
