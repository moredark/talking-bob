const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { PrismaClient } = require("@prisma/client");
const { AdminAnalyticsService } = require("../dist/modules/admin/admin-analytics.service");
const prisma = new PrismaClient();
let sequence = BigInt(Date.now()) * 100n;

test("reply format usage has distinct period users, Moscow boundaries and independent coverage", async () => {
  const original = await prisma.adminAnalyticsCoverage.findUniqueOrThrow({ where: { id: "durable_facts" } });
  const users = [];
  try {
    await prisma.adminAnalyticsCoverage.update({ where: { id: original.id }, data: { replyUsageCompleteFrom: new Date("2026-11-09T21:00:00Z") } });
    for (let i = 0; i < 3; i++) users.push(await prisma.user.create({ data: { telegramId: ++sequence, dailyPromptEnabled: false } }));
    const activity = (userId, localDate, at, messageCount, textMessageCount, voiceMessageCount) => ({ userId, localDate: new Date(localDate + "T00:00:00Z"), firstActivityAt: new Date(at), lastActivityAt: new Date(at), messageCount, textMessageCount, voiceMessageCount });
    await prisma.userActivityDay.createMany({ data: [
      activity(users[0].id, "2026-11-09", "2026-11-09T20:59:59.999Z", 100, 100, 0),
      activity(users[0].id, "2026-11-10", "2026-11-09T21:00:00Z", 2, 2, 0),
      activity(users[0].id, "2026-11-12", "2026-11-12T12:00:00Z", 1, 1, 0),
      activity(users[0].id, "2026-11-15", "2026-11-15T12:00:00Z", 1, 0, 1),
      activity(users[1].id, "2026-11-15", "2026-11-15T13:00:00Z", 2, 0, 2),
      activity(users[2].id, "2026-11-10", "2026-11-10T10:00:00Z", 5, 0, 0),
      activity(users[0].id, "2026-11-16", "2026-11-16T13:00:00Z", 10, 10, 0),
      activity(users[0].id, "2026-11-17", "2026-11-16T21:00:00Z", 20, 20, 0),
    ] });
    const service = new AdminAnalyticsService(prisma), now = new Date("2026-11-16T12:00:00Z");
    const week = (await service.getAnalytics(7, now)).replyUsage;
    assert.deepEqual(week.users, { total: 2, text: 1, voice: 2, mixed: 1, textSharePct: 50 });
    assert.deepEqual(week.replies, { total: 6, text: 3, voice: 3 });
    assert.equal(week.coverage.status, "complete"); assert.equal(week.daily.length, 7);
    for (const timezone of ["Pacific/Honolulu", "Asia/Tokyo"]) {
      const scoped = {
        $queryRaw: query => query,
        $transaction: (queries, options) => prisma.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timezone}'`);
          const results = [];
          for (const query of queries) results.push(await tx.$queryRaw(query));
          return results;
        }, options),
      };
      assert.deepEqual((await new AdminAnalyticsService(scoped).getAnalytics(7, now)).replyUsage, week, timezone);
    }

    assert.equal(week.daily[0].localDate, "2026-11-10"); assert.equal(week.daily[0].replies.text, 2);
    assert.equal(week.daily[1].users.total, 0); assert.equal(week.daily[1].users.textSharePct, null);
    assert.equal(week.daily[5].users.voice, 2); assert.equal(week.daily[5].users.mixed, 0);
    assert.equal(week.users.mixed, 1, "formats on different days must intersect in the period");
    assert.equal(week.daily.at(-1).replies.total, 0, "activity after observedThrough must be excluded");
    assert.equal((await service.getAnalytics(30, now)).replyUsage.coverage.status, "partial");
    assert.equal((await service.getAnalytics(90, now)).replyUsage.daily.length, 90);
    await assert.rejects(prisma.userActivityDay.update({ where: { userId_localDate: { userId: users[1].id, localDate: new Date("2026-11-15T00:00:00Z") } }, data: { textMessageCount: 1 } }), /user_activity_days_reply_counts_check/);
    await assert.rejects(prisma.userActivityDay.update({ where: { userId_localDate: { userId: users[1].id, localDate: new Date("2026-11-15T00:00:00Z") } }, data: { voiceMessageCount: -1 } }), /user_activity_days_reply_counts_check/);
    await prisma.adminAnalyticsCoverage.update({ where: { id: original.id }, data: { replyUsageCompleteFrom: new Date("2026-11-17T00:00:00Z") } });
    const unavailable = (await service.getAnalytics(7, now)).replyUsage;
    assert.equal(unavailable.coverage.status, "unavailable"); assert.equal(unavailable.users.total, 0); assert.equal(unavailable.users.textSharePct, null);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await prisma.adminAnalyticsCoverage.update({ where: { id: original.id }, data: { replyUsageCompleteFrom: original.replyUsageCompleteFrom } });
  }
});

test("usage migration leaves historical format unknown and records collection start", async () => {
  const sql = readFileSync("prisma/migrations/20261116130000_reply_usage_metrics/migration.sql", "utf8");
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('CREATE TEMP TABLE "user_activity_days" ("messageCount" INTEGER NOT NULL) ON COMMIT DROP');
    await tx.$executeRawUnsafe('CREATE TEMP TABLE "admin_analytics_coverage" (id TEXT) ON COMMIT DROP');
    await tx.$executeRawUnsafe('INSERT INTO "user_activity_days" VALUES (5)');
    await tx.$executeRawUnsafe("INSERT INTO \"admin_analytics_coverage\" VALUES ('durable_facts')");
    for (const statement of sql.split(";").map(value => value.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
    const [counts] = await tx.$queryRawUnsafe('SELECT * FROM "user_activity_days"');
    assert.deepEqual(counts, { messageCount: 5, textMessageCount: 0, voiceMessageCount: 0 });
    const [coverage] = await tx.$queryRawUnsafe('SELECT "replyUsageCompleteFrom" FROM "admin_analytics_coverage"');
    assert.ok(coverage.replyUsageCompleteFrom instanceof Date);
  });
});

test.after(() => prisma.$disconnect());
