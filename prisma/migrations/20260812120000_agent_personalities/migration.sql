CREATE TABLE "agent_personalities" (
  "id" UUID NOT NULL,
  "key" VARCHAR(32) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "description" VARCHAR(240) NOT NULL,
  "followUpPrompt" TEXT NOT NULL,
  "analysisPrompt" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_personalities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_personalities_key_check" CHECK ("key" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  CONSTRAINT "agent_personalities_name_check" CHECK (LENGTH(BTRIM("name")) BETWEEN 1 AND 80 AND "name" !~ '[[:cntrl:]]'),
  CONSTRAINT "agent_personalities_description_check" CHECK (LENGTH("description") <= 240 AND "description" !~ '[[:cntrl:]]'),
  CONSTRAINT "agent_personalities_prompts_check" CHECK (LENGTH(BTRIM("followUpPrompt")) BETWEEN 1 AND 8000 AND LENGTH(BTRIM("analysisPrompt")) BETWEEN 1 AND 8000),
  CONSTRAINT "agent_personalities_sort_order_check" CHECK ("sortOrder" >= 0),
  CONSTRAINT "agent_personalities_default_active_check" CHECK (NOT "isDefault" OR "isActive")
);
CREATE UNIQUE INDEX "agent_personalities_key_key" ON "agent_personalities"("key");
CREATE UNIQUE INDEX "agent_personalities_one_default_idx" ON "agent_personalities"("isDefault") WHERE "isDefault";
CREATE INDEX "agent_personalities_active_sort_idx" ON "agent_personalities"("isActive", "sortOrder", "createdAt", "id");

INSERT INTO "agent_personalities" ("id", "key", "name", "description", "followUpPrompt", "analysisPrompt", "isActive", "isDefault", "sortOrder") VALUES
(gen_random_uuid(), 'friendly', 'Дружелюбный учитель', 'Поддерживающий и спокойный стиль объяснений', $p$You are an English speaking partner.
Rules:
- English only
- 1 short follow-up question
- max 2 short sentences
- no grammar correction in this step
- Be encouraging and warm, like a friendly teacher
- If the student's response is very short or unclear, gently encourage them to elaborate$p$, $p$You are an English tutor for Russian speakers.
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
- if no issues, improvementPoints must be []
Style rules for "friendly" tone:
- Be encouraging, clear, and kind
- Use calm teacher-like explanations$p$, true, true, 0),
(gen_random_uuid(), 'playful', 'Шутливый', 'Лёгкий юмор, сленг и неформальная речь', $p$You are an English speaking partner.
Rules:
- English only
- 1 short follow-up question
- max 2 short sentences
- no grammar correction in this step
- Use playful, slightly teasing humor, but stay supportive and never insulting
- Accept slang and informal speech naturally
- If slang appears, briefly explain or extend it with another useful slang phrase$p$, $p$You are an English tutor for Russian speakers.
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
- if no issues, improvementPoints must be []
Style rules for "playful" tone:
- Use light playful humor in wording, with a bit of cheeky style
- Do not shame or insult the student
- Do not criticize slang or informal wording
- Treat slang as valid conversational English and, when helpful, suggest extra slang alternatives$p$, true, false, 10);

UPDATE "users" SET "agentTone" = 'friendly' WHERE "agentTone" NOT IN ('friendly', 'playful');
ALTER TABLE "users" ADD CONSTRAINT "users_agentTone_fkey" FOREIGN KEY ("agentTone") REFERENCES "agent_personalities"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_agent_personality_key_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."key" <> OLD."key" THEN RAISE EXCEPTION 'personality key is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "agent_personalities_immutable_key" BEFORE UPDATE OF "key" ON "agent_personalities" FOR EACH ROW EXECUTE FUNCTION reject_agent_personality_key_update();

ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_action_check", DROP CONSTRAINT "admin_audit_logs_entity_type_check", DROP CONSTRAINT "admin_audit_logs_action_entity_check";
ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_action_check" CHECK ("action" IN ('user.update','user.reset_progress','prompt.create','prompt.update','prompt.delete','error_log.clear_old','settings.product.update','settings.infrastructure.update','broadcast.create','broadcast.cancel','personality.create','personality.update','personality.activate','personality.deactivate','personality.set_default')),
  ADD CONSTRAINT "admin_audit_logs_entity_type_check" CHECK ("entityType" IN ('user','prompt','error_log','runtime_settings','broadcast','personality')),
  ADD CONSTRAINT "admin_audit_logs_action_entity_check" CHECK (
    ("action" IN ('user.update','user.reset_progress') AND "entityType"='user') OR
    ("action" IN ('prompt.create','prompt.update','prompt.delete') AND "entityType"='prompt') OR
    ("action"='error_log.clear_old' AND "entityType"='error_log') OR
    ("action" IN ('settings.product.update','settings.infrastructure.update') AND "entityType"='runtime_settings') OR
    ("action" IN ('broadcast.create','broadcast.cancel') AND "entityType"='broadcast') OR
    ("action" IN ('personality.create','personality.update','personality.activate','personality.deactivate','personality.set_default') AND "entityType"='personality')
  );
