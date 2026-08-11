CREATE TABLE "runtime_settings" (
  "id" VARCHAR(32) NOT NULL,
  "productOverrides" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "infrastructureOverrides" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "productVersion" INTEGER NOT NULL DEFAULT 0,
  "infrastructureVersion" INTEGER NOT NULL DEFAULT 0,
  "updatedById" VARCHAR(160),
  "updatedByUsername" VARCHAR(200),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runtime_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "runtime_settings_singleton_check" CHECK ("id" = 'singleton'),
  CONSTRAINT "runtime_settings_json_objects_check" CHECK (
    jsonb_typeof("productOverrides") = 'object'
    AND jsonb_typeof("infrastructureOverrides") = 'object'
  ),
  CONSTRAINT "runtime_settings_versions_check" CHECK (
    "productVersion" >= 0 AND "infrastructureVersion" >= 0
  ),
  CONSTRAINT "runtime_settings_updater_check" CHECK (
    ("updatedById" IS NULL AND "updatedByUsername" IS NULL)
    OR (
      "updatedById" ~ '^[A-Za-z0-9_.:-]{1,160}$'
      AND LENGTH(BTRIM("updatedByUsername")) BETWEEN 1 AND 200
      AND "updatedByUsername" !~ '[[:cntrl:]]'
    )
  )
);

INSERT INTO "runtime_settings" ("id") VALUES ('singleton');

ALTER TABLE "admin_audit_logs"
  DROP CONSTRAINT "admin_audit_logs_action_check",
  DROP CONSTRAINT "admin_audit_logs_entity_type_check",
  DROP CONSTRAINT "admin_audit_logs_action_entity_check";

ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_action_check" CHECK (
    "action" IN (
      'user.update', 'user.reset_progress', 'prompt.create', 'prompt.update',
      'prompt.delete', 'error_log.clear_old', 'settings.product.update',
      'settings.infrastructure.update'
    )
  ),
  ADD CONSTRAINT "admin_audit_logs_entity_type_check" CHECK (
    "entityType" IN ('user', 'prompt', 'error_log', 'runtime_settings')
  ),
  ADD CONSTRAINT "admin_audit_logs_action_entity_check" CHECK (
    ("action" IN ('user.update', 'user.reset_progress') AND "entityType" = 'user')
    OR ("action" IN ('prompt.create', 'prompt.update', 'prompt.delete') AND "entityType" = 'prompt')
    OR ("action" = 'error_log.clear_old' AND "entityType" = 'error_log')
    OR ("action" IN ('settings.product.update', 'settings.infrastructure.update') AND "entityType" = 'runtime_settings')
  );
