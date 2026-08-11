const assert = require("node:assert/strict");
const test = require("node:test");
const { RequestMethod, UnprocessableEntityException } = require("@nestjs/common");
const { GrammyError } = require("grammy");
const { readFileSync } = require("node:fs");

const { AdminController } = require("../dist/modules/admin/admin.controller");
const {
  AdminBroadcastDetailQueryPipe,
  AdminBroadcastInputPipe,
  AdminBroadcastListQueryPipe,
} = require("../dist/modules/admin/admin-broadcast-validation.pipe");
const { AdminBroadcastsService } = require("../dist/modules/admin/admin-broadcasts.service");
const { BroadcastDispatcher } = require("../dist/modules/broadcast/broadcast-dispatcher.service");
const { broadcastAudienceWhere } = require("../dist/modules/broadcast/broadcast-audience");
const { broadcastSnapshotInsert } = require("../dist/modules/broadcast/broadcast-snapshot");
const { DataRetentionService } = require("../dist/modules/error-log/data-retention.service");
const { SettingsHandler } = require("../dist/modules/telegram/handlers/settings.handler");

const IDS = {
  broadcast: "11111111-1111-4111-8111-111111111111",
  recipient: "22222222-2222-4222-8222-222222222222",
  user: "33333333-3333-4333-8333-333333333333",
  actor: "44444444-4444-4444-8444-444444444444",
};
const NOW = new Date("2026-08-10T10:00:00.000Z");
const FILTERS = { languageLevels: [], activity: "any", dailyPromptEnabled: "any" };

function rejects422(callback) {
  assert.throws(callback, (error) =>
    error instanceof UnprocessableEntityException && error.getStatus() === 422);
}

function immediate(content = "Announcement") {
  return { content, filters: FILTERS, mode: "immediate" };
}

function broadcastRow(overrides = {}) {
  return {
    id: IDS.broadcast,
    content: "Announcement",
    contentPurgedAt: null,
    filters: FILTERS,
    mode: "immediate",
    scheduledForLocal: null,
    scheduledAt: NOW,
    status: "queued",
    totalRecipients: 0,
    sentCount: 0,
    failedCount: 0,
    ambiguousCount: 0,
    skippedCount: 0,
    createdById: IDS.actor,
    createdByUsername: "admin",
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
    ...overrides,
  };
}

function directAudit(tx) {
  return {
    runSuccess: async (_descriptor, callback) => (await callback(tx)).result,
  };
}

test("broadcast input enforces the Telegram UTF-16 boundary, including surrogate pairs", () => {
  const pipe = new AdminBroadcastInputPipe(() => NOW);
  const ascii4096 = "a".repeat(4096);
  const surrogate4096 = "\u{1f642}".repeat(2048);

  assert.equal(pipe.transform(immediate(ascii4096)).content.length, 4096);
  assert.equal(pipe.transform(immediate(surrogate4096)).content.length, 4096);
  rejects422(() => pipe.transform(immediate(`${ascii4096}a`)));
  rejects422(() => pipe.transform(immediate(`${surrogate4096}a`)));
  rejects422(() => pipe.transform(immediate("   ")));
  rejects422(() => pipe.transform({ ...immediate(), unknown: true }));
});

test("broadcast schedule and query validators are strict and normalize Moscow wall time", () => {
  const pipe = new AdminBroadcastInputPipe(() => NOW);
  const scheduled = pipe.transform({
    content: " Scheduled ", filters: FILTERS, mode: "scheduled", scheduledFor: "2026-08-10T14:00",
  });
  assert.equal(scheduled.content, "Scheduled");
  assert.equal(scheduled.scheduledAt.toISOString(), "2026-08-10T11:00:00.000Z");

  for (const body of [
    { ...immediate(), scheduledFor: "2026-08-10T14:00" },
    { content: "x", filters: FILTERS, mode: "scheduled", scheduledFor: "2026-08-10T13:00" },
    { content: "x", filters: FILTERS, mode: "scheduled", scheduledFor: "2026-02-30T14:00" },
    { content: "x", filters: FILTERS, mode: "scheduled", scheduledFor: "2026-08-10T14:00:00" },
    { ...immediate(), filters: { ...FILTERS, activity: "365d" } },
    { ...immediate(), filters: { ...FILTERS, languageLevels: ["B1", "B1"] } },
  ]) rejects422(() => pipe.transform(body));

  const list = new AdminBroadcastListQueryPipe();
  assert.deepEqual(list.transform({}), {
    page: 1, limit: 20, status: undefined, from: undefined, to: undefined,
  });
  for (const query of [
    { limit: "101" }, { status: "deleted" }, { extra: "x" }, { from: "2026-08-10" },
    { from: "2026-08-11T00:00:00Z", to: "2026-08-10T00:00:00Z" },
    { from: "2026-02-30T00:00:00Z" }, { from: "2026-04-31T00:00:00Z" },
    { from: "2026-01-01T24:00:00Z" },
  ]) rejects422(() => list.transform(query));

  const detail = new AdminBroadcastDetailQueryPipe();
  assert.deepEqual(detail.transform({}), {
    recipientPage: 1, recipientLimit: 50, recipientStatus: undefined,
  });
  for (const query of [{ recipientLimit: "101" }, { recipientStatus: "queued" }, { page: "2" }]) {
    rejects422(() => detail.transform(query));
  }
});

test("activity filters use durable lastUserMessageAt with preview and snapshot parity", () => {
  const neverWhere = broadcastAudienceWhere({ ...FILTERS, activity: "never" }, NOW);
  assert.equal(neverWhere.lastUserMessageAt, null);
  const activeWhere = broadcastAudienceWhere({ ...FILTERS, activity: "30d" }, NOW);
  assert.equal(activeWhere.lastUserMessageAt.gte.toISOString(), "2026-07-11T10:00:00.000Z");
  assert.equal(activeWhere.lastUserMessageAt.lt, NOW);

  const neverSql = broadcastSnapshotInsert(IDS.broadcast, { ...FILTERS, activity: "never" }, NOW);
  const neverText = neverSql.strings.join("?").replace(/\s+/g, " ");
  assert.match(neverText, /"lastUserMessageAt" IS NULL/);
  assert.doesNotMatch(neverText, /conversation_messages/);
  const activeSql = broadcastSnapshotInsert(IDS.broadcast, { ...FILTERS, activity: "30d" }, NOW);
  const activeText = activeSql.strings.join("?").replace(/\s+/g, " ");
  assert.match(activeText, /"lastUserMessageAt" >= \? AND app_user\."lastUserMessageAt" < \?/);
  assert.ok(activeSql.values.some((value) => value instanceof Date && value.toISOString() === "2026-07-11T10:00:00.000Z"));

  const migration = readFileSync("prisma/migrations/20260810150000_admin_broadcasts/migration.sql", "utf8");
  assert.match(migration, /ADD COLUMN "lastUserMessageAt" TIMESTAMPTZ\(3\)/);
  assert.match(migration, /MAX\(message\."createdAt"\).*"lastUserMessageAt"/s);
});

test("admin controller exposes exactly the five broadcast routes", () => {
  const routes = Object.getOwnPropertyNames(AdminController.prototype)
    .flatMap((name) => {
      const handler = AdminController.prototype[name];
      const path = Reflect.getMetadata("path", handler);
      const method = Reflect.getMetadata("method", handler);
      return typeof path === "string" && path.startsWith("broadcasts") ? [[method, path]] : [];
    })
    .sort((left, right) => left[1].localeCompare(right[1]) || left[0] - right[0]);

  assert.deepEqual(routes, [
    [RequestMethod.GET, "broadcasts"],
    [RequestMethod.POST, "broadcasts"],
    [RequestMethod.GET, "broadcasts/:id"],
    [RequestMethod.POST, "broadcasts/:id/cancel"],
    [RequestMethod.POST, "broadcasts/preview"],
  ].sort((left, right) => left[1].localeCompare(right[1]) || left[0] - right[0]));
});

test("create snapshots a large audience with one database INSERT SELECT and bounded detail read", async () => {
  const audienceCount = 250_123;
  let row = broadcastRow();
  const rawStatements = [];
  const recipientReads = [];
  const tx = {
    broadcast: {
      create: async () => row,
      update: async ({ data }) => { row = { ...row, ...data }; return row; },
      findUnique: async () => row,
    },
    broadcastRecipient: {
      createMany: async () => { throw new Error("createMany must not materialize the audience in application memory"); },
      findMany: async (args) => { recipientReads.push(args); return []; },
      count: async () => audienceCount,
    },
    $executeRaw: async (statement) => { rawStatements.push(statement); return audienceCount; },
  };
  const service = new AdminBroadcastsService(
    {}, directAudit(tx), { current: () => ({ actorId: IDS.actor, actorUsername: "admin" }), fallback: () => null },
  );

  const result = await service.create({
    content: "Announcement", filters: FILTERS, mode: "immediate", scheduledFor: null, scheduledAt: NOW,
  }, NOW);

  assert.equal(result.counts.total, audienceCount);
  assert.equal(rawStatements.length, 1);
  const sql = rawStatements[0].strings.join("?").replace(/\s+/g, " ");
  assert.match(sql, /INSERT INTO "broadcast_recipients"/);
  assert.match(sql, / SELECT .* FROM "users" app_user WHERE /);
  assert.doesNotMatch(sql, / LIMIT /i);
  assert.equal(recipientReads.length, 1);
  assert.equal(recipientReads[0].take, 50);
  assert.equal("user" in tx, false, "snapshotting must not call an unbounded user.findMany");
});

test("cancel loses a queued claim race as 409 and never performs a terminal overwrite", async () => {
  const calls = { recipients: 0, terminalUpdate: 0 };
  const tx = {
    broadcast: {
      findUnique: async () => broadcastRow({ totalRecipients: 9 }),
      updateMany: async () => ({ count: 0 }),
      update: async () => { calls.terminalUpdate += 1; throw new Error("must not overwrite winner"); },
    },
    broadcastRecipient: {
      updateMany: async () => { calls.recipients += 1; return { count: 0 }; },
    },
  };
  const service = new AdminBroadcastsService({}, directAudit(tx), {});

  await assert.rejects(
    () => service.cancel(IDS.broadcast),
    (error) => error.getStatus() === 409 && /queued/.test(error.message),
  );
  assert.deepEqual(calls, { recipients: 0, terminalUpdate: 0 });
});

function deliverySubject({ eligible = true, sendError } = {}) {
  const updates = [];
  const sends = [];
  const captures = [];
  const aggregates = [];
  const prisma = {
    user: { findFirst: async () => eligible ? { id: IDS.user } : null },
    broadcastRecipient: {
      updateMany: async (args) => { updates.push(args); return { count: 1 }; },
    },
    broadcast: { updateMany: async (args) => { aggregates.push(args); return { count: 1 }; } },
    $transaction: async (callback) => callback({
      broadcastRecipient: { updateMany: async (args) => { updates.push(args); return { count: 1 }; } },
      broadcast: { updateMany: async (args) => { aggregates.push(args); return { count: 1 }; } },
    }),
  };
  const dispatcher = new BroadcastDispatcher(prisma, {
    capture: async (args) => { captures.push(args); },
  });
  const sender = {
    sendPlainText: async (...args) => { sends.push(args); if (sendError) throw sendError; },
  };
  const claim = {
    id: IDS.recipient, broadcastId: IDS.broadcast, userId: IDS.user,
    telegramIdSnapshot: 123456789n, attemptCount: 0,
    claimToken: "claim-token", content: "Announcement",
  };
  return { dispatcher, sender, claim, updates, aggregates, sends, captures };
}

test("dispatcher rechecks opt-out before I/O and records successful delivery after I/O", async () => {
  const optedOut = deliverySubject({ eligible: false });
  await optedOut.dispatcher.deliver(optedOut.claim, optedOut.sender, NOW);
  assert.equal(optedOut.sends.length, 0);
  assert.equal(optedOut.updates.length, 1);
  assert.equal(optedOut.updates[0].data.status, "skipped");
  assert.equal(optedOut.updates[0].data.lastErrorCode, "recipient_ineligible");

  const success = deliverySubject();
  await success.dispatcher.deliver(success.claim, success.sender, NOW);
  assert.deepEqual(success.sends[0].slice(0, 2), [123456789n, "Announcement"]);
  assert.equal(success.sends[0][2] instanceof Object, true);
  assert.equal(success.updates.length, 2);
  assert.equal(success.updates[0].data.deliveryAttemptedAt, NOW);
  assert.equal(success.updates[1].data.status, "sent");
  assert.deepEqual(success.aggregates[0].data, { sentCount: { increment: 1 } });
});

test("dispatcher reads GrammyError.error retry_after, makes 4xx permanent, and keeps unknown outcomes ambiguous", async (t) => {
  await t.test("429 uses Telegram retry_after", async () => {
    const error = new GrammyError("rate limited", {
      ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 42 },
    }, "sendMessage", {});
    const subject = deliverySubject({ sendError: error });
    await subject.dispatcher.deliver(subject.claim, subject.sender, NOW);
    const retry = subject.updates[1].data;
    assert.equal(retry.lastErrorCode, "telegram_429");
    assert.equal(retry.deliveryAttemptedAt, null);
    assert.equal(retry.nextAttemptAt.getTime() - retry.lastErrorAt.getTime(), 42_000);
    assert.equal(subject.captures[0].retryable, true);
  });

  await t.test("definite 4xx is failed", async () => {
    const error = new GrammyError("forbidden", {
      ok: false, error_code: 403, description: "Forbidden",
    }, "sendMessage", {});
    const subject = deliverySubject({ sendError: error });
    await subject.dispatcher.deliver(subject.claim, subject.sender, NOW);
    assert.equal(subject.updates[1].data.status, "failed");
    assert.equal(subject.updates[1].data.lastErrorCode, "telegram_403");
    assert.equal(subject.captures[0].retryable, false);
  });

  await t.test("unknown transport outcome is ambiguous", async () => {
    const subject = deliverySubject({ sendError: new Error("socket outcome unknown") });
    await subject.dispatcher.deliver(subject.claim, subject.sender, NOW);
    assert.equal(subject.updates[1].data.status, "ambiguous");
    assert.equal(subject.updates[1].data.lastErrorCode, "telegram_outcome_unknown");
    assert.equal(subject.captures[0].retryable, false);
  });

  await t.test("runtime closure before HTTP safely requeues without consuming an attempt", async () => {
    const error = new Error("runtime closed");
    error.name = "TelegramRuntimeClosedError";
    const subject = deliverySubject({ sendError: error });
    await subject.dispatcher.deliver(subject.claim, subject.sender, NOW);
    assert.equal(subject.updates[1].data.status, undefined);
    assert.deepEqual(subject.updates[1].data.attemptCount, { decrement: 1 });
    assert.equal(subject.updates[1].data.deliveryAttemptedAt, null);
    assert.equal(subject.updates[1].data.claimToken, null);
    assert.equal(subject.aggregates.length, 0);
    assert.equal(subject.captures[0].retryable, true);
  });
});

test("expired leases distinguish pre-I/O retry from ambiguous post-I/O outcome", async () => {
  const updates = [];
  const aggregateUpdates = [];
  const recipient = { updateMany: async (args) => { updates.push(args); return { count: 1 }; } };
  const tx = {
    broadcastRecipient: recipient,
    broadcast: { updateMany: async (args) => { aggregateUpdates.push(args); return { count: 1 }; } },
  };
  const prisma = {
    $transaction: async (callback) => callback(tx),
    broadcastRecipient: {
      findMany: async () => [
        { id: "pre-io", broadcastId: IDS.broadcast, deliveryAttemptedAt: null },
        { id: "post-io", broadcastId: IDS.broadcast, deliveryAttemptedAt: NOW },
      ],
      updateMany: recipient.updateMany,
    },
  };
  const dispatcher = new BroadcastDispatcher(prisma, { capture: async () => undefined });

  const ids = await dispatcher.reconcileExpiredClaims(NOW);

  assert.deepEqual(ids, [IDS.broadcast, IDS.broadcast]);
  assert.deepEqual(updates[0].data, { claimToken: null, claimExpiresAt: null });
  assert.equal(updates[1].data.status, "ambiguous");
  assert.equal(updates[1].data.lastErrorCode, "lease_expired_after_io");
  assert.deepEqual(aggregateUpdates[0].data, { ambiguousCount: { increment: 1 } });
});

test("BroadcastDispatcher has no independent destroy hook; Telegram is the sole shutdown coordinator", () => {
  assert.equal(BroadcastDispatcher.prototype.onModuleDestroy, undefined);
  assert.equal(typeof BroadcastDispatcher.prototype.stopAdmission, "function");
  assert.equal(typeof BroadcastDispatcher.prototype.finishShutdown, "function");
});

test("shutdown fence aborts active I/O, fences its claim, and prevents late terminal mutation", async () => {
  const updates = [];
  let terminalTransactions = 0;
  const prisma = {
    user: { findFirst: async () => ({ id: IDS.user }) },
    broadcastRecipient: {
      updateMany: async (args) => { updates.push(args); return { count: 1 }; },
    },
    $transaction: async () => { terminalTransactions += 1; },
  };
  const dispatcher = new BroadcastDispatcher(prisma, { capture: async () => undefined });
  const claim = {
    id: IDS.recipient, broadcastId: IDS.broadcast, userId: IDS.user,
    telegramIdSnapshot: 1n, attemptCount: 0, claimToken: "original", content: "text",
  };
  dispatcher.ownedClaims.set(claim.id, claim.claimToken);
  const delivery = dispatcher.deliver(claim, {
    sendPlainText: async (_telegramId, _content, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  }, NOW);
  await new Promise((resolve) => setImmediate(resolve));
  dispatcher.stopAdmission(Date.now());
  await delivery;
  await dispatcher.finishShutdown(false);

  assert.equal(terminalTransactions, 0);
  assert.equal(updates.some((entry) => entry.data.status !== undefined), false);
  const fence = updates.find((entry) => typeof entry.data.claimToken === "string");
  assert.ok(fence);
  assert.deepEqual(fence.where, { id: IDS.recipient, status: "pending", claimToken: "original" });
  assert.notEqual(fence.data.claimToken, "original");
  assert.ok(fence.data.claimExpiresAt instanceof Date);
});

test("shutdown awaits replica-local exact claim fencing and leaves foreign claims untouched", async () => {
  let releaseFence;
  const gate = new Promise((resolve) => { releaseFence = resolve; });
  const rows = new Map([["local", "local-token"], ["foreign", "foreign-token"]]);
  const calls = [];
  const dispatcher = new BroadcastDispatcher({
    broadcastRecipient: {
      updateMany: async (args) => {
        calls.push(args);
        await gate;
        if (rows.get(args.where.id) === args.where.claimToken) rows.set(args.where.id, args.data.claimToken);
        return { count: 1 };
      },
    },
  }, { capture: async () => undefined });
  dispatcher.ownedClaims.set("local", "local-token");
  dispatcher.stopAdmission(Date.now() + 10_000);
  let settled = false;
  const finishing = dispatcher.finishShutdown(false).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(calls[0].where, { id: "local", status: "pending", claimToken: "local-token" });
  releaseFence();
  await finishing;
  assert.notEqual(rows.get("local"), "local-token");
  assert.equal(rows.get("foreign"), "foreign-token");
});

test("bounded workers wait for rejecting siblings before dispatcher inFlight settles", async () => {
  const dispatcher = new BroadcastDispatcher({}, { capture: async () => undefined });
  let releaseSibling;
  const sibling = new Promise((resolve) => { releaseSibling = resolve; });
  const events = [];
  let settled = false;
  const work = dispatcher.runBounded([0, 1], async (item) => {
    if (item === 0) throw new Error("first worker failed");
    await sibling;
    events.push("sibling finished");
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseSibling();
  await assert.rejects(work, /first worker failed/);
  assert.deepEqual(events, ["sibling finished"]);
});

test("announcement opt-out is independent from the daily prompt schedule", async () => {
  const consentUpdates = [];
  let scheduleCalls = 0;
  const current = {
    id: IDS.user,
    dailyPromptEnabled: true,
    announcementEnabled: true,
    dailyPromptHour: 13,
    dailyPromptMinute: 0,
    timezone: "Europe/Moscow",
    agentTone: "friendly",
  };
  const handler = new SettingsHandler(
    {
      findByTelegramId: async () => current,
      updateAnnouncementEnabled: async (id, enabled) => {
        consentUpdates.push({ id, enabled });
        return { ...current, announcementEnabled: enabled };
      },
    },
    {
      enableSchedule: async () => { scheduleCalls += 1; },
      disableSchedule: async () => { scheduleCalls += 1; },
    },
  );
  const edits = [];
  await handler.handleAnnouncementToggle({
    from: { id: 123456789 },
    editMessageText: async (...args) => { edits.push(args); },
    reply: async () => { throw new Error("edit should succeed"); },
  });

  assert.deepEqual(consentUpdates, [{ id: IDS.user, enabled: false }]);
  assert.equal(scheduleCalls, 0);
  assert.match(edits[0][0], /Рассылка: <b>включена<\/b>/);
  assert.match(edits[0][0], /Анонсы: <b>выключены<\/b>/);
  const keyboard = edits[0][1].reply_markup.inline_keyboard.flat();
  assert.ok(keyboard.some((button) => button.callback_data === "toggle_daily"));
  assert.ok(keyboard.some((button) => button.callback_data === "toggle_announcements"));
});

function retentionRow(id, status, terminalAt) {
  return { id, status, terminalAt, content: `content-${id}`, contentPurgedAt: null, recipients: [`recipient-${id}`] };
}

function broadcastRetentionSubject(inputRows) {
  const rows = inputRows.map((row) => ({ ...row, recipients: [...row.recipients] }));
  const operations = [];
  const transactionClients = [];
  let transactionId = 0;
  const prisma = {
    $transaction: async (callback) => {
      const txId = ++transactionId;
      const ids = (where) => new Set(where.id.in);
      const tx = {
        broadcast: {
          findMany: async (query) => {
            const selected = rows.filter((row) =>
              query.where.status.in.includes(row.status)
              && row.terminalAt < query.where.terminalAt.lt
              && (!query.where.OR || row.contentPurgedAt === null || row.recipients.length > 0))
              .sort((a, b) => a.terminalAt - b.terminalAt || a.id.localeCompare(b.id))
              .slice(0, query.take)
              .map(({ id }) => ({ id }));
            operations.push({ txId, type: "select", take: query.take, selected: selected.length, contentPhase: Boolean(query.where.OR) });
            return selected;
          },
          updateMany: async ({ where, data }) => {
            const selectedIds = ids(where);
            let count = 0;
            for (const row of rows) if (selectedIds.has(row.id)) { Object.assign(row, data); count += 1; }
            operations.push({ txId, type: "content-update", count });
            return { count };
          },
          deleteMany: async ({ where }) => {
            const selectedIds = ids(where);
            let count = 0;
            for (let index = rows.length - 1; index >= 0; index -= 1) {
              if (selectedIds.has(rows[index].id)) { rows.splice(index, 1); count += 1; }
            }
            operations.push({ txId, type: "aggregate-delete", count });
            return { count };
          },
        },
        broadcastRecipient: {
          deleteMany: async ({ where }) => {
            const selectedIds = new Set(where.broadcastId.in);
            let count = 0;
            for (const row of rows) if (selectedIds.has(row.id)) { count += row.recipients.length; row.recipients = []; }
            operations.push({ txId, type: "recipient-delete", count });
            return { count };
          },
        },
      };
      transactionClients.push(tx);
      return callback(tx);
    },
  };
  const service = new DataRetentionService(prisma, { retention: { closedConversationContentDays: 30, rateLimitDays: 30, errorLogsDays: 30 } });
  return { rows, operations, transactionClients, service };
}

test("broadcast retention uses strict age boundaries, terminal-only eligibility, and idempotent counters", async () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (days, extraMs = 0) => new Date(NOW.getTime() - days * day - extraMs);
  const subject = broadcastRetentionSubject([
    retentionRow("content-old", "completed", at(90, 1)),
    retentionRow("content-boundary", "completed_with_errors", at(90)),
    retentionRow("aggregate-old", "cancelled", at(365, 1)),
    retentionRow("aggregate-boundary", "completed", at(365)),
    retentionRow("active-old", "processing", at(400)),
  ]);

  assert.deepEqual(await subject.service.purgeBroadcastData(at(90), at(365), NOW), { recipients: 3, broadcasts: 1 });
  assert.equal(subject.rows.some(({ id }) => id === "aggregate-old"), false);
  const byId = (id) => subject.rows.find((row) => row.id === id);
  assert.equal(byId("content-old").content, null);
  assert.deepEqual(byId("content-old").recipients, []);
  assert.equal(byId("aggregate-boundary").content, null);
  assert.deepEqual(byId("aggregate-boundary").recipients, []);
  assert.equal(byId("content-boundary").content, "content-content-boundary");
  assert.equal(byId("content-boundary").recipients.length, 1);
  assert.equal(byId("active-old").content, "content-active-old");
  assert.equal(byId("active-old").recipients.length, 1);
  assert.deepEqual(await subject.service.purgeBroadcastData(at(90), at(365), NOW), { recipients: 0, broadcasts: 0 });
});

test("broadcast retention processes 501 rows in independent transactions bounded to 500", async () => {
  const day = 24 * 60 * 60 * 1000;
  const terminalAt = new Date(NOW.getTime() - 100 * day);
  const subject = broadcastRetentionSubject(Array.from({ length: 501 }, (_, index) => retentionRow(`batch-${String(index).padStart(3, "0")}`, "completed", terminalAt)));

  assert.deepEqual(await subject.service.purgeBroadcastData(new Date(NOW.getTime() - 90 * day), new Date(NOW.getTime() - 365 * day), NOW), { recipients: 501, broadcasts: 0 });
  const selects = subject.operations.filter(({ type }) => type === "select");
  assert.deepEqual(selects.map(({ selected }) => selected), [500, 1, 0, 0]);
  assert.equal(selects.every(({ take }) => take === 500), true);
  assert.equal(subject.transactionClients.length, 4);
  assert.equal(new Set(subject.transactionClients).size, 4);
  const writeTxIds = [...new Set(subject.operations.filter(({ type }) => type !== "select").map(({ txId }) => txId))];
  assert.deepEqual(writeTxIds, [selects[0].txId, selects[1].txId]);
});
