CREATE TABLE "admin_audit_logs" (
  "id" TEXT NOT NULL,
  "actorId" VARCHAR(160) NOT NULL,
  "actorUsername" TEXT NOT NULL,
  "action" VARCHAR(80) NOT NULL,
  "entityType" VARCHAR(80) NOT NULL,
  "entityId" VARCHAR(160),
  "outcome" VARCHAR(16) NOT NULL,
  "requestId" VARCHAR(160) NOT NULL,
  "correlationId" VARCHAR(160) NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "failureCode" VARCHAR(80),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_audit_logs_actor_id_sanitized_check" CHECK (
    "actorId" ~ '^[A-Za-z0-9_.:-]{1,160}$'
  ),
  CONSTRAINT "admin_audit_logs_actor_username_check" CHECK (
    NULLIF(BTRIM("actorUsername"), '') IS NOT NULL
  ),
  CONSTRAINT "admin_audit_logs_action_check" CHECK (
    "action" IN ('user.update', 'user.reset_progress', 'prompt.create', 'prompt.update', 'prompt.delete', 'error_log.clear_old')
  ),
  CONSTRAINT "admin_audit_logs_entity_type_check" CHECK (
    "entityType" IN ('user', 'prompt', 'error_log')
  ),
  CONSTRAINT "admin_audit_logs_action_entity_check" CHECK (
    ("action" IN ('user.update', 'user.reset_progress') AND "entityType" = 'user')
    OR ("action" IN ('prompt.create', 'prompt.update', 'prompt.delete') AND "entityType" = 'prompt')
    OR ("action" = 'error_log.clear_old' AND "entityType" = 'error_log')
  ),
  CONSTRAINT "admin_audit_logs_entity_id_sanitized_check" CHECK (
    "entityId" IS NULL OR "entityId" ~ '^[A-Za-z0-9_.:-]{1,160}$'
  ),
  CONSTRAINT "admin_audit_logs_outcome_check" CHECK (
    "outcome" IN ('success', 'failure')
  ),
  CONSTRAINT "admin_audit_logs_request_id_sanitized_check" CHECK (
    "requestId" ~ '^[A-Za-z0-9_.:-]{1,160}$'
  ),
  CONSTRAINT "admin_audit_logs_correlation_id_sanitized_check" CHECK (
    "correlationId" ~ '^[A-Za-z0-9_.:-]{1,160}$'
  ),
  CONSTRAINT "admin_audit_logs_failure_code_check" CHECK (
    "failureCode" IS NULL
    OR "failureCode" IN ('validation_failed', 'not_found', 'conflict', 'audit_write_failed', 'internal_error')
  ),
  CONSTRAINT "admin_audit_logs_outcome_shape_check" CHECK (
    ("outcome" = 'success' AND "entityId" IS NOT NULL AND "failureCode" IS NULL)
    OR ("outcome" = 'failure' AND "failureCode" IS NOT NULL)
  )
);

CREATE INDEX "admin_audit_logs_created_id_idx"
  ON "admin_audit_logs"("createdAt" DESC, "id" DESC);
CREATE INDEX "admin_audit_logs_actor_created_id_idx"
  ON "admin_audit_logs"("actorId", "createdAt" DESC, "id" DESC);
CREATE INDEX "admin_audit_logs_entity_created_id_idx"
  ON "admin_audit_logs"("entityType", "entityId", "createdAt" DESC, "id" DESC);
CREATE INDEX "admin_audit_logs_action_created_id_idx"
  ON "admin_audit_logs"("action", "createdAt" DESC, "id" DESC);
CREATE INDEX "admin_audit_logs_outcome_created_id_idx"
  ON "admin_audit_logs"("outcome", "createdAt" DESC, "id" DESC);
