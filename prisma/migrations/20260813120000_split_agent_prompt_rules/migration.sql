CREATE TABLE "agent_prompt_rules" (
  "id" VARCHAR(16) NOT NULL DEFAULT 'default',
  "followUpPrompt" TEXT NOT NULL,
  "analysisPrompt" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_prompt_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_prompt_rules_singleton_check" CHECK ("id" = 'default'),
  CONSTRAINT "agent_prompt_rules_prompts_check" CHECK (LENGTH(BTRIM("followUpPrompt")) BETWEEN 1 AND 8000 AND LENGTH(BTRIM("analysisPrompt")) BETWEEN 1 AND 8000)
);

INSERT INTO "agent_prompt_rules" ("id", "followUpPrompt", "analysisPrompt") VALUES
('default', $p$You are an English speaking partner.
Rules:
- English only
- 1 short follow-up question
- max 2 short sentences
- no grammar correction in this step$p$, $p$You are an English tutor for Russian speakers.
Respond in Russian.
Return ONLY valid JSON:
{
  "summary": "Короткий комментарий на русском (1 предложение)",
  "improvementPoints": ["Список ошибок/улучшений без дублей, на русском"],
  "overallScore": 7
}

Rules:
- overallScore: integer from 1 to 10
- one combined list in improvementPoints
- no duplicates
- if no issues, improvementPoints must be []$p$);

ALTER TABLE "agent_personalities"
  ADD COLUMN "followUpStylePrompt" TEXT,
  ADD COLUMN "analysisStylePrompt" TEXT;

DO $migration$
DECLARE
  follow_base CONSTANT TEXT := $follow$You are an English speaking partner.
Rules:
- English only
- 1 short follow-up question
- max 2 short sentences
- no grammar correction in this step$follow$;
  analysis_base CONSTANT TEXT := $analysis$You are an English tutor for Russian speakers.
Respond in Russian.
Return ONLY valid JSON:
{
  "summary": "Короткий комментарий на русском (1 предложение)",
  "improvementPoints": ["Список ошибок/улучшений без дублей, на русском"],
  "overallScore": 7
}

Rules:
- overallScore: integer from 1 to 10
- one combined list in improvementPoints
- no duplicates
- if no issues, improvementPoints must be []$analysis$;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_personalities"
    WHERE NOT starts_with("followUpPrompt", follow_base || E'\n')
       OR NOT starts_with("analysisPrompt", analysis_base || E'\n')
       OR LENGTH("followUpPrompt") <= LENGTH(follow_base) + 1
       OR LENGTH("analysisPrompt") <= LENGTH(analysis_base) + 1
  ) THEN
    RAISE EXCEPTION 'Cannot split customized agent personality prompts automatically';
  END IF;

  UPDATE "agent_personalities"
  SET "followUpStylePrompt" = SUBSTRING("followUpPrompt" FROM LENGTH(follow_base) + 2),
      "analysisStylePrompt" = SUBSTRING("analysisPrompt" FROM LENGTH(analysis_base) + 2);

  IF EXISTS (
    SELECT 1 FROM "agent_personalities"
    WHERE follow_base || E'\n' || "followUpStylePrompt" <> "followUpPrompt"
       OR analysis_base || E'\n' || "analysisStylePrompt" <> "analysisPrompt"
  ) THEN
    RAISE EXCEPTION 'Agent personality prompt split verification failed';
  END IF;
END
$migration$;

ALTER TABLE "agent_personalities"
  ALTER COLUMN "followUpStylePrompt" SET NOT NULL,
  ALTER COLUMN "analysisStylePrompt" SET NOT NULL,
  DROP CONSTRAINT "agent_personalities_prompts_check",
  ADD CONSTRAINT "agent_personalities_prompts_check" CHECK (LENGTH(BTRIM("followUpStylePrompt")) BETWEEN 1 AND 8000 AND LENGTH(BTRIM("analysisStylePrompt")) BETWEEN 1 AND 8000),
  DROP COLUMN "followUpPrompt",
  DROP COLUMN "analysisPrompt";

ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_action_check", DROP CONSTRAINT "admin_audit_logs_action_entity_check";
ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_action_check" CHECK ("action" IN ('user.update','user.reset_progress','prompt.create','prompt.update','prompt.delete','error_log.clear_old','settings.product.update','settings.infrastructure.update','broadcast.create','broadcast.cancel','personality.create','personality.update','personality.activate','personality.deactivate','personality.set_default','personality.rules.update')),
  ADD CONSTRAINT "admin_audit_logs_action_entity_check" CHECK (
    ("action" IN ('user.update','user.reset_progress') AND "entityType"='user') OR
    ("action" IN ('prompt.create','prompt.update','prompt.delete') AND "entityType"='prompt') OR
    ("action"='error_log.clear_old' AND "entityType"='error_log') OR
    ("action" IN ('settings.product.update','settings.infrastructure.update') AND "entityType"='runtime_settings') OR
    ("action" IN ('broadcast.create','broadcast.cancel') AND "entityType"='broadcast') OR
    ("action" IN ('personality.create','personality.update','personality.activate','personality.deactivate','personality.set_default','personality.rules.update') AND "entityType"='personality')
  );
