# Talking Bob: backend operations runbook

> Verified on 2026-08-08 for the backend-only deployment. The broader
> [deployment plan](DEPLOYMENT_PLAN.md) remains forward-looking and includes
> admin/reverse-proxy work outside this runbook.

## Release artifacts and topology

Use Node.js `24.18.0`, as pinned by `.nvmrc`, `package.json`, and the Docker
base digest. Build the `runtime` and `init` targets from the same commit. The
runtime target contains compiled code and production dependencies only and
runs as the unprivileged `node` user. The init target contains Prisma migration
and seed tooling and is a one-shot process.

Publish both images, record their registry digests, and set:

```dotenv
TALKING_BOB_RUNTIME_IMAGE=registry.example/talking-bob/runtime
TALKING_BOB_RUNTIME_DIGEST=sha256:...
TALKING_BOB_INIT_IMAGE=registry.example/talking-bob/init
TALKING_BOB_INIT_DIGEST=sha256:...
```

`docker-compose.yml` is the development path: it builds locally and binds DB
and HTTP ports to loopback. `compose.production.yml` pulls immutable
repository-plus-digest references and publishes neither PostgreSQL nor the
backend to the host. Its private network must retain outbound access to
Telegram and Cloud.ru.

Only one complete app instance may poll Telegram at a time. Scheduled work is
protected by database row locks, unique occurrence identities, leases, and
fencing, so brief scheduler overlap is safe; that does not approve concurrent
Telegram long polling.

## Health and failure signals

- `GET /health/live` is process-only and returns HTTP 200 without dependencies.
- `GET /health/ready` returns HTTP 200 only when `SELECT 1` succeeds and the
  Telegram runner is `running`. Startup, restart wait, shutdown, stopped, or DB
  failure returns a sanitized HTTP 503.
- Whisper and LLM are excluded from readiness. Provider degradation is found
  through correlated sanitized errors and an external staging smoke.

Docker does not restart a container merely because it is unhealthy. The bot
first performs its bounded Telegram runner retry; after the budget is exhausted
it terminates, and `restart: unless-stopped` takes effect. Persistent DB loss
makes readiness fail and must alert operators rather than create a crash loop.

## Pre-deploy gate

Run from a clean release checkout with a working Docker daemon:

```bash
npm ci
npm run test:ci
npm run test:operations
docker compose config --quiet
TALKING_BOB_RUNTIME_IMAGE=example/runtime \
TALKING_BOB_RUNTIME_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
TALKING_BOB_INIT_IMAGE=example/init \
TALKING_BOB_INIT_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
docker compose -f compose.production.yml config --quiet
```

The operations gate covers a deterministic `/start` -> `/settings` -> three
voice turns -> automatic report -> persisted `/report` resend -> new-question
journey; real PostgreSQL locking, migrations, backup/restore, and legacy
timezone backfills; and runtime/init image contents under two container `TZ`
values. It never contacts Telegram or Cloud.ru.

For staging, use a dedicated bot, test user, database, and bounded provider
credentials. Manually verify `/start`, `/settings`, a real voice upload, the
automatic report, `/report` resend, and the new-question callback. Do not run
this external smoke against ordinary production users or as a startup probe.

## Backup before migrations

Stop the old app before backup so rollback cannot silently discard post-backup
writes. Run `pg_dump` from the pinned PostgreSQL 16 service or an
equally/newer-major client. Do not print `.env`, credentials, or rendered
Compose configuration.

```bash
set -eu
umask 077
backup="talking-bob-$(date -u +%Y%m%dT%H%M%SZ).dump"
temporary="${backup}.tmp"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
docker compose -f compose.production.yml exec -T db sh -ceu \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' \
  > "$temporary"
docker compose -f compose.production.yml exec -T db pg_restore --list \
  < "$temporary" > /dev/null
mv "$temporary" "$backup"
sha256sum "$backup" > "${backup}.sha256"
trap - EXIT HUP INT TERM
```

Record the release commit, image digests, latest migration, UTC timestamp, and
checksum alongside the archive. Copy archive and checksum off-host and monitor
their freshness; a dump left only on the DB host is not a recovery plan.

## Recreate rollout

1. Put the service in maintenance and stop the old app/writers.
2. Create and validate the backup above.
3. Pull the recorded runtime and init image digests.
4. Run the production init service; stop on migration or seed failure.
5. Start exactly one new app instance.
6. Wait for `/health/ready` to return 200, then perform the staging smoke.
7. Keep previous image digests and backup through the observation window.

The stop grace exceeds the bounded application drain deadline. Do not use
`docker compose down -v` during routine deploy or rollback.

## Restore test and rollback

Never restore over the live writable database. Create a distinctly named empty
PostgreSQL 16 database, and fail if it already exists:

```bash
set -eu
# Select an existing archive explicitly; do not inherit a previous shell value.
backup=/secure/backups/talking-bob-YYYYMMDDTHHMMSSZ.dump
test -f "$backup"
test -f "${backup}.sha256"
backup_dir=$(dirname "$backup")
backup_name=$(basename "$backup")
(cd "$backup_dir" && sha256sum --check "${backup_name}.sha256")
restore_db="talking_bob_restore_$(date -u +%Y%m%d%H%M%S)"
docker compose -f compose.production.yml exec -T -e RESTORE_DB="$restore_db" db \
  sh -ceu 'createdb -U "$POSTGRES_USER" --template=template0 "$RESTORE_DB"'
docker compose -f compose.production.yml exec -T -e RESTORE_DB="$restore_db" db \
  sh -ceu 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$RESTORE_DB"' \
  < "$backup"
```

Before switching, validate migration history/latest migration, expected tables,
critical constraints and unique indexes, representative counts, UTC timestamps,
and an application-compatible read. The automated PostgreSQL gate performs
these checks on an isolated database.

For backward-compatible migrations, stop the failed release and restart the
previous runtime digest against the upgraded DB. For an incompatible change,
stop all writers, restore to a separate database/volume, validate it, then
restore the previous release's runtime digest, init digest, and Compose
configuration before switching `DATABASE_URL`/service ownership. Never run the
failed release's init image against the restored database: Compose always gates
the app on init and would otherwise reapply the incompatible migration. Never
automatically reverse Prisma migrations.

## Monitoring and retention

Compose rotates JSON logs at 10 MiB with five files. Platform monitoring must
also alert on Docker filesystem usage, PostgreSQL volume free space, backup
age/checksum, and off-host backup presence.

Monitor recent delivery failures and ambiguous attempts, not lifetime totals:

```sql
SELECT "deliveryStatus", count(*)
FROM user_prompts
WHERE ("deliveryStatus" = 'failed'
       AND "lastDeliveryErrorAt" >= now() - interval '15 minutes')
   OR ("deliveryStatus" = 'pending'
       AND "deliveryAttemptedAt" >= now() - interval '15 minutes')
GROUP BY "deliveryStatus";

SELECT status, count(*)
FROM report_delivery_requests
WHERE (status = 'failed'
       AND "lastDeliveryErrorAt" >= now() - interval '15 minutes')
   OR (status = 'pending'
       AND "deliveryAttemptedAt" >= now() - interval '15 minutes')
GROUP BY status;
```

Correlate alerts through sanitized `error_logs."correlationId"`; never copy
provider bodies, transcripts, Telegram tokens, or database URLs into logs.

## Timezone evidence and known residual

The container gate executes the same scheduling calculation with `TZ=UTC` and
`TZ=Asia/Tokyo`. The PostgreSQL gate runs actual legacy backfill migrations in
databases using different session timezones and compares semantic UTC instants,
occurrence identities, quota bounds, and lifecycle outcomes.

One applied legacy migration derives an opaque quota-window ID from a textual
`timestamptz` representation, so that surrogate ID can differ by PostgreSQL
session timezone even though the linked request, timezone snapshot, UTC bounds,
and quota behavior are identical. This is an identifier-only residual, not a
business-time dependency.

Compose constructs its internal PostgreSQL URL from `POSTGRES_USER`,
`POSTGRES_PASSWORD`, and `POSTGRES_DB`. Their values must use URI-unreserved
characters (`A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, `-`); otherwise provide an
equivalently encoded deployment configuration before rollout.
