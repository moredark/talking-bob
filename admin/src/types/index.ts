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
  createdAt: string;
  dailyPromptEnabled: boolean;
  promptsReceived: number;
  responsesCount: number;
  averageScore: number | null;
  lastActivityAt: string | null;
}

export interface UserDetail {
  id: string;
  telegramId: string;
  username: string | null;
  createdAt: string;
  dailyPromptEnabled: boolean;
  dailyPromptHour: number;
  dailyPromptMinute: number;
  timezone: string;
  languageLevel: string | null;
  status: string;
  bannedAt: string | null;
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

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    username: string;
  };
}

export interface AdminUser {
  id: string;
  username: string;
  createdAt: string;
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
  createdAt: string;
  timesSent: number;
}

export interface CreatePromptDto {
  topic: string;
  textContent?: string;
  audioFileId?: string | null;
  difficulty?: string;
  tags?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdatePromptDto {
  topic?: string;
  textContent?: string;
  audioFileId?: string | null;
  difficulty?: string;
  tags?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

export interface Personality {
  id: string;
  key: string;
  name: string;
  description: string;
  followUpStylePrompt: string;
  analysisStylePrompt: string;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  selectedUsersCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalityRules {
  id: "default";
  followUpPrompt: string;
  analysisPrompt: string;
  updatedAt: string;
}

export interface UpdatePersonalityRulesDto {
  followUpPrompt: string;
  analysisPrompt: string;
}

export interface CreatePersonalityDto {
  key: string;
  name: string;
  description?: string;
  followUpStylePrompt: string;
  analysisStylePrompt: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdatePersonalityDto {
  name?: string;
  description?: string;
  followUpStylePrompt?: string;
  analysisStylePrompt?: string;
  sortOrder?: number;
}

export interface UpdateUserDto {
  dailyPromptEnabled?: boolean;
  languageLevel?: string | null;
  status?: string;
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
  stack: string | null;
  metadata: unknown;
  userId: string | null;
  createdAt: string;
}

export type AdminAuditOutcome = "success" | "failure";

export interface AdminAuditListItem {
  id: string;
  actorId: string;
  actorUsername: string;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: AdminAuditOutcome;
  requestId: string;
  correlationId: string;
  failureCode: string | null;
  createdAt: string;
}

export interface AdminAuditDetail extends AdminAuditListItem {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface AuditLogFilters {
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  outcome?: AdminAuditOutcome;
  from?: string;
  to?: string;
}

export type AdminSessionSource = "manual" | "scheduled" | "legacy";
export type AdminSessionDeliveryStatus = "pending" | "sent" | "failed";
export type AdminConversationStatus = "open" | "closed";
export type AdminGenerationStatus = "generating" | "generated" | "failed";

export interface AdminSessionsFilters {
  userId?: string;
  topic?: string;
  source?: AdminSessionSource;
  deliveryStatus?: AdminSessionDeliveryStatus;
  conversationStatus?: AdminConversationStatus;
  generationStatus?: AdminGenerationStatus;
  from?: string;
  to?: string;
}

export interface AdminSessionListItem {
  id: string;
  user: { id: string; telegramId: string; username: string | null };
  prompt: { id: string; topic: string };
  source: AdminSessionSource;
  deliveryStatus: AdminSessionDeliveryStatus;
  conversationStatus: AdminConversationStatus;
  generationStatus: AdminGenerationStatus | null;
  turnCount: number;
  createdAt: string;
  sentAt: string | null;
  conversationClosedAt: string | null;
  generatedAt: string | null;
  contentPurged: boolean;
}

export type AdminSessionAnalysis =
  | {
      kind: "model" | "fallback";
      version: 1;
      summary: string;
      improvementPoints: string[];
      overallScore: number;
    }
  | { kind: "legacy"; raw: string };

export interface AdminSessionDetail extends AdminSessionListItem {
  contentPurgedAt: string | null;
  aiTracePurgedAt: string | null;
  delivery: {
    scheduledFor: string | null;
    deliveryAttemptedAt: string | null;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
  };
  messages: Array<{
    id: string;
    role: string;
    content: string | null;
    voiceFileId: string | null;
    createdAt: string;
  }>;
  response: {
    id: string;
    transcript: string | null;
    analysis: AdminSessionAnalysis | null;
    generationStatus: AdminGenerationStatus;
    generationAttemptedAt: string;
    generatedAt: string | null;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
    sensitiveDataPurgedAt: string | null;
    createdAt: string;
  } | null;
  reportDeliveries: Array<{
    id: string;
    status: "pending" | "delivered" | "failed";
    nextChunkIndex: number;
    deliveryAttemptedAt: string | null;
    deliveredAt: string | null;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  providerCalls: Array<{
    id: string;
    operation: "follow_up" | "analysis";
    provider: string;
    model: string;
    attempt: number;
    outcome: "succeeded" | "empty" | "failed";
    statusCode: number | null;
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    responseContent: string | null;
    failureCode: string | null;
    correlationId: string | null;
    requestId: string | null;
    createdAt: string;
  }>;
}

export type RuntimeSettingValue = string | number;
export type RuntimeSettingSource = "override" | "env" | "default";
export type RuntimeSettingApplyMode = "hot" | "restart";

export interface AdminRuntimeSettingEntry {
  key: string;
  description: string;
  consumer: string;
  type: "integer" | "string";
  min?: number;
  max?: number;
  envValue: RuntimeSettingValue | null;
  overrideValue: RuntimeSettingValue | null;
  effectiveValue: RuntimeSettingValue;
  pendingValue: RuntimeSettingValue;
  source: RuntimeSettingSource;
  applyMode: RuntimeSettingApplyMode;
  restartRequired: boolean;
}

export interface AdminRuntimeSettingsGroup {
  version: number;
  applyMode: RuntimeSettingApplyMode;
  restartRequired: boolean;
  entries: AdminRuntimeSettingEntry[];
}

export interface AdminRuntimeReadonlyEntry {
  key: string;
  description: string;
  consumer: string;
  value?: string | number;
  configured?: boolean;
  source: string;
  applyMode: "readonly";
}

export interface AdminRuntimeSecretEntry {
  key: string;
  description: string;
  configured: boolean;
}

export interface AdminRuntimeSettings {
  product: AdminRuntimeSettingsGroup;
  infrastructure: AdminRuntimeSettingsGroup;
  readonly: AdminRuntimeReadonlyEntry[];
  secret: AdminRuntimeSecretEntry[];
}

export interface UpdateRuntimeSettingsDto {
  expectedVersion: number;
  values: Record<string, RuntimeSettingValue | null>;
}

export type BroadcastMode = "immediate" | "scheduled";
export type BroadcastStatus =
  | "queued"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "cancelled";
export type BroadcastRecipientStatus =
  | "pending"
  | "sent"
  | "failed"
  | "ambiguous"
  | "skipped";
export type BroadcastActivity = "any" | "7d" | "30d" | "90d" | "never";
export type BroadcastDailyPromptFilter = "any" | true | false;
export type LanguageLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export interface BroadcastFilters {
  languageLevels: LanguageLevel[];
  activity: BroadcastActivity;
  dailyPromptEnabled: BroadcastDailyPromptFilter;
}

export interface CreateBroadcastDto {
  content: string;
  filters: BroadcastFilters;
  mode: BroadcastMode;
  scheduledFor?: string | null;
}

export interface BroadcastPreview {
  normalized: {
    content: string;
    filters: BroadcastFilters;
    mode: BroadcastMode;
    scheduledFor: string | null;
    scheduledAt: string;
  };
  audienceCount: number;
}

export interface BroadcastCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  ambiguous: number;
  skipped: number;
}

export interface BroadcastListItem {
  id: string;
  content: string | null;
  contentPurged: boolean;
  filters: BroadcastFilters;
  mode: BroadcastMode;
  status: BroadcastStatus;
  scheduledFor: string | null;
  scheduledAt: string;
  counts: BroadcastCounts;
  createdBy: { id: string; username: string };
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface BroadcastRecipientItem {
  id: string;
  user: {
    id: string;
    telegramId: string;
    username: string | null;
    languageLevel: string | null;
    dailyPromptEnabled: boolean;
    announcementEnabled: boolean;
  };
  status: BroadcastRecipientStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  deliveryAttemptedAt: string | null;
  sentAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastDetail extends BroadcastListItem {
  recipients: PaginatedResult<BroadcastRecipientItem>;
}

export interface BroadcastListFilters {
  status?: BroadcastStatus;
  from?: string;
  to?: string;
}

export interface BroadcastRecipientFilters {
  recipientStatus?: BroadcastRecipientStatus;
}

export type AnalyticsDays = 7 | 30 | 90;

export interface AnalyticsDailyBucket {
  localDate: string;
  startAt: string;
  endAt: string;
  newUsers: number;
  activeUsers: number;
  promptsSent: number;
  responsesReceived: number;
}

export type AnalyticsFunnelStageKey =
  | "sent"
  | "message"
  | "closed"
  | "generated"
  | "delivered";

export interface AnalyticsFunnelStage {
  key: AnalyticsFunnelStageKey;
  count: number;
  rateFromSentPct: number | null;
  dropOffFromPreviousCount: number | null;
  dropOffFromPreviousPct: number | null;
}

export interface AnalyticsRetentionPoint {
  retainedUsers: number;
  ratePct: number | null;
}

export interface AnalyticsRetentionSummary {
  eligibleUsers: number;
  retainedUsers: number;
  ratePct: number;
}

export interface AnalyticsTokenUsage {
  callsWithUsage: number;
  sum: number | null;
  usageCoveragePct: number | null;
}

export interface AdminAnalytics {
  version: 1;
  generatedAt: string;
  timezone: "Europe/Moscow";
  days: AnalyticsDays;
  period: {
    startAt: string;
    endAt: string;
    observedThrough: string;
  };
  coverage: {
    status: "complete" | "partial" | "unavailable";
    completeFrom: string;
    incompleteBefore: string | null;
  };
  daily: AnalyticsDailyBucket[];
  funnel: {
    population: "sent_prompts";
    responseRatePct: number | null;
    stages: AnalyticsFunnelStage[];
  };
  retention: {
    cohorts: Array<{
      localDate: string;
      cohortSize: number;
      d1: AnalyticsRetentionPoint | null;
      d7: AnalyticsRetentionPoint | null;
      d30: AnalyticsRetentionPoint | null;
    }>;
    summary: {
      d1: AnalyticsRetentionSummary | null;
      d7: AnalyticsRetentionSummary | null;
      d30: AnalyticsRetentionSummary | null;
    };
  };
  scores: {
    generatedModelLegacyCount: number;
    scoredCount: number;
    invalidScoreCount: number;
    fallbackCount: number;
    averageScore: number | null;
    distribution: Array<{
      score: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
      count: number;
    }>;
    topics: Array<{
      topic: string;
      reportCount: number;
      scoredCount: number;
      invalidScoreCount: number;
      fallbackCount: number;
      averageScore: number | null;
    }>;
  };
  ai: {
    coverageFrom: string | null;
    outcomes: {
      total: number;
      succeeded: number;
      empty: number;
      failed: number;
      successRatePct: number | null;
    };
    latency: {
      averageMs: number | null;
      p50Ms: number | null;
      p95Ms: number | null;
      daily: Array<{
        localDate: string;
        calls: number;
        averageMs: number | null;
        p95Ms: number | null;
      }>;
    };
    tokens: {
      input: AnalyticsTokenUsage;
      output: AnalyticsTokenUsage;
      total: AnalyticsTokenUsage;
    };
  };
  broadcasts: {
    terminal: {
      total: number;
      completed: number;
      completedWithErrors: number;
      cancelled: number;
    };
    recipients: {
      total: number;
      sent: number;
      failed: number;
      ambiguous: number;
      skipped: number;
      deliveryRatePct: number | null;
    };
    errorCodes: Array<{ code: string; count: number }>;
  };
}
