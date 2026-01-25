-- AlterTable
ALTER TABLE "users" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow';
ALTER TABLE "users" ADD COLUMN "lastPromptSentAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "nextPromptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "users_nextPromptAt_idx" ON "users"("nextPromptAt");

-- Initialize nextPromptAt for existing users with daily prompts enabled
-- This calculates the next prompt time based on their current settings
UPDATE "users"
SET "nextPromptAt" = (
  CASE
    WHEN "dailyPromptEnabled" = true THEN
      -- Calculate next prompt time for today or tomorrow
      CASE
        WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::time <
             (("dailyPromptHour" || ':' || "dailyPromptMinute" || ':00')::time)
        THEN
          -- Today at the specified time
          (CURRENT_DATE + ("dailyPromptHour" || ':' || "dailyPromptMinute" || ':00')::time)
          AT TIME ZONE 'Europe/Moscow' AT TIME ZONE 'UTC'
        ELSE
          -- Tomorrow at the specified time
          (CURRENT_DATE + INTERVAL '1 day' + ("dailyPromptHour" || ':' || "dailyPromptMinute" || ':00')::time)
          AT TIME ZONE 'Europe/Moscow' AT TIME ZONE 'UTC'
      END
    ELSE
      NULL
  END
);
