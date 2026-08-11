ALTER TABLE "user_prompts"
  ADD COLUMN "contentPurgedAt" TIMESTAMPTZ(3),
  ADD COLUMN "aiTracePurgedAt" TIMESTAMPTZ(3);

UPDATE "user_prompts" AS up
SET "contentPurgedAt" = ur."sensitiveDataPurgedAt"
FROM "user_responses" AS ur
WHERE ur."userPromptId" = up."id"
  AND ur."sensitiveDataPurgedAt" IS NOT NULL;

CREATE INDEX "user_prompts_created_id_idx"
  ON "user_prompts"("createdAt" DESC, "id" DESC);

CREATE TABLE "ai_provider_calls" (
  "id" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "userPromptId" TEXT NOT NULL,
  "userResponseId" TEXT,
  "operation" VARCHAR(32) NOT NULL,
  "provider" VARCHAR(80) NOT NULL,
  "model" VARCHAR(160) NOT NULL,
  "attempt" INTEGER NOT NULL,
  "outcome" VARCHAR(16) NOT NULL,
  "statusCode" INTEGER,
  "latencyMs" INTEGER NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "totalTokens" INTEGER,
  "responseContent" TEXT,
  "failureCode" VARCHAR(80),
  "correlationId" VARCHAR(160),
  "requestId" VARCHAR(160),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_provider_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_provider_calls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_provider_calls_userPromptId_fkey" FOREIGN KEY ("userPromptId") REFERENCES "user_prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_provider_calls_userResponseId_fkey" FOREIGN KEY ("userResponseId") REFERENCES "user_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_provider_calls_operation_check" CHECK ("operation" IN ('follow_up', 'analysis')),
  CONSTRAINT "ai_provider_calls_outcome_check" CHECK ("outcome" IN ('succeeded', 'empty', 'failed')),
  CONSTRAINT "ai_provider_calls_attempt_check" CHECK ("attempt" >= 1),
  CONSTRAINT "ai_provider_calls_status_check" CHECK ("statusCode" IS NULL OR "statusCode" BETWEEN 100 AND 599),
  CONSTRAINT "ai_provider_calls_latency_check" CHECK ("latencyMs" >= 0),
  CONSTRAINT "ai_provider_calls_tokens_check" CHECK (
    ("inputTokens" IS NULL OR "inputTokens" >= 0)
    AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
    AND ("totalTokens" IS NULL OR "totalTokens" >= 0)
  ),
  CONSTRAINT "ai_provider_calls_identifiers_check" CHECK (
    ("correlationId" IS NULL OR "correlationId" ~ '^[A-Za-z0-9_.:-]{1,160}$')
    AND ("requestId" IS NULL OR "requestId" ~ '^[A-Za-z0-9_.:-]{1,160}$')
  ),
  CONSTRAINT "ai_provider_calls_shape_check" CHECK (
    ("outcome" = 'succeeded' AND NULLIF(BTRIM("responseContent"), '') IS NOT NULL AND "failureCode" IS NULL)
    OR ("outcome" = 'empty' AND "responseContent" IS NULL AND "failureCode" IS NULL)
    OR ("outcome" = 'failed' AND "responseContent" IS NULL AND "failureCode" ~ '^[A-Za-z0-9_.:-]{1,80}$')
  )
);

CREATE INDEX "ai_provider_calls_created_id_idx"
  ON "ai_provider_calls"("createdAt" DESC, "id" DESC);
CREATE INDEX "ai_provider_calls_session_created_id_idx"
  ON "ai_provider_calls"("userPromptId", "createdAt", "id");
CREATE INDEX "ai_provider_calls_user_created_id_idx"
  ON "ai_provider_calls"("userId", "createdAt" DESC, "id" DESC);
CREATE INDEX "ai_provider_calls_response_idx"
  ON "ai_provider_calls"("userResponseId");
