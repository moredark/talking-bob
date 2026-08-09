const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");

const runId = randomBytes(8).toString("hex");
const ownershipLabel = `talking-bob.runtime-image-check=${runId}`;
const runtimeTag = `talking-bob-runtime-check:${runId}`;
const initTag = `talking-bob-init-check:${runId}`;
const ownedTags = new Set();
const activeChildren = new Set();
let interruptedBy = null;
let shuttingDown = false;

const DOCKER_BUILD_TIMEOUT_MS = 10 * 60_000;
const DOCKER_RUN_TIMEOUT_MS = 60_000;
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000;
const CHILD_SHUTDOWN_GRACE_MS = 5_000;
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function run(command, args, options = {}) {
  const {
    capture = false,
    timeoutMs = DOCKER_RUN_TIMEOUT_MS,
    allowFailure = false,
  } = options;
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChildren.add(child);
    if (capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, CHILD_SHUTDOWN_GRACE_MS).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) {
        reject(new Error(`${command} ${args[0] || ""} timed out after ${timeoutMs}ms`));
      } else if (code === 0 || allowFailure) {
        resolve(result);
      } else {
        const detail = result.stderr.trim() || signal || `exit ${code}`;
        reject(new Error(`${command} ${args[0] || ""} failed: ${detail}`));
      }
    });
  });
}

async function docker(args, options) {
  return run("docker", args, options);
}

async function assertTagDoesNotExist(tag) {
  const result = await docker(["image", "inspect", tag], {
    capture: true,
    allowFailure: true,
  });
  if (result.code === 0) throw new Error(`refusing to overwrite pre-existing image tag ${tag}`);
}

async function buildTarget(target, tag) {
  await assertTagDoesNotExist(tag);
  ownedTags.add(tag);
  await docker([
    "build",
    "--target", target,
    "--label", ownershipLabel,
    "--tag", tag,
    ".",
  ], { timeoutMs: DOCKER_BUILD_TIMEOUT_MS });
}

async function runNode(tag, source, env = {}) {
  const args = ["run", "--rm"];
  for (const [name, value] of Object.entries(env)) args.push("--env", `${name}=${value}`);
  args.push("--entrypoint", "node", tag, "-e", source);
  const result = await docker(args, { capture: true });
  return result.stdout.trim();
}

async function runImageCommand(tag, entrypoint, args = []) {
  const result = await docker([
    "run", "--rm", "--entrypoint", entrypoint, tag, ...args,
  ], { capture: true });
  return result.stdout.trim();
}

const runtimeAssertions = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = "/usr/src/app";
assert.equal(typeof process.getuid, "function");
assert.notEqual(process.getuid(), 0, "runtime must not run as root");
for (const relative of ["src", "test", "testing", "prisma", "tsconfig.json"]) {
  assert.equal(fs.existsSync(path.join(root, relative)), false, relative + " leaked into runtime");
}
for (const moduleName of ["typescript", "ts-node", "prisma"]) {
  assert.throws(() => require.resolve(moduleName), undefined, moduleName + " must be absent");
}
assert.equal(fs.existsSync(path.join(root, "node_modules/.bin/prisma")), false, "Prisma CLI leaked");
require("@prisma/client");
require(".prisma/client");
require("bcrypt");
process.stdout.write("runtime-ok");
`;

const initAssertions = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = "/usr/src/app";
assert.equal(typeof process.getuid, "function");
assert.notEqual(process.getuid(), 0, "init must not run as root");
require("@prisma/client");
require(".prisma/client");
require("ts-node");
assert.equal(fs.existsSync(path.join(root, "node_modules/.bin/prisma")), true, "Prisma CLI missing");
assert.equal(fs.existsSync(path.join(root, "prisma/seed.ts")), true, "seed missing");
const migrations = fs.readdirSync(path.join(root, "prisma/migrations"));
assert.ok(migrations.some((entry) => /^\d+/.test(entry)), "migrations missing");
process.stdout.write("init-ok");
`;

const timezoneCalculation = String.raw`
const assert = require("node:assert/strict");
const { nextSlotStrictlyAfter, resolveWallClock } = require("./dist/shared/time/timezone");
const next = nextSlotStrictlyAfter(
  new Date("2026-10-24T22:30:00.000Z"),
  2,
  30,
  "Europe/Berlin",
);
const overlap = resolveWallClock({ year: 2026, month: 10, day: 25 }, 2, 30, "Europe/Berlin");
assert.equal(next.instant.toISOString(), "2026-10-25T00:30:00.000Z");
assert.equal(overlap.toISOString(), "2026-10-25T00:30:00.000Z");
process.stdout.write(JSON.stringify({
  next: next.instant.toISOString(),
  localDate: next.localDate,
  timeZone: next.timeZone,
  overlap: overlap.toISOString(),
}));
`;

async function inspectOwnedTag(tag) {
  const result = await docker([
    "image", "inspect", "--format",
    "{{index .Config.Labels \"talking-bob.runtime-image-check\"}}|{{json .RepoTags}}",
    tag,
  ], { capture: true, timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS, allowFailure: true });
  if (result.code !== 0) return false;
  const separator = result.stdout.indexOf("|");
  const actualRunId = result.stdout.slice(0, separator).trim();
  const repoTags = JSON.parse(result.stdout.slice(separator + 1).trim());
  if (actualRunId !== runId || !repoTags.includes(tag)) {
    throw new Error(`refusing to remove image tag not owned by this run: ${tag}`);
  }
  return true;
}

async function cleanup() {
  for (const tag of [...ownedTags].reverse()) {
    try {
      if (await inspectOwnedTag(tag)) {
        const removed = await docker(["image", "rm", tag], {
          capture: true,
          timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS,
          allowFailure: true,
        });
        if (removed.code !== 0) process.stderr.write(`Failed to remove ${tag}: ${removed.stderr}\n`);
      }
    } finally {
      ownedTags.delete(tag);
    }
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function shutdownForSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  interruptedBy = signal;
  const children = [...activeChildren];
  for (const child of children) child.kill(signal);
  await Promise.all(children.map((child) => waitForChildExit(child, CHILD_SHUTDOWN_GRACE_MS)));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  try {
    await cleanup();
  } catch (error) {
    process.stderr.write(`Runtime image cleanup failed: ${error.message}\n`);
  } finally {
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  }
}

async function main() {
  await docker(["info"], { capture: true });
  await buildTarget("runtime", runtimeTag);
  await buildTarget("init", initTag);
  if (await runNode(runtimeTag, runtimeAssertions) !== "runtime-ok") {
    throw new Error("runtime image assertions did not complete");
  }
  if (await runNode(initTag, initAssertions) !== "init-ok") {
    throw new Error("init image assertions did not complete");
  }
  const prismaVersion = await runImageCommand(
    initTag,
    "/usr/src/app/node_modules/.bin/prisma",
    ["--version"],
  );
  if (!/^prisma\s+:\s+6\.19\.2$/m.test(prismaVersion)) {
    throw new Error(`init Prisma CLI did not report the expected version: ${prismaVersion}`);
  }
  const utc = await runNode(runtimeTag, timezoneCalculation, { TZ: "UTC" });
  const tokyo = await runNode(runtimeTag, timezoneCalculation, { TZ: "Asia/Tokyo" });
  if (utc !== tokyo) {
    throw new Error(`timezone calculation depends on process TZ: ${utc} != ${tokyo}`);
  }
  process.stdout.write("Runtime and init image verification passed.\n");
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
  .finally(async () => {
    if (!shuttingDown) await cleanup();
  });
