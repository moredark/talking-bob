const assert = require("node:assert/strict");
const test = require("node:test");
const { BroadcastDispatcher } = require("../dist/modules/broadcast/broadcast-dispatcher.service");
const { broadcastAudienceWhere } = require("../dist/modules/broadcast/broadcast-audience");

const NOW = new Date("2026-09-13T10:00:00.000Z");
const IDS = { recipient: "22222222-2222-4222-8222-222222222222", broadcast: "11111111-1111-4111-8111-111111111111", user: "33333333-3333-4333-8333-333333333333" };
const base = { status: "active", bannedAt: null, announcementEnabled: true };
const claim = (extra = {}) => ({ id: IDS.recipient, broadcastId: IDS.broadcast, userId: IDS.user, telegramIdSnapshot: 123n, attemptCount: 0, claimToken: "token", content: "hello", filters: {}, messageAction: null, ...extra });

function subject({ user = { id: IDS.user }, sendError } = {}) {
  const finds = [], updates = [], sends = [];
  const prisma = {
    user: { findFirst: async (args) => { finds.push(args); return user; } },
    broadcastRecipient: { updateMany: async (args) => { updates.push(args); return { count: 1 }; } },
    broadcast: { updateMany: async () => ({ count: 1 }) },
    $transaction: async (fn) => fn({
      broadcastRecipient: { updateMany: async (args) => { updates.push(args); return { count: 1 }; } },
      broadcast: { updateMany: async () => ({ count: 1 }) },
    }),
  };
  const dispatcher = new BroadcastDispatcher(prisma, { capture: async () => undefined });
  const sender = { sendPlainText: async (...args) => { sends.push(args); if (sendError) throw sendError; } };
  return { dispatcher, finds, updates, sends, sender };
}

test("period filters are recomputed with fresh time and user id", async () => {
  const filters = { languageLevels: [], activity: "any", dailyPromptEnabled: "any", noVoiceForDays: 14, scheduledDeliveryWithinDays: 7 };
  const s = subject();
  await s.dispatcher.deliver(claim({ filters }), s.sender, new Date("2020-01-01T00:00:00Z"));
  const checked = s.finds[0].where;
  assert.equal(checked.id, IDS.user);
  assert.deepEqual({ status: checked.status, bannedAt: checked.bannedAt, announcementEnabled: checked.announcementEnabled }, base);
  assert.deepEqual(checked.OR, broadcastAudienceWhere(filters, new Date(checked.userPrompts.some.sentAt.lte.getTime())).OR);
  assert.deepEqual(checked.userPrompts.some.source, "scheduled");
  assert.deepEqual(checked.userPrompts.some.deliveryStatus, "sent");
  assert.ok(checked.userPrompts.some.sentAt.gte instanceof Date);
  assert.equal(s.sends.length, 1);
});

test("action-only legacy delivery performs only base consent recheck", async () => {
  const s = subject();
  await s.dispatcher.deliver(claim({ messageAction: "open_schedule", filters: { activity: "30d", dailyPromptEnabled: true } }), s.sender, NOW);
  assert.deepEqual(s.finds[0].where, { id: IDS.user, ...base });
  assert.deepEqual(s.sends[0][3], { messageAction: "open_schedule" });
});

test("ineligible recipient is skipped without external I/O", async () => {
  const s = subject({ user: null });
  await s.dispatcher.deliver(claim(), s.sender, NOW);
  assert.equal(s.sends.length, 0);
  assert.equal(s.updates.at(-1).data.status, "skipped");
});

test("corrupt new filters and action fail before eligibility lookup", async () => {
  for (const extra of [
    { filters: { noVoiceForDays: "14" } },
    { filters: { scheduledDeliveryWithinDays: 0 } },
    { messageAction: "invalid" },
  ]) {
    const s = subject();
    await s.dispatcher.deliver(claim(extra), s.sender, NOW);
    assert.equal(s.finds.length, 0);
    assert.equal(s.sends.length, 0);
    assert.equal(s.updates.at(-1).data.lastErrorCode, "invalid_broadcast_configuration");
  }
});

test("retry uses a fresh full predicate and skips a user who no longer matches", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const filters = { languageLevels: ["B1"], activity: "30d", dailyPromptEnabled: true, noVoiceForDays: 14, scheduledDeliveryWithinDays: 7 };
  const { GrammyError } = require("grammy");
  const s = subject({ sendError: new GrammyError("retry", { ok: false, error_code: 429, description: "retry", parameters: { retry_after: 1 } }, "sendMessage", {}) });
  const pending = claim({ filters, messageAction: "open_schedule" });
  await s.dispatcher.deliver(pending, s.sender, NOW);
  assert.deepEqual(s.finds[0].where, { ...broadcastAudienceWhere(filters, NOW), id: IDS.user });
  assert.deepEqual(s.sends[0][3], { messageAction: "open_schedule" });
  assert.equal(s.updates.at(-1).data.deliveryAttemptedAt, null);
  assert.ok(s.updates.at(-1).data.nextAttemptAt > NOW);
  const later = new Date(NOW.getTime() + 60000);
  t.mock.timers.setTime(later.getTime());
  s.dispatcher.prisma.user.findFirst = async (args) => { s.finds.push(args); return null; };
  await s.dispatcher.deliver({ ...pending, attemptCount: 1, claimToken: "retry-token" }, s.sender, later);
  assert.deepEqual(s.finds.at(-1).where, { ...broadcastAudienceWhere(filters, later), id: IDS.user });
  assert.equal(s.sends.length, 1);
  assert.equal(s.updates.at(-1).data.status, "skipped");
});
