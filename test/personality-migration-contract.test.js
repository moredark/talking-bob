const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const projectRoot = join(__dirname, "..");
const legacyMigration = readFileSync(
  join(projectRoot, "prisma/migrations/20260812120000_agent_personalities/migration.sql"),
  "utf8",
);
const splitMigration = readFileSync(
  join(projectRoot, "prisma/migrations/20260813120000_split_agent_prompt_rules/migration.sql"),
  "utf8",
);

function migrationList(source, constantName) {
  const declaration = source.match(new RegExp(`const ${constantName} = \\[([\\s\\S]*?)\\n\\];`));
  assert.ok(declaration, `${constantName} migration list must be declared`);
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("legacy personality migration retains the original full-prompt schema", () => {
  assert.match(legacyMigration, /CREATE TABLE "agent_personalities"/);
  assert.match(legacyMigration, /"followUpPrompt" TEXT NOT NULL/);
  assert.match(legacyMigration, /"analysisPrompt" TEXT NOT NULL/);
  assert.doesNotMatch(legacyMigration, /CREATE TABLE "agent_prompt_rules"/);
  assert.doesNotMatch(legacyMigration, /"(?:followUp|analysis)StylePrompt"/);
});

test("split migration fails closed while moving shared rules out of personalities", () => {
  assert.match(splitMigration, /CREATE TABLE "agent_prompt_rules"/);
  assert.match(splitMigration, /ADD COLUMN "followUpStylePrompt" TEXT/);
  assert.match(splitMigration, /ADD COLUMN "analysisStylePrompt" TEXT/);

  assert.match(splitMigration, /NOT starts_with\("followUpPrompt", follow_base \|\| E'\\n'\)/);
  assert.match(splitMigration, /NOT starts_with\("analysisPrompt", analysis_base \|\| E'\\n'\)/);
  assert.match(splitMigration, /RAISE EXCEPTION 'Cannot split customized agent personality prompts automatically'/);
  assert.match(splitMigration, /follow_base \|\| E'\\n' \|\| "followUpStylePrompt" <> "followUpPrompt"/);
  assert.match(splitMigration, /analysis_base \|\| E'\\n' \|\| "analysisStylePrompt" <> "analysisPrompt"/);
  assert.match(splitMigration, /RAISE EXCEPTION 'Agent personality prompt split verification failed'/);

  assert.match(splitMigration, /DROP COLUMN "followUpPrompt"/);
  assert.match(splitMigration, /DROP COLUMN "analysisPrompt"/);
});

test("PostgreSQL integration runners keep the legacy and split migrations ordered", () => {
  const adminIntegration = readFileSync(join(projectRoot, "integration/admin-mvp.integration.js"), "utf8");
  const postgresRunner = readFileSync(join(projectRoot, "scripts/run-postgres-integration.js"), "utf8");
  const expectedTail = [
    "20260812120000_agent_personalities",
    "20260813120000_split_agent_prompt_rules",
  ];

  assert.deepEqual(migrationList(adminIntegration, "EXPECTED_MIGRATIONS").slice(-2), expectedTail);
  assert.deepEqual(migrationList(postgresRunner, "ALL_MIGRATIONS").slice(-2), expectedTail);
  assert.match(
    postgresRunner,
    /const LATEST_MIGRATION = "20260813120000_split_agent_prompt_rules";/,
  );
});
