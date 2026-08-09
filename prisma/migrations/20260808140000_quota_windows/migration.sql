-- Persist calendar quota identity so timezone changes cannot reopen an active
-- allowance. Legacy dialog starts are backfilled before runtime starts using
-- the user's current valid timezone (or the application default for invalid
-- legacy values), preventing a quota reset during deployment.

CREATE TABLE "quota_windows" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "timezoneSnapshot" VARCHAR(128) NOT NULL,
  "windowStart" TIMESTAMPTZ(3) NOT NULL,
  "windowEnd" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quota_windows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quota_windows_window_range_check" CHECK ("windowEnd" > "windowStart"),
  CONSTRAINT "quota_windows_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "user_requests"
  ADD COLUMN "quotaWindowId" TEXT;

CREATE UNIQUE INDEX "quota_windows_userId_action_windowStart_windowEnd_key"
  ON "quota_windows"("userId", "action", "windowStart", "windowEnd");
CREATE INDEX "quota_windows_userId_action_windowEnd_idx"
  ON "quota_windows"("userId", "action", "windowEnd");
CREATE INDEX "quota_windows_windowEnd_idx"
  ON "quota_windows"("windowEnd");

WITH requests_with_timezone AS (
  SELECT
    ur."userId",
    ur."action",
    ur."createdAt",
    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_timezone_names WHERE name = u."timezone"
      ) THEN u."timezone"
      ELSE 'Europe/Moscow'
    END AS timezone_snapshot
  FROM "user_requests" AS ur
  JOIN "users" AS u ON u."id" = ur."userId"
  WHERE ur."action" = 'dialog_start'
), legacy_boundaries AS (
  SELECT DISTINCT
    "userId",
    "action",
    timezone_snapshot,
    DATE_TRUNC('day', "createdAt" AT TIME ZONE timezone_snapshot)
      AT TIME ZONE timezone_snapshot AS window_start,
    (DATE_TRUNC('day', "createdAt" AT TIME ZONE timezone_snapshot) + INTERVAL '1 day')
      AT TIME ZONE timezone_snapshot AS window_end
  FROM requests_with_timezone
)
INSERT INTO "quota_windows" (
  "id",
  "userId",
  "action",
  "timezoneSnapshot",
  "windowStart",
  "windowEnd"
)
SELECT
  'legacy:' || MD5(
    "userId" || ':' || "action" || ':' || window_start::TEXT || ':' || window_end::TEXT
  ),
  "userId",
  "action",
  timezone_snapshot,
  window_start,
  window_end
FROM legacy_boundaries;

UPDATE "user_requests" AS ur
SET "quotaWindowId" = qw."id"
FROM "quota_windows" AS qw
WHERE ur."action" = 'dialog_start'
  AND qw."userId" = ur."userId"
  AND qw."action" = ur."action"
  AND ur."createdAt" >= qw."windowStart"
  AND ur."createdAt" < qw."windowEnd";

ALTER TABLE "user_requests"
  ADD CONSTRAINT "user_requests_quotaWindowId_fkey"
    FOREIGN KEY ("quotaWindowId") REFERENCES "quota_windows"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_user_request_quota_window_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."quotaWindowId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "quota_windows" AS qw
    WHERE qw."id" = NEW."quotaWindowId"
      AND qw."userId" = NEW."userId"
      AND qw."action" = NEW."action"
  ) THEN
    RAISE EXCEPTION 'user request does not match quota window identity'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_requests_quota_window_identity_check"
BEFORE INSERT OR UPDATE OF "quotaWindowId", "userId", "action"
ON "user_requests"
FOR EACH ROW
EXECUTE FUNCTION enforce_user_request_quota_window_identity();

CREATE INDEX "user_requests_userId_action_createdAt_idx"
  ON "user_requests"("userId", "action", "createdAt");
CREATE INDEX "user_requests_quotaWindowId_createdAt_idx"
  ON "user_requests"("quotaWindowId", "createdAt");
CREATE INDEX "user_requests_createdAt_idx"
  ON "user_requests"("createdAt");

CREATE FUNCTION prevent_quota_window_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."action" IS DISTINCT FROM OLD."action"
    OR NEW."timezoneSnapshot" IS DISTINCT FROM OLD."timezoneSnapshot"
    OR NEW."windowStart" IS DISTINCT FROM OLD."windowStart"
    OR NEW."windowEnd" IS DISTINCT FROM OLD."windowEnd"
  THEN
    RAISE EXCEPTION 'quota window identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "quota_windows_identity_immutable"
BEFORE UPDATE ON "quota_windows"
FOR EACH ROW
EXECUTE FUNCTION prevent_quota_window_identity_change();
