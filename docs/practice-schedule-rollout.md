# Practice schedule and re-engagement rollout

This runbook covers the additive release that adds `users.promptWeekdaysMask`,
independent broadcast audience periods, and the optional `open_schedule` action.
Use one release commit for the migration, backend, and admin bundle.

## Migration and release order

1. Put the service in maintenance. Stop the old runtime, scheduler, dispatcher,
   and all new writes before taking the backup. Keep the backup and release
   identifiers recorded as required by [`docs/operations.md`](operations.md).
2. Apply the additive Prisma migration. It adds `promptWeekdaysMask NOT NULL
   DEFAULT 127` with a `1..127` check and nullable `Broadcast.messageAction`
   with a check for `NULL` or `open_schedule`. Existing broadcast filters,
   timestamps, recipients, and streak history are not rewritten.
3. Start the new backend only, then check readiness and run the backend preview
   checks below on staging fixtures. Startup normalization must not send a
   question.
4. Publish the admin bundle only after the backend accepts and returns the new
   fields. A legacy UI must not create new options.
5. Keep the previous image and backup through the observation window. Deployment
   itself must not create a campaign, submit a preview, or send a message.

Do not run old and new pollers/workers concurrently. The old backend is expected
to reject new request body fields with 422; the new form must therefore remain
closed until the backend gate passes.

## Backend preview gate

Use test data that includes enabled and disabled users, all-seven-day defaults,
a sparse weekday mask, a non-standard minute, and queued broadcasts without the
new fields. In the admin form manually enter: no-voice period `N=14`, scheduled
delivery period `M=14`, `dailyPromptEnabled=true`, a locally authored message,
and `open_schedule` (or no action for the control case). Preview must show the
exact authored text, both independent periods, action, `evaluatedAt`, and the
recipient count. Do not press create/send during this gate; no real Telegram
message is allowed.

Run the existing admin/API preview tests and verify that changing either period
or the action does not change the authored text. Verify a zero recipient preview
contains no send operation. Verify the action is persisted with the snapshot and
that old broadcasts retain `messageAction = NULL`.

## Rollback gates

Prefer a forward fix. If rollback is required, stop new writes plus scheduler and
broadcast dispatcher first, then run these read-only queries against the live
database. A non-empty result blocks starting the old runtime; it means the old
code cannot represent or enforce the new semantics.

```sql
-- Sparse masks, including disabled users.
SELECT "dailyPromptEnabled", count(*) AS sparse_users
FROM "users"
WHERE "promptWeekdaysMask" <> 127
GROUP BY "dailyPromptEnabled";

-- New broadcast options in work that the old dispatcher could process.
SELECT "status",
       ("messageAction" IS NOT NULL) AS has_action,
       (("filters" ->> 'noVoiceForDays') IS NOT NULL) AS has_no_voice_period,
       (("filters" ->> 'scheduledDeliveryWithinDays') IS NOT NULL) AS has_scheduled_period,
       count(*) AS broadcasts
FROM "broadcasts"
WHERE "status" IN ('queued', 'processing')
  AND ("messageAction" IS NOT NULL
       OR "filters" ->> 'noVoiceForDays' IS NOT NULL
       OR "filters" ->> 'scheduledDeliveryWithinDays' IS NOT NULL)
GROUP BY "status", has_action, has_no_voice_period, has_scheduled_period;
```

The second query deliberately reports action and each period separately and
together. Legacy broadcasts with all three values absent are excluded. Do not
fix rows with ad-hoc SQL and do not run a destructive down migration. If a gate
is non-zero, keep the service stopped and either deploy a forward fix or use a
separately approved recovery procedure.

A database count of zero does not restore old user experience for already sent
buttons. Historical `open_schedule` buttons require the new Telegram callback
handler; therefore an old runtime is not acceptable while those messages may be
used, even when the rollback queries return zero.

## Post-release checks

Confirm readiness, one active Telegram poller, no unexpected scheduler sends
during normalization, and an admin preview with no create action. Then verify a
user can open `/schedule`, choose days, save a custom time, select manual mode,
and later re-enable the saved days. Streak behavior remains daily and is not
changed by the rollout.
