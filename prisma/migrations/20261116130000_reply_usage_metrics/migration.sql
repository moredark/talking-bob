-- Unknown historical reply formats remain unclassified.
ALTER TABLE "user_activity_days"
  ADD COLUMN "textMessageCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "voiceMessageCount" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "user_activity_days_reply_counts_check" CHECK (
    "textMessageCount" >= 0 AND "voiceMessageCount" >= 0
    AND "textMessageCount"::bigint + "voiceMessageCount"::bigint <= "messageCount"::bigint
  );
ALTER TABLE "admin_analytics_coverage"
  ADD COLUMN "replyUsageCompleteFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
