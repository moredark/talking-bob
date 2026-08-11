const assert = require("node:assert/strict");
const test = require("node:test");

const { AdminController } = require("../dist/modules/admin/admin.controller");
const { AdminAnalyticsService } = require("../dist/modules/admin/admin-analytics.service");
const { AdminAnalyticsQueryPipe } = require("../dist/modules/admin/admin-validation.pipe");
const { getCalendarDayBuckets } = require("../dist/shared/time/timezone");

function routePipes(methodName) {
  const metadata = Reflect.getMetadata("__routeArguments__", AdminController, methodName) ?? {};
  return Object.values(metadata).flatMap((argument) => argument.pipes ?? []);
}

function rejects422(value) {
  assert.throws(() => new AdminAnalyticsQueryPipe().transform(value), (error) => error.getStatus() === 422);
}

test("analytics query is mandatory, scalar, allowlisted, and wired to GET /admin/analytics", () => {
  const pipe = new AdminAnalyticsQueryPipe();
  assert.equal(pipe.transform({ days: "7" }), 7);
  assert.equal(pipe.transform({ days: "30" }), 30);
  assert.equal(pipe.transform({ days: "90" }), 90);
  for (const query of [{}, { days: "14" }, { days: 7 }, { days: ["7", "30"] }, { days: "7", extra: "x" }]) rejects422(query);
  assert.ok(routePipes("getAnalytics").includes(AdminAnalyticsQueryPipe));
  assert.equal(Reflect.getMetadata("path", AdminController.prototype.getAnalytics), "analytics");
  assert.equal(Reflect.getMetadata("method", AdminController.prototype.getAnalytics), 0);
  const controller = new AdminController({ getAnalytics: (days) => ({ days }) });
  assert.deepEqual(controller.getAnalytics(30), { days: 30 });
});

test("Moscow buckets are oldest-first, exact, and use half-open UTC boundaries", () => {
  const buckets = getCalendarDayBuckets(7, "Europe/Moscow", new Date("2026-08-10T12:34:56.000Z"));
  assert.equal(buckets.length, 7);
  assert.equal(getCalendarDayBuckets(30, "Europe/Moscow", new Date("2026-08-10T12:34:56.000Z")).length, 30);
  assert.equal(getCalendarDayBuckets(90, "Europe/Moscow", new Date("2026-08-10T12:34:56.000Z")).length, 90);
  assert.deepEqual([buckets[0].localDate, buckets.at(-1).localDate], ["2026-08-04", "2026-08-10"]);
  assert.deepEqual([buckets[0].start.toISOString(), buckets[0].end.toISOString()], ["2026-08-03T21:00:00.000Z", "2026-08-04T21:00:00.000Z"]);
  assert.deepEqual([buckets.at(-1).start.toISOString(), buckets.at(-1).end.toISOString()], ["2026-08-09T21:00:00.000Z", "2026-08-10T21:00:00.000Z"]);
  assert.throws(() => getCalendarDayBuckets(0, "Europe/Moscow"), /days/);
});

test("analytics response fills zero days and shapes funnel, retention, scores, AI, and broadcasts", async () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const results = [
    [{ localDate: "2026-08-10", newUsers: 2n, activeUsers: 1n, promptsSent: 4n, responsesReceived: 3n }],
    [{ sent: 10n, message: 8n, closed: 7n, generated: 6n, delivered: 5n }],
    [{ localDate: "2026-08-08", cohortSize: 4n, retainedD1: 2n, retainedD7: 0n, retainedD30: 0n }, { localDate: "2026-08-10", cohortSize: 2n, retainedD1: 0n, retainedD7: 0n, retainedD30: 0n }],
    [{ generatedCount: 5n, scoredCount: 4n, invalidCount: 1n, fallbackCount: 2n, averageScore: "7.25" }],
    [{ topic: "Travel", reportCount: 7n, generatedCount: 5n, scoredCount: 4n, invalidCount: 1n, fallbackCount: 2n, averageScore: "7.25" }],
    [{ score: 7, count: 2n }, { score: 8, count: 2n }],
    [{ coverageFrom: new Date("2026-07-12T00:00:00.000Z"), analyticsCompleteFrom: new Date("2026-08-05T00:00:00.000Z"), total: 4n, succeeded: 2n, empty: 1n, failed: 1n, averageMs: "125.25", p50Ms: "100", p95Ms: "300", inputCalls: 3n, inputSum: 30n, outputCalls: 2n, outputSum: 12n, totalCalls: 2n, totalSum: 42n }],
    [{ localDate: "2026-08-10", calls: 4n, averageMs: "125.25", p95Ms: "300" }],
    [{ total: 3n, completed: 1n, completedWithErrors: 1n, cancelled: 1n, recipients: 10n, sent: 7n, failed: 1n, ambiguous: 1n, skipped: 1n }],
    [{ code: "telegram_403", count: 1n }, { code: "other", count: 1n }],
  ];
  const sql = [];
  const transactions = [];
  const prisma = {
    $queryRaw: async (query) => { sql.push(query.strings.join("?")); return results.shift(); },
    $transaction: async (queries, options) => { transactions.push(options); return Promise.all(queries); },
  };
  const response = await new AdminAnalyticsService(prisma).getAnalytics(7, now);

  assert.equal(response.version, 1);
  assert.equal(response.timezone, "Europe/Moscow");
  assert.deepEqual(response.coverage, {
    status: "partial",
    completeFrom: new Date("2026-08-05T00:00:00.000Z"),
    incompleteBefore: new Date("2026-08-05T00:00:00.000Z"),
  });
  assert.equal(response.daily.length, 7);
  assert.deepEqual(response.daily[0], { localDate: "2026-08-04", startAt: new Date("2026-08-03T21:00:00.000Z"), endAt: new Date("2026-08-04T21:00:00.000Z"), newUsers: 0, activeUsers: 0, promptsSent: 0, responsesReceived: 0 });
  assert.deepEqual([response.funnel.responseRatePct, response.funnel.stages.map((stage) => stage.count)], [80, [10, 8, 7, 6, 5]]);
  assert.equal(response.funnel.stages[1].dropOffFromPreviousPct, 20);
  assert.deepEqual(response.retention.cohorts.find((row) => row.localDate === "2026-08-08").d1, { retainedUsers: 2, ratePct: 50 });
  assert.equal(response.retention.cohorts.at(-1).d1, null);
  assert.deepEqual(response.retention.summary.d1, { eligibleUsers: 4, retainedUsers: 2, ratePct: 50 });
  assert.equal(response.retention.summary.d7, null);
  assert.equal(response.scores.distribution.length, 10);
  assert.deepEqual(response.scores.distribution[6], { score: 7, count: 2 });
  assert.deepEqual(response.ai.tokens.input, { callsWithUsage: 3, sum: 30, usageCoveragePct: 75 });
  assert.equal(response.ai.latency.daily[0].averageMs, null);
  assert.equal(response.broadcasts.recipients.deliveryRatePct, 70);
  assert.deepEqual(response.broadcasts.errorCodes, [{ code: "telegram_403", count: 1 }, { code: "other", count: 1 }]);
  assert.equal(sql.length, 10, "query count must stay constant regardless of days");
  assert.deepEqual(transactions, [{ isolationLevel: "RepeatableRead" }]);
  assert.ok(sql.every((query) => !query.includes("conversation_messages") && !query.includes("report_delivery_requests")));
  assert.ok(sql.every((query) => !query.includes("ur.analysis")));
  assert.ok(sql.some((query) => query.includes("LIMIT 50")));
  assert.ok(sql.some((query) => query.includes("admin_analytics_coverage")));
  assert.ok(sql.every((query) => !/SELECT[^;]*(responseContent|transcript|telegramIdSnapshot|usernameSnapshot)/i.test(query)));
});

test("zero denominators and immature retention return null, never misleading zero rates", async () => {
  const emptySummary = { coverageFrom: null, analyticsCompleteFrom: new Date("2026-07-01T00:00:00.000Z"), total: 0n, succeeded: 0n, empty: 0n, failed: 0n, averageMs: null, p50Ms: null, p95Ms: null, inputCalls: 0n, inputSum: null, outputCalls: 0n, outputSum: null, totalCalls: 0n, totalSum: null };
  const queue = [[], [{ sent: 0n, message: 0n, closed: 0n, generated: 0n, delivered: 0n }], [], [{ generatedCount: 0n, scoredCount: 0n, invalidCount: 0n, fallbackCount: 0n, averageScore: null }], [], [], [emptySummary], [], [{ total: 0n, completed: 0n, completedWithErrors: 0n, cancelled: 0n, recipients: 0n, sent: 0n, failed: 0n, ambiguous: 0n, skipped: 0n }], []];
  const response = await new AdminAnalyticsService({
    $queryRaw: async () => queue.shift(),
    $transaction: async (queries, options) => {
      assert.equal(options.isolationLevel, "RepeatableRead");
      return Promise.all(queries);
    },
  }).getAnalytics(7, new Date("2026-08-10T12:00:00.000Z"));
  assert.equal(response.funnel.responseRatePct, null);
  assert.equal(response.funnel.stages[0].rateFromSentPct, null);
  assert.equal(response.retention.summary.d1, null);
  assert.equal(response.ai.outcomes.successRatePct, null);
  assert.equal(response.ai.tokens.total.usageCoveragePct, null);
  assert.equal(response.broadcasts.recipients.deliveryRatePct, null);
});

test("analytics coverage explicitly distinguishes complete, partial, and unavailable periods", async () => {

  const now = new Date("2026-08-10T12:00:00.000Z");

  async function statusFor(completeFrom) {

    const emptyAi = { coverageFrom: null, analyticsCompleteFrom: completeFrom, total: 0n, succeeded: 0n, empty: 0n, failed: 0n, averageMs: null, p50Ms: null, p95Ms: null, inputCalls: 0n, inputSum: null, outputCalls: 0n, outputSum: null, totalCalls: 0n, totalSum: null };

    const queue = [[], [{ sent: 0n, message: 0n, closed: 0n, generated: 0n, delivered: 0n }], [], [{ generatedCount: 0n, scoredCount: 0n, invalidCount: 0n, fallbackCount: 0n, averageScore: null }], [], [], [emptyAi], [], [{ total: 0n, completed: 0n, completedWithErrors: 0n, cancelled: 0n, recipients: 0n, sent: 0n, failed: 0n, ambiguous: 0n, skipped: 0n }], []];

    return (await new AdminAnalyticsService({

      $queryRaw: async () => queue.shift(),

      $transaction: async (queries) => Promise.all(queries),

    }).getAnalytics(7, now)).coverage;

  }

  assert.deepEqual(await statusFor(new Date("2026-07-01T00:00:00.000Z")), { status: "complete", completeFrom: new Date("2026-07-01T00:00:00.000Z"), incompleteBefore: null });

  assert.deepEqual(await statusFor(new Date("2026-08-05T00:00:00.000Z")), { status: "partial", completeFrom: new Date("2026-08-05T00:00:00.000Z"), incompleteBefore: new Date("2026-08-05T00:00:00.000Z") });

  assert.deepEqual(await statusFor(new Date("2026-08-11T00:00:00.000Z")), { status: "unavailable", completeFrom: new Date("2026-08-11T00:00:00.000Z"), incompleteBefore: new Date("2026-08-11T00:00:00.000Z") });

});
