CREATE TYPE "ConversationStatus" AS ENUM ('open', 'closed');
CREATE TYPE "ReportGenerationStatus" AS ENUM ('generating', 'generated', 'failed');
CREATE TYPE "ReportAnalysisKind" AS ENUM ('model', 'fallback', 'legacy');
CREATE TYPE "ReportDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed');

ALTER TABLE "user_prompts"
  ADD COLUMN "conversationStatus" "ConversationStatus",
  ADD COLUMN "conversationClosedAt" TIMESTAMPTZ(3);

ALTER TABLE "conversation_messages"
  ADD COLUMN "telegramUpdateId" BIGINT;

ALTER TABLE "user_responses"
  ADD COLUMN "generationStatus" "ReportGenerationStatus",
  ADD COLUMN "generationRequestKey" VARCHAR(160),
  ADD COLUMN "generationClaimToken" UUID,
  ADD COLUMN "generationClaimExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "generationAttemptedAt" TIMESTAMPTZ(3),
  ADD COLUMN "generatedAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastGenerationErrorCode" VARCHAR(64),
  ADD COLUMN "lastGenerationErrorAt" TIMESTAMPTZ(3),
  ADD COLUMN "analysisVersion" INTEGER,
  ADD COLUMN "analysisKind" "ReportAnalysisKind";

CREATE OR REPLACE FUNCTION pg_temp.try_parse_jsonb(value TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN value::JSONB;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

WITH recovered AS (
  SELECT
    cm."userPromptId",
    STRING_AGG(BTRIM(cm."content"), E'\n' ORDER BY cm."createdAt", cm."id") AS transcript
  FROM "conversation_messages" AS cm
  WHERE cm."role" = 'user'
    AND NULLIF(BTRIM(cm."content"), '') IS NOT NULL
  GROUP BY cm."userPromptId"
)
UPDATE "user_responses" AS ur
SET "transcript" = recovered.transcript
FROM recovered
WHERE recovered."userPromptId" = ur."userPromptId"
  AND NULLIF(BTRIM(ur."transcript"), '') IS NULL;

UPDATE "user_responses"
SET
  "generationRequestKey" = 'legacy:' || "id",
  "generationAttemptedAt" = "createdAt";

WITH classified AS (
  SELECT
    ur."id",
    pg_temp.try_parse_jsonb(ur."analysis") AS parsed_analysis
  FROM "user_responses" AS ur
  WHERE NULLIF(BTRIM(ur."transcript"), '') IS NOT NULL
    AND NULLIF(BTRIM(ur."analysis"), '') IS NOT NULL
)
UPDATE "user_responses" AS ur
SET
  "analysis" = (classified.parsed_analysis || JSONB_BUILD_OBJECT('version', 0, 'kind', 'legacy'))::TEXT,
  "generationStatus" = 'generated',
  "generatedAt" = ur."createdAt",
  "analysisVersion" = 0,
  "analysisKind" = 'legacy'
FROM classified
WHERE classified."id" = ur."id"
  AND JSONB_TYPEOF(classified.parsed_analysis) = 'object';

UPDATE "user_responses"
SET
  "generationStatus" = 'failed',
  "lastGenerationErrorCode" = 'legacy_incomplete',
  "lastGenerationErrorAt" = "createdAt"
WHERE "generationStatus" IS NULL;

ALTER TABLE "user_responses"
  ALTER COLUMN "generationStatus" SET DEFAULT 'generating',
  ALTER COLUMN "generationStatus" SET NOT NULL,
  ALTER COLUMN "generationRequestKey" SET NOT NULL,
  ALTER COLUMN "generationAttemptedAt" SET NOT NULL;

WITH ranked_user_messages AS (
  SELECT
    cm."userPromptId",
    cm."createdAt",
    ROW_NUMBER() OVER (
      PARTITION BY cm."userPromptId"
      ORDER BY cm."createdAt", cm."id"
    ) AS message_number
  FROM "conversation_messages" AS cm
  WHERE cm."role" = 'user'
), closure_candidates AS (
  SELECT ur."userPromptId", ur."createdAt" AS closed_at
  FROM "user_responses" AS ur
  UNION ALL
  SELECT rum."userPromptId", rum."createdAt"
  FROM ranked_user_messages AS rum
  WHERE rum.message_number = 3
), closures AS (
  SELECT "userPromptId", MIN(closed_at) AS closed_at
  FROM closure_candidates
  GROUP BY "userPromptId"
)
UPDATE "user_prompts" AS up
SET
  "conversationStatus" = CASE
    WHEN closures.closed_at IS NULL THEN 'open'::"ConversationStatus"
    ELSE 'closed'::"ConversationStatus"
  END,
  "conversationClosedAt" = closures.closed_at
FROM (
  SELECT up_inner."id", closures_inner.closed_at
  FROM "user_prompts" AS up_inner
  LEFT JOIN closures AS closures_inner
    ON closures_inner."userPromptId" = up_inner."id"
) AS closures
WHERE closures."id" = up."id";

ALTER TABLE "user_prompts"
  ALTER COLUMN "conversationStatus" SET DEFAULT 'open',
  ALTER COLUMN "conversationStatus" SET NOT NULL;

CREATE TABLE "report_delivery_requests" (
  "id" UUID NOT NULL,
  "userResponseId" TEXT NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "chunks" JSONB NOT NULL,
  "nextChunkIndex" INTEGER NOT NULL DEFAULT 0,
  "status" "ReportDeliveryStatus" NOT NULL DEFAULT 'pending',
  "claimToken" UUID,
  "claimExpiresAt" TIMESTAMPTZ(3),
  "deliveryAttemptedAt" TIMESTAMPTZ(3),
  "deliveredAt" TIMESTAMPTZ(3),
  "lastDeliveryErrorCode" VARCHAR(64),
  "lastDeliveryErrorAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "report_delivery_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "report_delivery_requests_userResponseId_fkey"
    FOREIGN KEY ("userResponseId") REFERENCES "user_responses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "conversation_messages_telegramUpdateId_key"
  ON "conversation_messages"("telegramUpdateId");
CREATE INDEX "user_prompts_conversation_status_idx"
  ON "user_prompts"("conversationStatus", "conversationClosedAt");
CREATE INDEX "user_responses_generation_reclaim_idx"
  ON "user_responses"("generationStatus", "generationAttemptedAt", "generationClaimExpiresAt");
CREATE UNIQUE INDEX "report_delivery_requests_userResponseId_requestKey_key"
  ON "report_delivery_requests"("userResponseId", "requestKey");
CREATE INDEX "report_delivery_requests_reclaim_idx"
  ON "report_delivery_requests"("status", "deliveryAttemptedAt", "claimExpiresAt");

ALTER TABLE "user_prompts"
  ADD CONSTRAINT "user_prompts_conversation_state_check" CHECK (
    ("conversationStatus" = 'open' AND "conversationClosedAt" IS NULL)
    OR ("conversationStatus" = 'closed' AND "conversationClosedAt" IS NOT NULL)
  );

ALTER TABLE "user_responses"
  ADD CONSTRAINT "user_responses_generation_claim_lease_check" CHECK (
    ("generationClaimToken" IS NULL) = ("generationClaimExpiresAt" IS NULL)
  ),
  ADD CONSTRAINT "user_responses_generation_error_pair_check" CHECK (
    ("lastGenerationErrorCode" IS NULL) = ("lastGenerationErrorAt" IS NULL)
  ),
  ADD CONSTRAINT "user_responses_generation_error_code_sanitized_check" CHECK (
    "lastGenerationErrorCode" IS NULL
    OR "lastGenerationErrorCode" ~ '^[a-z0-9_]{1,64}$'
  ),
  ADD CONSTRAINT "user_responses_generation_state_check" CHECK (
    (
      "generationStatus" = 'generated'
      AND NULLIF(BTRIM("transcript"), '') IS NOT NULL
      AND NULLIF(BTRIM("analysis"), '') IS NOT NULL
      AND "generatedAt" IS NOT NULL
      AND "analysisVersion" IS NOT NULL
      AND "analysisKind" IS NOT NULL
      AND "generationClaimToken" IS NULL
      AND "generationClaimExpiresAt" IS NULL
      AND "lastGenerationErrorCode" IS NULL
      AND "lastGenerationErrorAt" IS NULL
    ) OR (
      "generationStatus" = 'failed'
      AND "generatedAt" IS NULL
      AND "analysisVersion" IS NULL
      AND "analysisKind" IS NULL
      AND "generationClaimToken" IS NULL
      AND "generationClaimExpiresAt" IS NULL
      AND "lastGenerationErrorCode" IS NOT NULL
      AND "lastGenerationErrorAt" IS NOT NULL
    ) OR (
      "generationStatus" = 'generating'
      AND "generatedAt" IS NULL
      AND "analysisVersion" IS NULL
      AND "analysisKind" IS NULL
      AND "generationClaimToken" IS NOT NULL
      AND "generationClaimExpiresAt" IS NOT NULL
      AND "lastGenerationErrorCode" IS NULL
      AND "lastGenerationErrorAt" IS NULL
    )
  );

ALTER TABLE "report_delivery_requests"
  ADD CONSTRAINT "report_delivery_requests_claim_lease_check" CHECK (
    ("claimToken" IS NULL) = ("claimExpiresAt" IS NULL)
  ),
  ADD CONSTRAINT "report_delivery_requests_error_pair_check" CHECK (
    ("lastDeliveryErrorCode" IS NULL) = ("lastDeliveryErrorAt" IS NULL)
  ),
  ADD CONSTRAINT "report_delivery_requests_chunks_check" CHECK (
    JSONB_TYPEOF("chunks") = 'array'
    AND JSONB_ARRAY_LENGTH("chunks") > 0
    AND "nextChunkIndex" BETWEEN 0 AND JSONB_ARRAY_LENGTH("chunks")
  ),
  ADD CONSTRAINT "report_delivery_requests_error_code_sanitized_check" CHECK (
    "lastDeliveryErrorCode" IS NULL
    OR "lastDeliveryErrorCode" ~ '^[a-z0-9_]{1,64}$'
  ),
  ADD CONSTRAINT "report_delivery_requests_delivery_state_check" CHECK (
    (
      "status" = 'delivered'
      AND "deliveredAt" IS NOT NULL
      AND "deliveryAttemptedAt" IS NOT NULL
      AND "nextChunkIndex" = JSONB_ARRAY_LENGTH("chunks")
      AND "claimToken" IS NULL
      AND "claimExpiresAt" IS NULL
      AND "lastDeliveryErrorCode" IS NULL
      AND "lastDeliveryErrorAt" IS NULL
    ) OR (
      "status" = 'failed'
      AND "deliveredAt" IS NULL
      AND "deliveryAttemptedAt" IS NOT NULL
      AND "nextChunkIndex" < JSONB_ARRAY_LENGTH("chunks")
      AND "claimToken" IS NULL
      AND "claimExpiresAt" IS NULL
      AND "lastDeliveryErrorCode" IS NOT NULL
      AND "lastDeliveryErrorAt" IS NOT NULL
    ) OR (
      "status" = 'pending'
      AND "deliveredAt" IS NULL
      AND (
        (
          "deliveryAttemptedAt" IS NULL
          AND "claimToken" IS NOT NULL
          AND "claimExpiresAt" IS NOT NULL
          AND "lastDeliveryErrorCode" IS NULL
          AND "lastDeliveryErrorAt" IS NULL
        ) OR (
          "deliveryAttemptedAt" IS NOT NULL
          AND "claimToken" IS NULL
          AND "claimExpiresAt" IS NULL
          AND "lastDeliveryErrorCode" IS NOT NULL
          AND "lastDeliveryErrorAt" IS NOT NULL
        )
      )
    )
  );
