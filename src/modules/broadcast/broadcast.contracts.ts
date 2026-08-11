import type { AbortSignal } from "abort-controller";
import type { BroadcastMode, BroadcastRecipientStatus, BroadcastStatus } from "@prisma/client";

export const BROADCAST_ACTIVITIES = ["any", "7d", "30d", "90d", "never"] as const;
export const BROADCAST_DAILY_PROMPT_FILTERS = ["any", true, false] as const;
export const BROADCAST_STATUSES: readonly BroadcastStatus[] = [
  "queued", "processing", "completed", "completed_with_errors", "cancelled",
];
export const BROADCAST_RECIPIENT_STATUSES: readonly BroadcastRecipientStatus[] = [
  "pending", "sent", "failed", "ambiguous", "skipped",
];

export type BroadcastActivity = (typeof BROADCAST_ACTIVITIES)[number];

export interface BroadcastFilters {
  languageLevels: string[];
  activity: BroadcastActivity;
  dailyPromptEnabled: "any" | boolean;
}

export interface BroadcastInputDto {
  content: string;
  filters: BroadcastFilters;
  mode: BroadcastMode;
  scheduledFor: string | null;
  scheduledAt: Date;
}

export interface BroadcastPreview {
  normalized: {
    content: string;
    filters: BroadcastFilters;
    mode: BroadcastMode;
    scheduledFor: string | null;
    scheduledAt: Date;
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

export interface BroadcastListQuery {
  page: number;
  limit: number;
  status?: BroadcastStatus;
  from?: Date;
  to?: Date;
}

export interface BroadcastDetailQuery {
  recipientPage: number;
  recipientLimit: number;
  recipientStatus?: BroadcastRecipientStatus;
}

export interface BroadcastListItem {
  id: string;
  content: string | null;
  contentPurged: boolean;
  filters: BroadcastFilters;
  mode: BroadcastMode;
  scheduledFor: string | null;
  scheduledAt: Date;
  status: BroadcastStatus;
  counts: BroadcastCounts;
  createdBy: { id: string; username: string };
  createdAt: Date;
  updatedAt: Date;
  terminalAt: Date | null;
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
  nextAttemptAt: Date | null;
  deliveryAttemptedAt: Date | null;
  sentAt: Date | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface BroadcastDetail extends BroadcastListItem {
  recipients: Paginated<BroadcastRecipientItem>;
}

export interface BroadcastSendError {
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  ambiguous: boolean;
}

export interface BroadcastSender {
  sendPlainText(telegramId: bigint, content: string, signal?: AbortSignal): Promise<void>;
}

export const BROADCAST_LIMITS = {
  contentUtf16: 4096,
  maxAttempts: 5,
  claimLeaseMs: 180_000,
  claimBatch: 20,
  concurrency: 5,
} as const;
