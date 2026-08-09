-- Retention may redact speech while preserving report lifecycle/provenance.
ALTER TABLE "user_responses"
  ALTER COLUMN "voiceFileId" DROP NOT NULL,
  ADD COLUMN "sensitiveDataPurgedAt" TIMESTAMPTZ(3);

ALTER TABLE "user_responses"
  DROP CONSTRAINT "user_responses_generation_state_check";

ALTER TABLE "user_responses"
  ADD CONSTRAINT "user_responses_sensitive_data_purge_check" CHECK (
    "sensitiveDataPurgedAt" IS NULL
    OR (
      "voiceFileId" IS NULL
      AND "transcript" IS NULL
      AND "analysis" IS NULL
    )
  ),
  ADD CONSTRAINT "user_responses_generation_state_check" CHECK (
    (
      "generationStatus" = 'generated'
      AND (
        "sensitiveDataPurgedAt" IS NOT NULL
        OR (
          NULLIF(BTRIM("transcript"), '') IS NOT NULL
          AND NULLIF(BTRIM("analysis"), '') IS NOT NULL
        )
      )
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

CREATE INDEX "user_responses_sensitive_data_purged_idx"
  ON "user_responses"("sensitiveDataPurgedAt");

-- Move searchable, bounded observability dimensions out of compatibility JSON.
ALTER TABLE "error_logs"
  ADD COLUMN "operation" VARCHAR(80) NOT NULL DEFAULT 'unknown',
  ADD COLUMN "correlationId" VARCHAR(160),
  ADD COLUMN "statusCode" INTEGER,
  ADD COLUMN "retryable" BOOLEAN,
  ADD COLUMN "latencyMs" INTEGER,
  ADD COLUMN "errorKind" VARCHAR(80) NOT NULL DEFAULT 'LegacyError';

ALTER TABLE "error_logs"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
    USING "createdAt" AT TIME ZONE 'UTC',
  ADD CONSTRAINT "error_logs_operation_sanitized_check" CHECK (
    "operation" ~ '^[A-Za-z0-9_.:-]{1,80}$'
  ),
  ADD CONSTRAINT "error_logs_correlation_sanitized_check" CHECK (
    "correlationId" IS NULL
    OR "correlationId" ~ '^[A-Za-z0-9_.:-]{1,160}$'
  ),
  ADD CONSTRAINT "error_logs_error_kind_sanitized_check" CHECK (
    "errorKind" ~ '^[A-Za-z0-9_.:-]{1,80}$'
  ),
  ADD CONSTRAINT "error_logs_status_code_check" CHECK (
    "statusCode" IS NULL OR "statusCode" BETWEEN 100 AND 599
  ),
  ADD CONSTRAINT "error_logs_latency_check" CHECK (
    "latencyMs" IS NULL OR "latencyMs" >= 0
  );

CREATE INDEX "error_logs_correlation_created_idx"
  ON "error_logs"("correlationId", "createdAt");
CREATE INDEX "error_logs_service_operation_created_idx"
  ON "error_logs"("service", "operation", "createdAt");
