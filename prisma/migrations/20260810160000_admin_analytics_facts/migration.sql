CREATE TABLE "admin_analytics_coverage" (
  "id" TEXT NOT NULL,
  "completeFrom" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_analytics_coverage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_analytics_coverage_singleton_check" CHECK ("id" = 'durable_facts')
);

ALTER TABLE "user_prompts"
  ADD COLUMN "firstUserMessageAt" TIMESTAMPTZ(3);

UPDATE "user_prompts" user_prompt
SET "firstUserMessageAt" = activity."firstUserMessageAt"
FROM (
  SELECT "userPromptId", MIN("createdAt") AS "firstUserMessageAt"
  FROM "conversation_messages"
  WHERE role = 'user'
  GROUP BY "userPromptId"
) activity
WHERE activity."userPromptId" = user_prompt.id;

CREATE INDEX "user_prompts_sent_at_idx" ON "user_prompts"("sentAt");
CREATE INDEX "user_prompts_first_user_message_at_idx" ON "user_prompts"("firstUserMessageAt");

CREATE TABLE "user_activity_days" (
  "userId" TEXT NOT NULL,
  "localDate" DATE NOT NULL,
  "firstActivityAt" TIMESTAMPTZ(3) NOT NULL,
  "lastActivityAt" TIMESTAMPTZ(3) NOT NULL,
  "messageCount" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "user_activity_days_pkey" PRIMARY KEY ("userId", "localDate"),
  CONSTRAINT "user_activity_days_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_activity_days_shape_check" CHECK (
    "messageCount" > 0
    AND "firstActivityAt" <= "lastActivityAt"
    AND ("firstActivityAt" AT TIME ZONE 'Europe/Moscow')::date = "localDate"
    AND ("lastActivityAt" AT TIME ZONE 'Europe/Moscow')::date = "localDate"
  )
);

INSERT INTO "user_activity_days" (
  "userId", "localDate", "firstActivityAt", "lastActivityAt", "messageCount"
)
SELECT
  user_prompt."userId",
  (message."createdAt" AT TIME ZONE 'Europe/Moscow')::date,
  MIN(message."createdAt"),
  MAX(message."createdAt"),
  COUNT(*)::integer
FROM "conversation_messages" message
JOIN "user_prompts" user_prompt ON user_prompt.id = message."userPromptId"
WHERE message.role = 'user'
GROUP BY user_prompt."userId", (message."createdAt" AT TIME ZONE 'Europe/Moscow')::date;

CREATE INDEX "user_activity_days_local_date_user_idx"
  ON "user_activity_days"("localDate", "userId");

ALTER TABLE "user_responses"
  ADD COLUMN "overallScore" DOUBLE PRECISION,
  ADD COLUMN "reportDeliveredAt" TIMESTAMPTZ(3);

CREATE FUNCTION admin_analytics_extract_overall_score(raw_analysis TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parsed JSONB;
  score DOUBLE PRECISION;
BEGIN
  IF raw_analysis IS NULL THEN RETURN NULL; END IF;
  BEGIN
    parsed := raw_analysis::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF jsonb_typeof(parsed) <> 'object' OR jsonb_typeof(parsed -> 'overallScore') <> 'number' THEN
    RETURN NULL;
  END IF;
  BEGIN
    score := (parsed ->> 'overallScore')::double precision;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF score BETWEEN 1 AND 10 THEN RETURN score; END IF;
  RETURN NULL;
END;
$$;

UPDATE "user_responses"
SET "overallScore" = admin_analytics_extract_overall_score(analysis)
WHERE "generationStatus" = 'generated'
  AND "analysisKind" IN ('model', 'legacy');

DROP FUNCTION admin_analytics_extract_overall_score(TEXT);

UPDATE "user_responses" response
SET "reportDeliveredAt" = delivered."reportDeliveredAt"
FROM (
  SELECT "userResponseId", MAX("deliveredAt") AS "reportDeliveredAt"
  FROM "report_delivery_requests"
  WHERE status = 'delivered' AND "deliveredAt" IS NOT NULL
  GROUP BY "userResponseId"
) delivered
WHERE delivered."userResponseId" = response.id;

ALTER TABLE "user_responses"
  ADD CONSTRAINT "user_responses_overall_score_check" CHECK (
    "overallScore" IS NULL OR "overallScore" BETWEEN 1 AND 10
  );

CREATE INDEX "user_responses_generated_at_idx" ON "user_responses"("generatedAt");
CREATE INDEX "user_responses_report_delivered_at_idx" ON "user_responses"("reportDeliveredAt");

INSERT INTO "admin_analytics_coverage" ("id", "completeFrom")
VALUES ('durable_facts', clock_timestamp());
