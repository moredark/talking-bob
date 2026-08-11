CREATE TYPE "BroadcastMode" AS ENUM ('immediate', 'scheduled');
CREATE TYPE "BroadcastStatus" AS ENUM ('queued', 'processing', 'completed', 'completed_with_errors', 'cancelled');
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('pending', 'sent', 'failed', 'ambiguous', 'skipped');

ALTER TABLE "users"
  ADD COLUMN "announcementEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "lastUserMessageAt" TIMESTAMPTZ(3);

UPDATE "users" app_user
SET "lastUserMessageAt" = activity."lastUserMessageAt"
FROM (
  SELECT user_prompt."userId", MAX(message."createdAt") AS "lastUserMessageAt"
  FROM "user_prompts" user_prompt
  JOIN "conversation_messages" message ON message."userPromptId" = user_prompt."id"
  WHERE message."role" = 'user'
  GROUP BY user_prompt."userId"
) activity
WHERE activity."userId" = app_user."id";

CREATE INDEX "users_lastUserMessageAt_idx" ON "users"("lastUserMessageAt");

CREATE TABLE "broadcasts" (
  "id" UUID NOT NULL,
  "content" TEXT,
  "contentPurgedAt" TIMESTAMPTZ(3),
  "filters" JSONB NOT NULL,
  "mode" "BroadcastMode" NOT NULL,
  "scheduledForLocal" VARCHAR(16),
  "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
  "status" "BroadcastStatus" NOT NULL DEFAULT 'queued',
  "totalRecipients" INTEGER NOT NULL DEFAULT 0,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "ambiguousCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" VARCHAR(160) NOT NULL,
  "createdByUsername" VARCHAR(200) NOT NULL,
  "terminalAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "broadcasts_filters_object_check" CHECK (jsonb_typeof("filters") = 'object'),
  CONSTRAINT "broadcasts_schedule_shape_check" CHECK (
    ("mode" = 'immediate' AND "scheduledForLocal" IS NULL)
    OR ("mode" = 'scheduled' AND "scheduledForLocal" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$')
  ),
  CONSTRAINT "broadcasts_counts_check" CHECK (
    "totalRecipients" >= 0 AND "sentCount" >= 0 AND "failedCount" >= 0
    AND "ambiguousCount" >= 0 AND "skippedCount" >= 0
    AND "sentCount" + "failedCount" + "ambiguousCount" + "skippedCount" <= "totalRecipients"
    AND (
      "status" IN ('queued', 'processing')
      OR "sentCount" + "failedCount" + "ambiguousCount" + "skippedCount" = "totalRecipients"
    )
  ),
  CONSTRAINT "broadcasts_actor_check" CHECK (
    "createdById" ~ '^[A-Za-z0-9_.:-]{1,160}$'
    AND LENGTH(BTRIM("createdByUsername")) BETWEEN 1 AND 200
    AND "createdByUsername" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "broadcasts_terminal_shape_check" CHECK (
    ("status" IN ('queued', 'processing') AND "terminalAt" IS NULL)
    OR ("status" IN ('completed', 'completed_with_errors', 'cancelled') AND "terminalAt" IS NOT NULL)
  ),
  CONSTRAINT "broadcasts_content_purge_shape_check" CHECK (
    ("content" IS NOT NULL AND "contentPurgedAt" IS NULL AND LENGTH(BTRIM("content")) > 0)
    OR (
      "content" IS NULL AND "contentPurgedAt" IS NOT NULL
      AND "terminalAt" IS NOT NULL AND "contentPurgedAt" >= "terminalAt"
    )
  )
);

CREATE TABLE "broadcast_recipients" (
  "id" UUID NOT NULL,
  "broadcastId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "telegramIdSnapshot" BIGINT NOT NULL,
  "usernameSnapshot" TEXT,
  "languageLevelSnapshot" TEXT,
  "dailyPromptEnabledSnapshot" BOOLEAN NOT NULL,
  "announcementEnabledSnapshot" BOOLEAN NOT NULL,
  "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimToken" UUID,
  "claimExpiresAt" TIMESTAMPTZ(3),
  "nextAttemptAt" TIMESTAMPTZ(3),
  "deliveryAttemptedAt" TIMESTAMPTZ(3),
  "sentAt" TIMESTAMPTZ(3),
  "lastErrorCode" VARCHAR(80),
  "lastErrorAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "broadcast_recipients_attempt_count_check" CHECK ("attemptCount" BETWEEN 0 AND 5),
  CONSTRAINT "broadcast_recipients_claim_shape_check" CHECK (
    ("claimToken" IS NULL AND "claimExpiresAt" IS NULL)
    OR ("status" = 'pending' AND "claimToken" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)
  ),
  CONSTRAINT "broadcast_recipients_sent_shape_check" CHECK (
    ("status" = 'sent' AND "sentAt" IS NOT NULL AND "deliveryAttemptedAt" IS NOT NULL)
    OR ("status" <> 'sent' AND "sentAt" IS NULL)
  ),
  CONSTRAINT "broadcast_recipients_error_shape_check" CHECK (
    ("lastErrorCode" IS NULL AND "lastErrorAt" IS NULL)
    OR ("lastErrorCode" ~ '^[a-z0-9_.:-]{1,80}$' AND "lastErrorAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "broadcast_recipients_broadcastId_userId_key"
  ON "broadcast_recipients"("broadcastId", "userId");
CREATE INDEX "broadcasts_dispatch_idx" ON "broadcasts"("status", "scheduledAt", "id");
CREATE INDEX "broadcasts_created_id_idx" ON "broadcasts"("createdAt" DESC, "id" DESC);
CREATE INDEX "broadcasts_terminal_idx" ON "broadcasts"("terminalAt");
CREATE INDEX "broadcast_recipients_claim_idx"
  ON "broadcast_recipients"("status", "nextAttemptAt", "claimExpiresAt");
CREATE INDEX "broadcast_recipients_detail_idx"
  ON "broadcast_recipients"("broadcastId", "status", "createdAt", "id");
CREATE INDEX "broadcast_recipients_user_idx" ON "broadcast_recipients"("userId");

ALTER TABLE "broadcast_recipients"
  ADD CONSTRAINT "broadcast_recipients_broadcastId_fkey"
    FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "broadcast_recipients_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_audit_logs"
  DROP CONSTRAINT "admin_audit_logs_action_check",
  DROP CONSTRAINT "admin_audit_logs_entity_type_check",
  DROP CONSTRAINT "admin_audit_logs_action_entity_check";

ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_action_check" CHECK (
    "action" IN (
      'user.update', 'user.reset_progress', 'prompt.create', 'prompt.update',
      'prompt.delete', 'error_log.clear_old', 'settings.product.update',
      'settings.infrastructure.update', 'broadcast.create', 'broadcast.cancel'
    )
  ),
  ADD CONSTRAINT "admin_audit_logs_entity_type_check" CHECK (
    "entityType" IN ('user', 'prompt', 'error_log', 'runtime_settings', 'broadcast')
  ),
  ADD CONSTRAINT "admin_audit_logs_action_entity_check" CHECK (
    ("action" IN ('user.update', 'user.reset_progress') AND "entityType" = 'user')
    OR ("action" IN ('prompt.create', 'prompt.update', 'prompt.delete') AND "entityType" = 'prompt')
    OR ("action" = 'error_log.clear_old' AND "entityType" = 'error_log')
    OR ("action" IN ('settings.product.update', 'settings.infrastructure.update') AND "entityType" = 'runtime_settings')
    OR ("action" IN ('broadcast.create', 'broadcast.cancel') AND "entityType" = 'broadcast')
  );
