const assert = require("node:assert/strict");
const test = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { ScheduleService } = require("../dist/modules/schedule/schedule.service");
const { AdminUsersService } = require("../dist/modules/admin/admin-users.service");
const { nextWeeklySlotAtOrAfter } = require("../dist/shared/time");
const prisma = new PrismaClient();
let seq = BigInt(Date.now()) * 100n;
async function user(data = {}) {
  return prisma.user.create({ data: { telegramId: ++seq, timezone: "UTC", dailyPromptEnabled: false, nextPromptAt: null, ...data } });
}
const broadcastData = { content: "test", filters: {}, mode: "immediate", scheduledAt: new Date(), createdById: "integration", createdByUsername: "integration" };
test("migration applies daily defaults and enforces both new SQL constraints", async () => {
  const oldShape = await user();
  assert.equal(oldShape.promptWeekdaysMask, 127);
  for (const mask of [0, 128]) {
    await assert.rejects(prisma.user.update({ where: { id: oldShape.id }, data: { promptWeekdaysMask: mask } }), /users_prompt_weekdays_mask_check/);
  }
  for (const mask of [1, 127]) {
    assert.equal((await prisma.user.update({ where: { id: oldShape.id }, data: { promptWeekdaysMask: mask } })).promptWeekdaysMask, mask);
  }
  const row = await prisma.broadcast.create({ data: broadcastData });
  assert.equal(row.messageAction, null);
  assert.equal((await prisma.broadcast.update({ where: { id: row.id }, data: { messageAction: "open_schedule" } })).messageAction, "open_schedule");
  await assert.rejects(prisma.broadcast.update({ where: { id: row.id }, data: { messageAction: "unknown" } }), /broadcasts_message_action_check/);
});
test("empty catalogue advances, competing workers share one identity, persisted claims survive schedule edits", async () => {
  const now = new Date("2026-09-14T13:00:00Z");
  const active = await prisma.prompt.findMany({ where: { isActive: true }, select: { id: true } });
  await prisma.prompt.updateMany({ where: { id: { in: active.map(row => row.id) } }, data: { isActive: false } });
  const schedule = new ScheduleService(prisma);
  try {
    const first = await user({ dailyPromptEnabled: true, promptWeekdaysMask: 21, dailyPromptHour: 13, nextPromptAt: now });
    assert.deepEqual(await schedule.claimScheduledBatch(100, now), []);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: first.id } })).nextPromptAt.toISOString(), "2026-09-16T13:00:00.000Z");
    const prompt = await prisma.prompt.create({ data: { topic: "weekly", textContent: "Question", isActive: true } });
    const second = await user({ dailyPromptEnabled: true, promptWeekdaysMask: 21, dailyPromptHour: 13, nextPromptAt: now });
    const [a, b] = await Promise.all([schedule.claimScheduledBatch(100, now), schedule.claimScheduledBatch(100, now)]);
    assert.equal([...a, ...b].filter(claim => claim.user.id === second.id).length, 1);
    const reserved = await prisma.userPrompt.findFirstOrThrow({ where: { userId: second.id } });
    assert.equal(reserved.scheduledOccurrenceKey, "scheduled:" + second.id + ":2026-09-14");
    await schedule.updateScheduleSettings(second.id, { dailyPromptHour: 13 }, now);
    assert.deepEqual(await schedule.claimScheduledBatch(100, now), []);
    assert.equal(await prisma.userPrompt.count({ where: { userId: second.id } }), 1);
    await schedule.disableSchedule(second.id);
    const reclaimed = await schedule.claimScheduledBatch(100, new Date("2026-09-15T13:00:00Z"));
    assert.equal(reclaimed.filter(claim => claim.user.id === second.id).length, 1);
    const same = await prisma.userPrompt.findUniqueOrThrow({ where: { id: reserved.id } });
    for (const key of ["scheduledFor", "scheduledLocalDate", "timezoneSnapshot", "scheduledOccurrenceKey"]) assert.deepEqual(same[key], reserved[key]);
    await prisma.prompt.update({ where: { id: prompt.id }, data: { isActive: false } });
  } finally {
    await prisma.prompt.updateMany({ where: { id: { in: active.map(row => row.id) } }, data: { isActive: true } });
  }
});
test("admin on/off preserves sparse days and atomically recalculates the cursor", async () => {
  const row = await user({ promptWeekdaysMask: 21, dailyPromptHour: 8, dailyPromptMinute: 45 });
  const audit = { runSuccess: (_, callback) => prisma.$transaction(async tx => (await callback(tx)).result) };
  const admin = new AdminUsersService(prisma, audit);
  const before = new Date();
  await admin.updateUser(row.id, { dailyPromptEnabled: true });
  const enabled = await prisma.user.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(enabled.promptWeekdaysMask, 21);
  assert.equal(enabled.nextPromptAt.toISOString(), nextWeeklySlotAtOrAfter(before, 8, 45, "UTC", 21).instant.toISOString());
  await admin.updateUser(row.id, { dailyPromptEnabled: false });
  const disabled = await prisma.user.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(disabled.promptWeekdaysMask, 21);
  assert.equal(disabled.nextPromptAt, null);
});
test("rollback gates include each independent option and sparse disabled users", async () => {
  const ids = [];
  for (const status of ["queued", "processing", "completed"]) {
    for (const filters of [{}, { noVoiceForDays: 14 }, { scheduledDeliveryWithinDays: 7 }, { noVoiceForDays: 30, scheduledDeliveryWithinDays: 7 }]) {
      for (const action of [null, "open_schedule"]) {
        const row = await prisma.broadcast.create({ data: { ...broadcastData, filters, messageAction: action, status, terminalAt: status === "completed" ? new Date() : null } });
        ids.push({ id: row.id, expected: status !== "completed" && (action !== null || Object.keys(filters).length > 0) });
      }
    }
  }
  const hits = await prisma.$queryRaw`SELECT "id" FROM "broadcasts" WHERE "status" IN ('queued', 'processing') AND ("messageAction" IS NOT NULL OR "filters"->>'noVoiceForDays' IS NOT NULL OR "filters"->>'scheduledDeliveryWithinDays' IS NOT NULL)`;
  const matched = new Set(hits.map(row => row.id));
  for (const item of ids) assert.equal(matched.has(item.id), item.expected);
  const off = await user({ promptWeekdaysMask: 1 });
  const on = await user({ promptWeekdaysMask: 1, dailyPromptEnabled: true });
  const sparse = await prisma.$queryRaw`SELECT "id" FROM "users" WHERE "promptWeekdaysMask" <> 127`;
  assert.ok(sparse.some(row => row.id === off.id));
  assert.ok(sparse.some(row => row.id === on.id));
});
test.after(async () => prisma.$disconnect());

test("text activity and voice absence compose identically in preview and persisted snapshot", async () => {
  const { broadcastAudienceWhere } = require("../dist/modules/broadcast/broadcast-audience");
  const { broadcastSnapshotInsert } = require("../dist/modules/broadcast/broadcast-snapshot");
  const now = new Date("2026-11-16T12:00:00Z"), cutoff = new Date("2026-11-02T12:00:00Z");
  const filters = { languageLevels: ["C2"], activity: "7d", dailyPromptEnabled: "any", noVoiceForDays: 14 };
  const recent = new Date("2026-11-15T12:00:00Z");
  const textOnly = await user({ languageLevel: "C2", lastUserMessageAt: recent });
  const olderVoice = await user({ languageLevel: "C2", lastUserMessageAt: recent, lastVoiceMessageAt: new Date(cutoff.getTime() - 1) });
  await user({ languageLevel: "C2", lastUserMessageAt: recent, lastVoiceMessageAt: cutoff });
  await user({ languageLevel: "C2", lastUserMessageAt: recent, lastVoiceMessageAt: recent });
  const expected = [textOnly.id, olderVoice.id].sort();
  const preview = await prisma.user.findMany({ where: broadcastAudienceWhere(filters, now) });
  assert.deepEqual(preview.map(u => u.id).sort(), expected);
  const broadcast = await prisma.broadcast.create({ data: { ...broadcastData, filters } });
  await prisma.$executeRaw(broadcastSnapshotInsert(broadcast.id, filters, now));
  const recipients = await prisma.broadcastRecipient.findMany({ where: { broadcastId: broadcast.id } });
  assert.deepEqual(recipients.map(r => r.userId).sort(), expected);
  await prisma.user.update({ where: { id: textOnly.id }, data: { lastUserMessageAt: now } });
  assert.ok(await prisma.user.findFirst({ where: { ...broadcastAudienceWhere(filters, new Date(now.getTime() + 1)), id: textOnly.id } }));
  await prisma.user.update({ where: { id: textOnly.id }, data: { lastVoiceMessageAt: now } });
  assert.equal(await prisma.user.findFirst({ where: { ...broadcastAudienceWhere(filters, new Date(now.getTime() + 1)), id: textOnly.id } }), null);
  assert.equal(await prisma.broadcastRecipient.count({ where: { broadcastId: broadcast.id } }), 2);
});
