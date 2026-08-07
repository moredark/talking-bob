-- User prompt delivery lifecycle and UTC-safe schedule timestamps.
-- Existing timestamp-without-time-zone values followed the application's UTC
-- convention. Reinterpret them explicitly so this migration is independent of
-- the PostgreSQL session TimeZone.

CREATE TYPE "UserPromptSource" AS ENUM ('manual', 'scheduled', 'legacy');
CREATE TYPE "UserPromptDeliveryStatus" AS ENUM ('pending', 'sent', 'failed');

ALTER TABLE "users"
  ALTER COLUMN "lastPromptSentAt" TYPE TIMESTAMPTZ(3)
    USING "lastPromptSentAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "nextPromptAt" TYPE TIMESTAMPTZ(3)
    USING "nextPromptAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
    USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3)
    USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "users"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "prompts"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
    USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "prompts"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "user_prompts"
  ALTER COLUMN "sentAt" TYPE TIMESTAMPTZ(3)
    USING "sentAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "sentAt" DROP DEFAULT,
  ALTER COLUMN "sentAt" DROP NOT NULL,
  ADD COLUMN "source" "UserPromptSource" NOT NULL DEFAULT 'manual',
  ADD COLUMN "deliveryStatus" "UserPromptDeliveryStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "createdAt" TIMESTAMPTZ(3),
  ADD COLUMN "scheduledFor" TIMESTAMPTZ(3),
  ADD COLUMN "scheduledOccurrenceKey" VARCHAR(64),
  ADD COLUMN "scheduledLocalDate" DATE,
  ADD COLUMN "timezoneSnapshot" VARCHAR(128),
  ADD COLUMN "claimToken" UUID,
  ADD COLUMN "claimExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "deliveryAttemptedAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastDeliveryErrorCode" VARCHAR(64),
  ADD COLUMN "lastDeliveryErrorAt" TIMESTAMPTZ(3);

ALTER TABLE "conversation_messages"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
    USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "conversation_messages"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "user_responses"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
    USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "user_responses"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "user_requests"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
    USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "user_requests"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

-- Legacy rows with downstream conversation/response evidence are confirmed as
-- sent. Rows without evidence retain their original timestamp as the creation
-- and attempted-delivery time, but become terminal ambiguous pending records.
-- Nothing in this migration initiates or retries a delivery.
UPDATE "user_prompts" AS up
SET
  "source" = 'legacy',
  "createdAt" = up."sentAt",
  "deliveryAttemptedAt" = up."sentAt",
  "deliveryStatus" = CASE
    WHEN EXISTS (
      SELECT 1 FROM "conversation_messages" AS cm
      WHERE cm."userPromptId" = up."id"
    ) OR EXISTS (
      SELECT 1 FROM "user_responses" AS ur
      WHERE ur."userPromptId" = up."id"
    ) THEN 'sent'::"UserPromptDeliveryStatus"
    ELSE 'pending'::"UserPromptDeliveryStatus"
  END,
  "sentAt" = CASE
    WHEN EXISTS (
      SELECT 1 FROM "conversation_messages" AS cm
      WHERE cm."userPromptId" = up."id"
    ) OR EXISTS (
      SELECT 1 FROM "user_responses" AS ur
      WHERE ur."userPromptId" = up."id"
    ) THEN up."sentAt"
    ELSE NULL
  END,
  "lastDeliveryErrorCode" = CASE
    WHEN EXISTS (
      SELECT 1 FROM "conversation_messages" AS cm
      WHERE cm."userPromptId" = up."id"
    ) OR EXISTS (
      SELECT 1 FROM "user_responses" AS ur
      WHERE ur."userPromptId" = up."id"
    ) THEN NULL
    ELSE 'legacy_unknown'
  END,
  "lastDeliveryErrorAt" = CASE
    WHEN EXISTS (
      SELECT 1 FROM "conversation_messages" AS cm
      WHERE cm."userPromptId" = up."id"
    ) OR EXISTS (
      SELECT 1 FROM "user_responses" AS ur
      WHERE ur."userPromptId" = up."id"
    ) THEN NULL
    ELSE up."sentAt"
  END;

ALTER TABLE "user_prompts"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "createdAt" SET NOT NULL;

-- Old schedule values were produced by session-sensitive calculations. Runtime
-- repair will assign a valid next slot without delivering a prompt.
UPDATE "users" SET "nextPromptAt" = NULL;

CREATE INDEX "user_prompts_userId_deliveryStatus_sentAt_idx"
  ON "user_prompts"("userId", "deliveryStatus", "sentAt");
CREATE INDEX "user_prompts_delivery_retry_idx"
  ON "user_prompts"("deliveryStatus", "deliveryAttemptedAt", "claimExpiresAt");
CREATE INDEX "user_prompts_scheduledOccurrenceKey_idx"
  ON "user_prompts"("scheduledOccurrenceKey");
CREATE UNIQUE INDEX "user_prompts_scheduledOccurrenceKey_unique"
  ON "user_prompts"("scheduledOccurrenceKey")
  WHERE "scheduledOccurrenceKey" IS NOT NULL;

ALTER TABLE "user_prompts"
  ADD CONSTRAINT "user_prompts_scheduled_metadata_check" CHECK (
    (
      "source" = 'scheduled'
      AND "scheduledFor" IS NOT NULL
      AND "scheduledOccurrenceKey" IS NOT NULL
      AND "scheduledLocalDate" IS NOT NULL
      AND "timezoneSnapshot" IS NOT NULL
    ) OR (
      "source" <> 'scheduled'
      AND "scheduledFor" IS NULL
      AND "scheduledOccurrenceKey" IS NULL
      AND "scheduledLocalDate" IS NULL
      AND "timezoneSnapshot" IS NULL
    )
  ),
  ADD CONSTRAINT "user_prompts_claim_lease_check" CHECK (
    ("claimToken" IS NULL) = ("claimExpiresAt" IS NULL)
  ),
  ADD CONSTRAINT "user_prompts_error_code_sanitized_check" CHECK (
    "lastDeliveryErrorCode" IS NULL
    OR "lastDeliveryErrorCode" ~ '^[a-z0-9_]{1,64}$'
  ),
  ADD CONSTRAINT "user_prompts_delivery_state_check" CHECK (
    (
      "deliveryStatus" = 'sent'
      AND "sentAt" IS NOT NULL
      AND "deliveryAttemptedAt" IS NOT NULL
      AND "lastDeliveryErrorCode" IS NULL
      AND "lastDeliveryErrorAt" IS NULL
    ) OR (
      "deliveryStatus" = 'failed'
      AND "sentAt" IS NULL
      AND "deliveryAttemptedAt" IS NOT NULL
      AND "lastDeliveryErrorCode" IS NOT NULL
      AND "lastDeliveryErrorAt" IS NOT NULL
    ) OR (
      "deliveryStatus" = 'pending'
      AND "sentAt" IS NULL
      AND (
        (
          "deliveryAttemptedAt" IS NULL
          AND "lastDeliveryErrorCode" IS NULL
          AND "lastDeliveryErrorAt" IS NULL
        ) OR (
          "deliveryAttemptedAt" IS NOT NULL
          AND "lastDeliveryErrorCode" IS NOT NULL
          AND "lastDeliveryErrorAt" IS NOT NULL
        )
      )
    )
  );

CREATE FUNCTION prevent_scheduled_user_prompt_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."source" = 'scheduled' AND (
    NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."scheduledFor" IS DISTINCT FROM OLD."scheduledFor"
    OR NEW."scheduledOccurrenceKey" IS DISTINCT FROM OLD."scheduledOccurrenceKey"
    OR NEW."scheduledLocalDate" IS DISTINCT FROM OLD."scheduledLocalDate"
    OR NEW."timezoneSnapshot" IS DISTINCT FROM OLD."timezoneSnapshot"
  ) THEN
    RAISE EXCEPTION 'scheduled user prompt identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_prompts_scheduled_identity_immutable"
BEFORE UPDATE ON "user_prompts"
FOR EACH ROW
EXECUTE FUNCTION prevent_scheduled_user_prompt_identity_change();
