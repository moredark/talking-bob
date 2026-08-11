import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { getCalendarDayBuckets } from "../../shared/time/timezone";
import { AdminAnalytics, AnalyticsDays, RetentionPoint, RetentionSummary, TokenUsage } from "./admin.contracts";

const ANALYTICS_TIMEZONE = "Europe/Moscow" as const;
const RETENTION_DAYS = [1, 7, 30] as const;

type CountValue = bigint | number | string | null;
type DailyRow = { localDate: string; newUsers: CountValue; activeUsers: CountValue; promptsSent: CountValue; responsesReceived: CountValue };
type FunnelRow = { sent: CountValue; message: CountValue; closed: CountValue; generated: CountValue; delivered: CountValue };
type RetentionRow = { localDate: string; cohortSize: CountValue; retainedD1: CountValue; retainedD7: CountValue; retainedD30: CountValue };
type ScoreSummaryRow = { generatedCount: CountValue; scoredCount: CountValue; invalidCount: CountValue; fallbackCount: CountValue; averageScore: number | string | null };
type TopicRow = ScoreSummaryRow & { topic: string; reportCount: CountValue };
type DistributionRow = { score: number; count: CountValue };
type AiSummaryRow = {
  coverageFrom: Date | null; analyticsCompleteFrom: Date | null; total: CountValue; succeeded: CountValue; empty: CountValue; failed: CountValue;
  averageMs: number | string | null; p50Ms: number | string | null; p95Ms: number | string | null;
  inputCalls: CountValue; inputSum: CountValue; outputCalls: CountValue; outputSum: CountValue; totalCalls: CountValue; totalSum: CountValue;
};
type AiDailyRow = { localDate: string; calls: CountValue; averageMs: number | string | null; p95Ms: number | string | null };
type BroadcastRow = { total: CountValue; completed: CountValue; completedWithErrors: CountValue; cancelled: CountValue; recipients: CountValue; sent: CountValue; failed: CountValue; ambiguous: CountValue; skipped: CountValue };
type ErrorCodeRow = { code: string; count: CountValue };

@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAnalytics(days: AnalyticsDays, generatedAt: Date = new Date()): Promise<AdminAnalytics> {
    const buckets = getCalendarDayBuckets(days, ANALYTICS_TIMEZONE, generatedAt);
    const startAt = buckets[0].start;
    const endAt = buckets[buckets.length - 1].end;

    const [dailyRows, funnelRows, retentionRows, scoreRows, topicRows, distributionRows, aiRows, aiDailyRows, broadcastRows, errorCodeRows] = await this.prisma.$transaction([
      this.daily(startAt, generatedAt),
      this.funnel(startAt, generatedAt),
      this.retention(startAt, generatedAt),
      this.scoreSummary(startAt, generatedAt),
      this.scoreTopics(startAt, generatedAt),
      this.scoreDistribution(startAt, generatedAt),
      this.aiSummary(startAt, generatedAt),
      this.aiDaily(startAt, generatedAt),
      this.broadcastSummary(startAt, generatedAt),
      this.broadcastErrors(startAt, generatedAt),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    const dailyByDate = new Map(dailyRows.map((row) => [row.localDate, row]));
    const aiByDate = new Map(aiDailyRows.map((row) => [row.localDate, row]));
    const funnel = funnelRows[0] ?? { sent: 0, message: 0, closed: 0, generated: 0, delivered: 0 };
    const funnelCounts = [funnel.sent, funnel.message, funnel.closed, funnel.generated, funnel.delivered].map(safeCount);
    const funnelKeys = ["sent", "message", "closed", "generated", "delivered"] as const;
    const score = scoreRows[0] ?? { generatedCount: 0, scoredCount: 0, invalidCount: 0, fallbackCount: 0, averageScore: null };
    const ai = aiRows[0] ?? emptyAiRow();
    if (!ai.analyticsCompleteFrom) throw new Error("Analytics coverage marker is missing");
    const coverage = analyticsCoverage(startAt, generatedAt, ai.analyticsCompleteFrom);
    const broadcasts = broadcastRows[0] ?? { total: 0, completed: 0, completedWithErrors: 0, cancelled: 0, recipients: 0, sent: 0, failed: 0, ambiguous: 0, skipped: 0 };
    const aiTotal = safeCount(ai.total);
    const recipientTotal = safeCount(broadcasts.recipients);
    const sentRecipients = safeCount(broadcasts.sent);

    return {
      version: 1,
      generatedAt,
      timezone: ANALYTICS_TIMEZONE,
      days,
      period: { startAt, endAt, observedThrough: generatedAt },
      coverage,
      daily: buckets.map((bucket) => {
        const row = dailyByDate.get(bucket.localDate);
        return {
          localDate: bucket.localDate, startAt: bucket.start, endAt: bucket.end,
          newUsers: safeCount(row?.newUsers), activeUsers: safeCount(row?.activeUsers),
          promptsSent: safeCount(row?.promptsSent), responsesReceived: safeCount(row?.responsesReceived),
        };
      }),
      funnel: {
        population: "sent_prompts",
        responseRatePct: percentage(funnelCounts[1], funnelCounts[0]),
        stages: funnelKeys.map((key, index) => ({
          key, count: funnelCounts[index], rateFromSentPct: percentage(funnelCounts[index], funnelCounts[0]),
          dropOffFromPreviousCount: index === 0 ? null : funnelCounts[index - 1] - funnelCounts[index],
          dropOffFromPreviousPct: index === 0 ? null : percentage(funnelCounts[index - 1] - funnelCounts[index], funnelCounts[index - 1]),
        })),
      },
      retention: buildRetention(buckets.map((bucket) => bucket.localDate), retentionRows, buckets[buckets.length - 1].localDate),
      scores: {
        generatedModelLegacyCount: safeCount(score.generatedCount), scoredCount: safeCount(score.scoredCount),
        invalidScoreCount: safeCount(score.invalidCount), fallbackCount: safeCount(score.fallbackCount), averageScore: nullableNumber(score.averageScore),
        distribution: Array.from({ length: 10 }, (_value, index) => ({ score: (index + 1) as 1|2|3|4|5|6|7|8|9|10, count: safeCount(distributionRows.find((row) => row.score === index + 1)?.count) })),
        topics: topicRows.map((row) => ({
          topic: row.topic, reportCount: safeCount(row.reportCount), scoredCount: safeCount(row.scoredCount),
          invalidScoreCount: safeCount(row.invalidCount), fallbackCount: safeCount(row.fallbackCount), averageScore: nullableNumber(row.averageScore),
        })),
      },
      ai: {
        coverageFrom: ai.coverageFrom,
        outcomes: { total: aiTotal, succeeded: safeCount(ai.succeeded), empty: safeCount(ai.empty), failed: safeCount(ai.failed), successRatePct: percentage(safeCount(ai.succeeded), aiTotal) },
        latency: {
          averageMs: nullableNumber(ai.averageMs), p50Ms: nullableNumber(ai.p50Ms), p95Ms: nullableNumber(ai.p95Ms),
          daily: buckets.map((bucket) => {
            const row = aiByDate.get(bucket.localDate);
            return { localDate: bucket.localDate, calls: safeCount(row?.calls), averageMs: nullableNumber(row?.averageMs), p95Ms: nullableNumber(row?.p95Ms) };
          }),
        },
        tokens: {
          input: tokenUsage(ai.inputCalls, ai.inputSum, aiTotal),
          output: tokenUsage(ai.outputCalls, ai.outputSum, aiTotal),
          total: tokenUsage(ai.totalCalls, ai.totalSum, aiTotal),
        },
      },
      broadcasts: {
        terminal: { total: safeCount(broadcasts.total), completed: safeCount(broadcasts.completed), completedWithErrors: safeCount(broadcasts.completedWithErrors), cancelled: safeCount(broadcasts.cancelled) },
        recipients: { total: recipientTotal, sent: sentRecipients, failed: safeCount(broadcasts.failed), ambiguous: safeCount(broadcasts.ambiguous), skipped: safeCount(broadcasts.skipped), deliveryRatePct: percentage(sentRecipients, recipientTotal) },
        errorCodes: errorCodeRows.map((row) => ({ code: row.code, count: safeCount(row.count) })),
      },
    };
  }

  private daily(startAt: Date, observedThrough: Date) {
    return this.prisma.$queryRaw<DailyRow[]>(Prisma.sql`
      WITH events AS (
        SELECT (u."createdAt" AT TIME ZONE 'Europe/Moscow')::date AS day, 'new'::text AS kind, u.id AS user_id
        FROM users u WHERE u."createdAt" >= ${startAt} AND u."createdAt" < ${observedThrough}
        UNION ALL
        SELECT activity."localDate", 'active', activity."userId"
        FROM user_activity_days activity
        WHERE activity."localDate" >= (${startAt} AT TIME ZONE 'Europe/Moscow')::date
          AND activity."localDate" <= (${observedThrough} AT TIME ZONE 'Europe/Moscow')::date
          AND activity."firstActivityAt" < ${observedThrough}
        UNION ALL
        SELECT (up."sentAt" AT TIME ZONE 'Europe/Moscow')::date, 'sent', up.id
        FROM user_prompts up WHERE up."sentAt" >= ${startAt} AND up."sentAt" < ${observedThrough}
        UNION ALL
        SELECT (ur."createdAt" AT TIME ZONE 'Europe/Moscow')::date, 'response', ur.id
        FROM user_responses ur WHERE ur."createdAt" >= ${startAt} AND ur."createdAt" < ${observedThrough}
      )
      SELECT day::text AS "localDate",
        COUNT(*) FILTER (WHERE kind = 'new') AS "newUsers",
        COUNT(DISTINCT user_id) FILTER (WHERE kind = 'active') AS "activeUsers",
        COUNT(*) FILTER (WHERE kind = 'sent') AS "promptsSent",
        COUNT(*) FILTER (WHERE kind = 'response') AS "responsesReceived"
      FROM events GROUP BY day ORDER BY day
    `);
  }

  private funnel(startAt: Date, observedThrough: Date) {
    return this.prisma.$queryRaw<FunnelRow[]>(Prisma.sql`
      WITH population AS (
        SELECT up.id,
          up."firstUserMessageAt" >= up."sentAt" AND up."firstUserMessageAt" < ${observedThrough} AS has_message,
          up."conversationStatus" = 'closed' AND up."conversationClosedAt" >= up."sentAt" AND up."conversationClosedAt" < ${observedThrough} AS has_closed,
          ur."generationStatus" = 'generated' AND ur."generatedAt" >= up."sentAt" AND ur."generatedAt" < ${observedThrough} AS has_generated,
          ur."reportDeliveredAt" >= up."sentAt" AND ur."reportDeliveredAt" < ${observedThrough} AS has_delivered
        FROM user_prompts up
        LEFT JOIN user_responses ur ON ur."userPromptId" = up.id
        WHERE up."sentAt" >= ${startAt} AND up."sentAt" < ${observedThrough}
      ), conjunctive AS (
        SELECT *, has_message AND has_closed AS c_closed,
          has_message AND has_closed AND has_generated AS c_generated,
          has_message AND has_closed AND has_generated AND has_delivered AS c_delivered FROM population
      )
      SELECT COUNT(*) AS sent, COUNT(*) FILTER (WHERE has_message) AS message,
        COUNT(*) FILTER (WHERE c_closed) AS closed, COUNT(*) FILTER (WHERE c_generated) AS generated,
        COUNT(*) FILTER (WHERE c_delivered) AS delivered FROM conjunctive
    `);
  }

  private retention(startAt: Date, observedThrough: Date) {
    return this.prisma.$queryRaw<RetentionRow[]>(Prisma.sql`
      WITH cohorts AS (
        SELECT u.id, (u."createdAt" AT TIME ZONE 'Europe/Moscow')::date AS cohort_day
        FROM users u WHERE u."createdAt" >= ${startAt} AND u."createdAt" < ${observedThrough}
      ), retained AS (
        SELECT c.id, c.cohort_day,
          EXISTS (SELECT 1 FROM user_activity_days activity WHERE activity."userId" = c.id AND activity."localDate" = c.cohort_day + 1 AND activity."firstActivityAt" < ${observedThrough}) AS d1,
          EXISTS (SELECT 1 FROM user_activity_days activity WHERE activity."userId" = c.id AND activity."localDate" = c.cohort_day + 7 AND activity."firstActivityAt" < ${observedThrough}) AS d7,
          EXISTS (SELECT 1 FROM user_activity_days activity WHERE activity."userId" = c.id AND activity."localDate" = c.cohort_day + 30 AND activity."firstActivityAt" < ${observedThrough}) AS d30
        FROM cohorts c
      )
      SELECT cohort_day::text AS "localDate", COUNT(*) AS "cohortSize",
        COUNT(*) FILTER (WHERE d1) AS "retainedD1", COUNT(*) FILTER (WHERE d7) AS "retainedD7", COUNT(*) FILTER (WHERE d30) AS "retainedD30"
      FROM retained GROUP BY cohort_day ORDER BY cohort_day
    `);
  }

  private scoreBase(startAt: Date, observedThrough: Date) {
    return Prisma.sql`
      WITH reports AS (
        SELECT p.topic, ur."analysisKind"::text AS kind, ur."overallScore" AS score
        FROM user_responses ur JOIN user_prompts up ON up.id = ur."userPromptId" JOIN prompts p ON p.id = up."promptId"
        WHERE ur."generationStatus" = 'generated' AND ur."generatedAt" >= ${startAt} AND ur."generatedAt" < ${observedThrough}
      )`;
  }

  private scoreSummary(startAt: Date, observedThrough: Date) {
    const base = this.scoreBase(startAt, observedThrough);
    return this.prisma.$queryRaw<ScoreSummaryRow[]>(Prisma.sql`${base}
      SELECT COUNT(*) FILTER (WHERE kind IN ('model','legacy')) AS "generatedCount",
        COUNT(*) FILTER (WHERE kind IN ('model','legacy') AND score BETWEEN 1 AND 10) AS "scoredCount",
        COUNT(*) FILTER (WHERE kind IN ('model','legacy') AND (score IS NULL OR NOT (score BETWEEN 1 AND 10))) AS "invalidCount",
        COUNT(*) FILTER (WHERE kind = 'fallback') AS "fallbackCount",
        ROUND((AVG(score) FILTER (WHERE kind IN ('model','legacy') AND score BETWEEN 1 AND 10))::numeric, 2) AS "averageScore" FROM reports
    `);
  }

  private scoreTopics(startAt: Date, observedThrough: Date) {
    const base = this.scoreBase(startAt, observedThrough);
    return this.prisma.$queryRaw<TopicRow[]>(Prisma.sql`${base}
      SELECT topic, COUNT(*) AS "reportCount",
        COUNT(*) FILTER (WHERE kind IN ('model','legacy')) AS "generatedCount",
        COUNT(*) FILTER (WHERE kind IN ('model','legacy') AND score BETWEEN 1 AND 10) AS "scoredCount",
        COUNT(*) FILTER (WHERE kind IN ('model','legacy') AND (score IS NULL OR NOT (score BETWEEN 1 AND 10))) AS "invalidCount",
        COUNT(*) FILTER (WHERE kind = 'fallback') AS "fallbackCount",
        ROUND((AVG(score) FILTER (WHERE kind IN ('model','legacy') AND score BETWEEN 1 AND 10))::numeric, 2) AS "averageScore"
      FROM reports GROUP BY topic ORDER BY COUNT(*) DESC, topic ASC LIMIT 50
    `);
  }

  private scoreDistribution(startAt: Date, observedThrough: Date) {
    const base = this.scoreBase(startAt, observedThrough);
    return this.prisma.$queryRaw<DistributionRow[]>(Prisma.sql`${base}
      SELECT ROUND(score)::int AS score, COUNT(*) AS count FROM reports
      WHERE kind IN ('model','legacy') AND score BETWEEN 1 AND 10 GROUP BY ROUND(score) ORDER BY score
    `);
  }

  private aiSummary(startAt: Date, observedThrough: Date) {
    return this.prisma.$queryRaw<AiSummaryRow[]>(Prisma.sql`
      SELECT (SELECT MIN("createdAt") FROM ai_provider_calls) AS "coverageFrom",
        (SELECT "completeFrom" FROM admin_analytics_coverage WHERE id = 'durable_facts') AS "analyticsCompleteFrom",
        COUNT(*) AS total, COUNT(*) FILTER (WHERE outcome = 'succeeded') AS succeeded,
        COUNT(*) FILTER (WHERE outcome = 'empty') AS empty, COUNT(*) FILTER (WHERE outcome = 'failed') AS failed,
        ROUND(AVG("latencyMs"), 2) AS "averageMs",
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs")::numeric, 2) AS "p50Ms",
        ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::numeric, 2) AS "p95Ms",
        COUNT("inputTokens") AS "inputCalls", SUM("inputTokens") AS "inputSum",
        COUNT("outputTokens") AS "outputCalls", SUM("outputTokens") AS "outputSum",
        COUNT("totalTokens") AS "totalCalls", SUM("totalTokens") AS "totalSum"
      FROM ai_provider_calls WHERE "createdAt" >= ${startAt} AND "createdAt" < ${observedThrough}
    `);
  }

  private aiDaily(startAt: Date, observedThrough: Date) {
    return this.prisma.$queryRaw<AiDailyRow[]>(Prisma.sql`
      SELECT ("createdAt" AT TIME ZONE 'Europe/Moscow')::date::text AS "localDate", COUNT(*) AS calls,
        ROUND(AVG("latencyMs"), 2) AS "averageMs",
        ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::numeric, 2) AS "p95Ms"
      FROM ai_provider_calls WHERE "createdAt" >= ${startAt} AND "createdAt" < ${observedThrough}
      GROUP BY ("createdAt" AT TIME ZONE 'Europe/Moscow')::date ORDER BY ("createdAt" AT TIME ZONE 'Europe/Moscow')::date
    `);
  }

  private broadcastSummary(startAt: Date, observedThrough: Date) {
    return this.prisma.$queryRaw<BroadcastRow[]>(Prisma.sql`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'completed_with_errors') AS "completedWithErrors",
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        COALESCE(SUM("totalRecipients"), 0) AS recipients, COALESCE(SUM("sentCount"), 0) AS sent,
        COALESCE(SUM("failedCount"), 0) AS failed, COALESCE(SUM("ambiguousCount"), 0) AS ambiguous,
        COALESCE(SUM("skippedCount"), 0) AS skipped
      FROM broadcasts WHERE "terminalAt" >= ${startAt} AND "terminalAt" < ${observedThrough}
    `);
  }

  private broadcastErrors(startAt: Date, observedThrough: Date) {
    return this.prisma.$queryRaw<ErrorCodeRow[]>(Prisma.sql`
      SELECT CASE WHEN r."lastErrorCode" IN (
        'recipient_ineligible','lease_expired_after_io','telegram_runtime_closed','telegram_400','telegram_401',
        'telegram_403','telegram_404','telegram_409','telegram_429','telegram_500','telegram_502','telegram_503',
        'telegram_504','telegram_outcome_unknown'
      ) THEN r."lastErrorCode" ELSE 'other' END AS code, COUNT(*) AS count
      FROM broadcast_recipients r JOIN broadcasts b ON b.id = r."broadcastId"
      WHERE b."terminalAt" >= ${startAt} AND b."terminalAt" < ${observedThrough}
        AND r.status IN ('failed','ambiguous')
      GROUP BY code ORDER BY count DESC, code ASC
    `);
  }
}

function analyticsCoverage(startAt: Date, observedThrough: Date, completeFrom: Date): AdminAnalytics["coverage"] {
  if (observedThrough.getTime() <= completeFrom.getTime()) {
    return { status: "unavailable", completeFrom, incompleteBefore: completeFrom };
  }
  if (startAt.getTime() < completeFrom.getTime()) {
    return { status: "partial", completeFrom, incompleteBefore: completeFrom };
  }
  return { status: "complete", completeFrom, incompleteBefore: null };
}

function safeCount(value: CountValue | undefined): number {
  if (value === null || value === undefined) return 0;
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError("Analytics count exceeds the safe integer range");
  return number;
}

function nullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RangeError("Analytics numeric result is not finite");
  return Math.round(number * 100) / 100;
}

function percentage(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function tokenUsage(callsValue: CountValue, sumValue: CountValue, totalCalls: number): TokenUsage {
  const callsWithUsage = safeCount(callsValue);
  return { callsWithUsage, sum: callsWithUsage === 0 ? null : safeCount(sumValue), usageCoveragePct: percentage(callsWithUsage, totalCalls) };
}

function buildRetention(localDates: string[], rows: RetentionRow[], today: string): AdminAnalytics["retention"] {
  const byDate = new Map(rows.map((row) => [row.localDate, row]));
  const summaryAcc = new Map<number, { eligibleUsers: number; retainedUsers: number }>(RETENTION_DAYS.map((day) => [day, { eligibleUsers: 0, retainedUsers: 0 }]));
  const cohorts = localDates.map((localDate) => {
    const row = byDate.get(localDate);
    const cohortSize = safeCount(row?.cohortSize);
    const points = {} as Record<"d1"|"d7"|"d30", RetentionPoint | null>;
    for (const day of RETENTION_DAYS) {
      const key = `d${day}` as "d1"|"d7"|"d30";
      if (addIsoDays(localDate, day) > today) {
        points[key] = null;
      } else {
        const retainedUsers = safeCount(day === 1 ? row?.retainedD1 : day === 7 ? row?.retainedD7 : row?.retainedD30);
        points[key] = { retainedUsers, ratePct: percentage(retainedUsers, cohortSize) };
        const summary = summaryAcc.get(day)!;
        summary.eligibleUsers += cohortSize;
        summary.retainedUsers += retainedUsers;
      }
    }
    return { localDate, cohortSize, ...points };
  });
  const summary = {} as Record<"d1"|"d7"|"d30", RetentionSummary | null>;
  for (const day of RETENTION_DAYS) {
    const key = `d${day}` as "d1"|"d7"|"d30";
    const value = summaryAcc.get(day)!;
    summary[key] = value.eligibleUsers === 0 ? null : { ...value, ratePct: percentage(value.retainedUsers, value.eligibleUsers)! };
  }
  return { cohorts, summary };
}

function addIsoDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function emptyAiRow(): AiSummaryRow {
  return { coverageFrom: null, analyticsCompleteFrom: null, total: 0, succeeded: 0, empty: 0, failed: 0, averageMs: null, p50Ms: null, p95Ms: null, inputCalls: 0, inputSum: null, outputCalls: 0, outputSum: null, totalCalls: 0, totalSum: null };
}
