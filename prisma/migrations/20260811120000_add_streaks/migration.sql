CREATE TYPE "StreakDayKind" AS ENUM ('activity', 'freeze');
CREATE TYPE "StreakReminderStatus" AS ENUM (
  'pending',
  'sent',
  'cancelled',
  'failed',
  'expired'
);

ALTER TABLE "users"
  ADD COLUMN "currentStreak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "longestStreak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastStreakLocalDate" DATE,
  ADD COLUMN "streakExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "streakReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "streakReminderHour" INTEGER NOT NULL DEFAULT 21,
  ADD COLUMN "streakReminderMinute" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextStreakReminderAt" TIMESTAMPTZ(3);

ALTER TABLE "user_responses"
  ADD COLUMN "streakCurrentSnapshot" INTEGER,
  ADD COLUMN "streakLongestSnapshot" INTEGER,
  ADD COLUMN "streakIsNewRecord" BOOLEAN;

CREATE TABLE "streak_days" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "localDate" DATE NOT NULL,
  "qualifiedAt" TIMESTAMPTZ(3) NOT NULL,
  "timezoneSnapshot" VARCHAR(128) NOT NULL,
  "kind" "StreakDayKind" NOT NULL DEFAULT 'activity',
  "streakLength" INTEGER NOT NULL,
  "longestStreak" INTEGER NOT NULL,
  "sourceUserPromptId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "streak_days_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "streak_days_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "streak_days_sourceUserPromptId_fkey"
    FOREIGN KEY ("sourceUserPromptId") REFERENCES "user_prompts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "streak_days_values_check"
    CHECK (
      "streakLength" > 0
      AND "longestStreak" >= "streakLength"
      AND char_length("timezoneSnapshot") BETWEEN 1 AND 128
    )
);

CREATE TABLE "streak_reminders" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "localDate" DATE NOT NULL,
  "status" "StreakReminderStatus" NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimToken" UUID,
  "claimExpiresAt" TIMESTAMPTZ(3),
  "nextAttemptAt" TIMESTAMPTZ(3),
  "deliveryAttemptedAt" TIMESTAMPTZ(3),
  "sentAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "lastErrorCode" VARCHAR(64),
  "lastErrorAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "streak_reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "streak_reminders_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "streak_reminders_attempt_count_check"
    CHECK ("attemptCount" >= 0),
  CONSTRAINT "streak_reminders_claim_pair_check"
    CHECK (("claimToken" IS NULL) = ("claimExpiresAt" IS NULL)),
  CONSTRAINT "streak_reminders_error_pair_check"
    CHECK (("lastErrorCode" IS NULL) = ("lastErrorAt" IS NULL)),
  CONSTRAINT "streak_reminders_error_code_check"
    CHECK (
      "lastErrorCode" IS NULL
      OR "lastErrorCode" ~ '^[a-z0-9_]{1,64}$'
    ),
  CONSTRAINT "streak_reminders_deadline_check"
    CHECK ("nextAttemptAt" IS NULL OR "nextAttemptAt" < "expiresAt"),
  CONSTRAINT "streak_reminders_status_check"
    CHECK (
      (
        "status" = 'pending'
        AND "sentAt" IS NULL
      )
      OR (
        "status" = 'sent'
        AND "deliveryAttemptedAt" IS NOT NULL
        AND "sentAt" IS NOT NULL
        AND "lastErrorCode" IS NULL
      )
      OR (
        "status" = 'failed'
        AND "deliveryAttemptedAt" IS NOT NULL
        AND "sentAt" IS NULL
        AND "lastErrorCode" IS NOT NULL
      )
      OR (
        "status" IN ('cancelled', 'expired')
        AND "sentAt" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "streak_days_userId_localDate_key"
  ON "streak_days"("userId", "localDate");
CREATE UNIQUE INDEX "streak_days_sourceUserPromptId_key"
  ON "streak_days"("sourceUserPromptId");
CREATE INDEX "streak_days_user_local_date_idx"
  ON "streak_days"("userId", "localDate");
CREATE UNIQUE INDEX "streak_reminders_userId_localDate_key"
  ON "streak_reminders"("userId", "localDate");
CREATE INDEX "streak_reminders_reclaim_idx"
  ON "streak_reminders"("status", "nextAttemptAt", "claimExpiresAt");
CREATE INDEX "streak_reminders_expires_at_idx"
  ON "streak_reminders"("expiresAt");
CREATE INDEX "users_next_streak_reminder_at_idx"
  ON "users"("nextStreakReminderAt");

ALTER TABLE "users"
  ADD CONSTRAINT "users_streak_values_check"
    CHECK (
      "currentStreak" >= 0
      AND "longestStreak" >= "currentStreak"
      AND "streakReminderHour" BETWEEN 0 AND 23
      AND "streakReminderMinute" BETWEEN 0 AND 59
    ),
  ADD CONSTRAINT "users_streak_aggregate_check"
    CHECK (
      (
        "currentStreak" = 0
        AND "lastStreakLocalDate" IS NULL
        AND "streakExpiresAt" IS NULL
        AND "nextStreakReminderAt" IS NULL
      )
      OR (
        "currentStreak" > 0
        AND "lastStreakLocalDate" IS NOT NULL
        AND "streakExpiresAt" IS NOT NULL
      )
    );

ALTER TABLE "user_responses"
  ADD CONSTRAINT "user_responses_streak_snapshot_check"
    CHECK (
      (
        "streakCurrentSnapshot" IS NULL
        AND "streakLongestSnapshot" IS NULL
        AND "streakIsNewRecord" IS NULL
      )
      OR (
        "streakCurrentSnapshot" > 0
        AND "streakLongestSnapshot" >= "streakCurrentSnapshot"
        AND "streakIsNewRecord" IS NOT NULL
      )
    );

-- Intentionally no historical backfill: existing users start at streak zero.
