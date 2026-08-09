const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const POSTGRES_IMAGE =
  "postgres:16.13-alpine3.23@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50";
const LATEST_MIGRATION = "20260808180000_prompt_selection_history";
const PRE_LIFECYCLE_MIGRATIONS = [
  "20260118172424",
  "20260124153443_add_conversation_messages",
  "20260124160345_add_user_daily_prompt_settings",
  "20260125000000_add_schedule_fields",
  "20260128180643",
  "20260128181852_add_admin_features",
  "20260307110000_add_agent_tone",
  "20260728120000_optional_prompt_audio",
];
const runId = randomBytes(8).toString("hex");
const containerName = `talking-bob-pg-test-${runId}`;
const ownershipLabel = `talking-bob.postgres-integration=${runId}`;
const database = `talking_bob_test_${runId}`;
const restoreDatabase = `${database}_restore`;
const matrixDatabases = [
  { database: `${database}_matrix_honolulu`, timezone: "Pacific/Honolulu" },
  { database: `${database}_matrix_tokyo`, timezone: "Asia/Tokyo" },
];
const username = `bob_${runId}`;
const password = randomBytes(24).toString("hex");
let started = false;
let cleaningUp = false;
let activeChild = null;
let interruptedBy = null;
let shuttingDown = false;

const DOCKER_TIMEOUT_MS = 120_000;
const DOCKER_CLEANUP_TIMEOUT_MS = 15_000;
const CHILD_TIMEOUT_MS = 180_000;
const CHILD_SHUTDOWN_GRACE_MS = 5_000;
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function docker(args, options = {}) {
  const { capture = false, timeoutMs = DOCKER_TIMEOUT_MS } = options;
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: timeoutMs,
  });
}

function checkedDocker(args, options = {}) {
  const result = docker(args, options);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`docker ${args[0]} failed: ${detail}`);
  }
  return result.stdout?.trim() || "";
}

function psql(targetDatabase, sql, options = {}) {
  return checkedDocker(
    [
      "exec",
      containerName,
      "psql",
      "--username",
      username,
      "--dbname",
      targetDatabase,
      "--no-align",
      "--tuples-only",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      sql,
    ],
    { capture: true, ...options },
  );
}

function createDatabase(targetDatabase) {
  checkedDocker([
    "exec",
    containerName,
    "createdb",
    "--username",
    username,
    "--template",
    "template0",
    targetDatabase,
  ]);
}

function databaseUrlFor(targetDatabase, port) {
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(targetDatabase)}?schema=public`;
}

function cleanup() {
  if (!started || cleaningUp) return;
  cleaningUp = true;
  try {
    const inspected = docker(
      ["inspect", "--format", "{{.Name}}|{{index .Config.Labels \"talking-bob.postgres-integration\"}}", containerName],
      { capture: true, timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS },
    );
    if (inspected.status !== 0) return;
    const [actualName, actualRunId] = inspected.stdout.trim().split("|");
    if (actualName !== `/${containerName}` || actualRunId !== runId) {
      throw new Error(`refusing to remove container that is not owned by this run: ${containerName}`);
    }
    const removed = docker(["rm", "--force", containerName], {
      capture: true,
      timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS,
    });
    if (removed.status !== 0) {
      process.stderr.write(`Failed to remove ${containerName}: ${removed.stderr}\n`);
    }
  } finally {
    started = false;
    cleaningUp = false;
  }
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    let timedOut = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, CHILD_SHUTDOWN_GRACE_MS);
    }, CHILD_TIMEOUT_MS);
    const clearTimers = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    activeChild = child;
    child.once("error", (error) => {
      clearTimers();
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimers();
      if (activeChild === child) activeChild = null;
      if (timedOut) reject(new Error(`${command} exceeded ${CHILD_TIMEOUT_MS}ms`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal || `exit ${code}`})`));
    });
  });
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function shutdownForSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  interruptedBy = signal;

  const child = activeChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    const exited = await waitForChildExit(child, CHILD_SHUTDOWN_GRACE_MS);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child, CHILD_SHUTDOWN_GRACE_MS);
    }
  }

  try {
    cleanup();
  } catch (error) {
    process.stderr.write(`PostgreSQL integration cleanup failed: ${error.message}\n`);
  } finally {
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  }
}

async function waitUntilReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = docker(
      ["exec", containerName, "pg_isready", "--username", username, "--dbname", database],
      { capture: true },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("ephemeral PostgreSQL did not become ready within 30 seconds");
}

async function migrate(databaseUrl, args = ["migrate", "deploy"]) {
  await run(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", ...args],
    { ...process.env, DATABASE_URL: databaseUrl },
  );
}

function recoverySnapshot(targetDatabase) {
  const raw = psql(
    targetDatabase,
    `
      SELECT jsonb_build_object(
        'latest_migration', EXISTS (
          SELECT 1 FROM "_prisma_migrations"
          WHERE migration_name = '${LATEST_MIGRATION}'
            AND finished_at IS NOT NULL
            AND rolled_back_at IS NULL
        ),
        'tables', (
          SELECT jsonb_agg(table_name ORDER BY table_name)
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ),
        'constraints', (
          SELECT jsonb_agg(conname ORDER BY conname)
          FROM pg_constraint
          WHERE conname IN (
            'user_prompts_scheduled_metadata_check',
            'report_delivery_requests_chunks_check',
            'quota_windows_window_range_check',
            'user_responses_sensitive_data_purge_check'
          )
        ),
        'indexes', (
          SELECT jsonb_agg(indexname ORDER BY indexname)
          FROM pg_indexes
          WHERE schemaname = 'public' AND indexname IN (
            'user_prompts_scheduledOccurrenceKey_unique',
            'conversation_messages_telegramUpdateId_key',
            'report_delivery_requests_userResponseId_requestKey_key'
          )
        ),
        'counts', jsonb_build_object(
          'users', (SELECT COUNT(*) FROM users),
          'prompts', (SELECT COUNT(*) FROM prompts),
          'user_prompts', (SELECT COUNT(*) FROM user_prompts),
          'conversation_messages', (SELECT COUNT(*) FROM conversation_messages),
          'user_responses', (SELECT COUNT(*) FROM user_responses),
          'report_delivery_requests', (SELECT COUNT(*) FROM report_delivery_requests),
          'user_requests', (SELECT COUNT(*) FROM user_requests),
          'quota_windows', (SELECT COUNT(*) FROM quota_windows),
          'error_logs', (SELECT COUNT(*) FROM error_logs)
        ),
        'timestamptz', jsonb_build_object(
          'users', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(id, EXTRACT(EPOCH FROM "lastPromptSentAt"), EXTRACT(EPOCH FROM "nextPromptAt")) ORDER BY id)
            FROM users WHERE "lastPromptSentAt" IS NOT NULL OR "nextPromptAt" IS NOT NULL
          ), '[]'::jsonb),
          'user_prompts', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(id, EXTRACT(EPOCH FROM "createdAt"), EXTRACT(EPOCH FROM "sentAt"), EXTRACT(EPOCH FROM "scheduledFor")) ORDER BY id)
            FROM user_prompts
          ), '[]'::jsonb),
          'responses', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(id, EXTRACT(EPOCH FROM "createdAt"), EXTRACT(EPOCH FROM "generatedAt")) ORDER BY id)
            FROM user_responses
          ), '[]'::jsonb),
          'requests', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(id, EXTRACT(EPOCH FROM "createdAt")) ORDER BY id)
            FROM user_requests
          ), '[]'::jsonb),
          'quota_windows', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(id, EXTRACT(EPOCH FROM "windowStart"), EXTRACT(EPOCH FROM "windowEnd")) ORDER BY id)
            FROM quota_windows
          ), '[]'::jsonb)
        )
      )::text;
    `,
  );
  return JSON.parse(raw);
}

function verifyRecovery(source, restored) {
  assert.equal(source.latest_migration, true);
  assert.deepEqual(restored, source);
  for (const table of [
    "_prisma_migrations",
    "users",
    "user_prompts",
    "user_responses",
    "report_delivery_requests",
    "quota_windows",
    "error_logs",
  ]) {
    assert.ok(source.tables.includes(table), `recovery snapshot is missing table ${table}`);
  }
  assert.equal(source.constraints.length, 4);
  assert.equal(source.indexes.length, 3);
}

async function verifyDumpAndRestore() {
  const archivePath = `/tmp/talking-bob-${runId}.dump`;
  checkedDocker([
    "exec",
    containerName,
    "pg_dump",
    "--username",
    username,
    "--dbname",
    database,
    "--format",
    "custom",
    "--file",
    archivePath,
  ]);
  const archiveList = checkedDocker(
    ["exec", containerName, "pg_restore", "--list", archivePath],
    { capture: true },
  );
  assert.match(archiveList, /TABLE public users/);
  assert.match(archiveList, /TABLE public user_prompts/);
  assert.match(archiveList, /TABLE public _prisma_migrations/);

  createDatabase(restoreDatabase);
  checkedDocker([
    "exec",
    containerName,
    "pg_restore",
    "--exit-on-error",
    "--no-owner",
    "--username",
    username,
    "--dbname",
    restoreDatabase,
    archivePath,
  ]);
  verifyRecovery(recoverySnapshot(database), recoverySnapshot(restoreDatabase));
  process.stdout.write("Custom-format backup/restore verification passed.\n");
}

const LEGACY_FIXTURE_SQL = `
  INSERT INTO users (
    id, "telegramId", username, "createdAt", "updatedAt",
    "dailyPromptEnabled", "dailyPromptHour", "dailyPromptMinute", timezone,
    "lastPromptSentAt", "nextPromptAt", status, "agentTone"
  ) VALUES (
    'legacy-user', 900000001, 'legacy', TIMESTAMP '2026-03-08 07:00:00',
    TIMESTAMP '2026-03-08 07:00:00', true, 13, 0, 'America/New_York',
    TIMESTAMP '2026-03-08 07:30:00', TIMESTAMP '2026-03-09 17:00:00',
    'active', 'friendly'
  );
  INSERT INTO prompts (
    id, topic, "audioFileId", "isActive", "createdAt",
    difficulty, "sortOrder", tags, "textContent"
  ) VALUES (
    'legacy-prompt', 'legacy', NULL, true, TIMESTAMP '2026-03-08 07:00:00',
    'medium', 0, ARRAY[]::TEXT[], 'Legacy prompt'
  );
  INSERT INTO user_prompts (id, "userId", "promptId", "sentAt") VALUES
    ('legacy-sent', 'legacy-user', 'legacy-prompt', TIMESTAMP '2026-03-08 07:31:00'),
    ('legacy-ambiguous', 'legacy-user', 'legacy-prompt', TIMESTAMP '2026-03-08 08:31:00');
  INSERT INTO conversation_messages (
    id, "userPromptId", role, content, "createdAt"
  ) VALUES
    ('legacy-message-1', 'legacy-sent', 'user', 'one', TIMESTAMP '2026-03-08 07:32:00'),
    ('legacy-message-2', 'legacy-sent', 'user', 'two', TIMESTAMP '2026-03-08 07:33:00'),
    ('legacy-message-3', 'legacy-sent', 'user', 'three', TIMESTAMP '2026-03-08 07:34:00');
  INSERT INTO user_responses (
    id, "userId", "userPromptId", "voiceFileId", transcript, analysis, "createdAt"
  ) VALUES (
    'legacy-response', 'legacy-user', 'legacy-sent', 'legacy-voice', NULL,
    '{"summary":"legacy"}', TIMESTAMP '2026-03-08 07:35:00'
  );
  INSERT INTO user_requests (id, "userId", action, "createdAt") VALUES (
    'legacy-request', 'legacy-user', 'dialog_start', TIMESTAMP '2026-11-01 05:30:00'
  );
  INSERT INTO error_logs (
    id, type, service, message, "createdAt"
  ) VALUES (
    'legacy-error', 'Legacy', 'matrix', 'legacy', TIMESTAMP '2026-03-08 07:36:00'
  );
`;

function matrixSnapshot(targetDatabase) {
  return JSON.parse(
    psql(
      targetDatabase,
      `
        SELECT jsonb_build_object(
          'user', (
            SELECT jsonb_build_object(
              'last_prompt_ms', EXTRACT(EPOCH FROM "lastPromptSentAt") * 1000,
              'next_prompt_is_null', "nextPromptAt" IS NULL
            ) FROM users WHERE id = 'legacy-user'
          ),
          'prompts', (
            SELECT jsonb_agg(jsonb_build_object(
              'id', id,
              'source', source,
              'delivery_status', "deliveryStatus",
              'created_ms', EXTRACT(EPOCH FROM "createdAt") * 1000,
              'sent_ms', EXTRACT(EPOCH FROM "sentAt") * 1000,
              'attempted_ms', EXTRACT(EPOCH FROM "deliveryAttemptedAt") * 1000,
              'error_code', "lastDeliveryErrorCode",
              'conversation_status', "conversationStatus",
              'closed_ms', EXTRACT(EPOCH FROM "conversationClosedAt") * 1000
            ) ORDER BY id)
            FROM user_prompts WHERE "userId" = 'legacy-user'
          ),
          'response', (
            SELECT jsonb_build_object(
              'transcript', transcript,
              'generation_status', "generationStatus",
              'request_key', "generationRequestKey",
              'generated_ms', EXTRACT(EPOCH FROM "generatedAt") * 1000,
              'analysis_version', "analysisVersion",
              'analysis_kind', "analysisKind"
            ) FROM user_responses WHERE id = 'legacy-response'
          ),
          'quota', (
            SELECT jsonb_build_object(
              'timezone', qw."timezoneSnapshot",
              'start_ms', EXTRACT(EPOCH FROM qw."windowStart") * 1000,
              'end_ms', EXTRACT(EPOCH FROM qw."windowEnd") * 1000,
              'request_is_linked', ur."quotaWindowId" = qw.id
            )
            FROM user_requests ur
            JOIN quota_windows qw ON qw.id = ur."quotaWindowId"
            WHERE ur.id = 'legacy-request'
          ),
          'error_created_ms', (
            SELECT EXTRACT(EPOCH FROM "createdAt") * 1000
            FROM error_logs WHERE id = 'legacy-error'
          ),
          'latest_migration', EXISTS (
            SELECT 1 FROM "_prisma_migrations"
            WHERE migration_name = '${LATEST_MIGRATION}'
              AND finished_at IS NOT NULL
              AND rolled_back_at IS NULL
          )
        )::text;
      `,
    ),
  );
}

async function prepareLegacyMatrixDatabase(targetDatabase, timezone, port) {
  createDatabase(targetDatabase);
  for (const migration of PRE_LIFECYCLE_MIGRATIONS) {
    checkedDocker([
      "exec",
      containerName,
      "psql",
      "--username",
      username,
      "--dbname",
      targetDatabase,
      "--set",
      "ON_ERROR_STOP=1",
      "--file",
      `/tmp/talking-bob-migrations/${migration}/migration.sql`,
    ]);
  }

  const url = databaseUrlFor(targetDatabase, port);
  for (const migration of PRE_LIFECYCLE_MIGRATIONS) {
    await migrate(url, ["migrate", "resolve", "--applied", migration]);
  }
  psql(targetDatabase, LEGACY_FIXTURE_SQL);
  psql(database, `ALTER DATABASE "${targetDatabase}" SET TimeZone TO '${timezone}'`);
  await migrate(url);
  assert.equal(psql(targetDatabase, "SELECT current_setting('TimeZone');"), timezone);
  return matrixSnapshot(targetDatabase);
}

async function verifyLegacyTimezoneMatrix(port) {
  checkedDocker([
    "cp",
    "prisma/migrations",
    `${containerName}:/tmp/talking-bob-migrations`,
  ]);
  const snapshots = [];
  for (const entry of matrixDatabases) {
    snapshots.push(
      await prepareLegacyMatrixDatabase(entry.database, entry.timezone, port),
    );
  }
  assert.deepEqual(snapshots[1], snapshots[0]);

  const snapshot = snapshots[0];
  assert.equal(snapshot.latest_migration, true);
  assert.equal(snapshot.user.next_prompt_is_null, true);
  assert.equal(Number(snapshot.user.last_prompt_ms), Date.parse("2026-03-08T07:30:00.000Z"));
  assert.equal(snapshot.prompts.length, 2);
  const ambiguous = snapshot.prompts.find(({ id }) => id === "legacy-ambiguous");
  assert.equal(ambiguous.delivery_status, "pending");
  assert.equal(ambiguous.error_code, "legacy_unknown");
  const sent = snapshot.prompts.find(({ id }) => id === "legacy-sent");
  assert.equal(sent.delivery_status, "sent");
  assert.equal(sent.conversation_status, "closed");
  assert.equal(snapshot.response.generation_status, "generated");
  assert.equal(snapshot.response.analysis_version, 0);
  assert.equal(snapshot.response.analysis_kind, "legacy");
  assert.equal(snapshot.quota.timezone, "America/New_York");
  assert.equal(Number(snapshot.quota.start_ms), Date.parse("2026-11-01T04:00:00.000Z"));
  assert.equal(Number(snapshot.quota.end_ms), Date.parse("2026-11-02T05:00:00.000Z"));
  assert.equal(snapshot.quota.request_is_linked, true);
  assert.equal(Number(snapshot.error_created_ms), Date.parse("2026-03-08T07:36:00.000Z"));
  process.stdout.write("Legacy backfill session-TimeZone matrix passed.\n");
}

async function main() {
  checkedDocker(["info"], { capture: true });
  checkedDocker([
    "run",
    "--detach",
    "--rm",
    "--name", containerName,
    "--label", ownershipLabel,
    "--publish", "127.0.0.1::5432",
    "--env", `POSTGRES_DB=${database}`,
    "--env", `POSTGRES_USER=${username}`,
    "--env", `POSTGRES_PASSWORD=${password}`,
    POSTGRES_IMAGE,
  ], { capture: true });
  started = true;

  await waitUntilReady();
  const portOutput = checkedDocker(["port", containerName, "5432/tcp"], { capture: true });
  const portMatch = portOutput.match(/127\.0\.0\.1:(\d+)$/m);
  if (!portMatch) throw new Error(`could not resolve loopback PostgreSQL port: ${portOutput}`);

  const port = portMatch[1];
  const databaseUrl = databaseUrlFor(database, port);
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  await migrate(databaseUrl);
  await run(process.execPath, ["--test", "integration/postgres-critical-invariants.integration.js"], env);
  await verifyDumpAndRestore();
  await verifyLegacyTimezoneMatrix(port);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { void shutdownForSignal(signal); });
}

main()
  .catch((error) => {
    if (!interruptedBy) {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    }
  })
  .finally(cleanup);
