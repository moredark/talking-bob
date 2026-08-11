import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const adminRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(adminRoot, path), "utf8");

test("analytics dependencies and API use the frozen versioned contract", () => {
  const packageJson = JSON.parse(read("package.json"));
  const api = read("src/api/admin.api.ts");
  const types = read("src/types/index.ts");

  assert.equal(packageJson.dependencies["@unovis/vue"], "1.6.7");
  assert.equal(packageJson.dependencies["@unovis/ts"], "1.6.7");
  assert.match(
    api,
    /getAnalytics:\s*async\s*\(days:\s*AnalyticsDays\):\s*Promise<AdminAnalytics>[\s\S]*apiClient\.get<AdminAnalytics>\("\/admin\/analytics",\s*\{\s*params:\s*\{\s*days\s*\}\s*\}\)/,
  );

  const contract = types.match(/export interface AdminAnalytics\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(contract, "AdminAnalytics must remain declared");
  for (const field of [
    "version",
    "generatedAt",
    "timezone",
    "days",
    "period",
    "coverage",
    "daily",
    "funnel",
    "retention",
    "scores",
    "ai",
    "broadcasts",
    "coverageFrom",
    "errorCodes",
  ]) {
    assert.match(contract, new RegExp(`\\b${field}\\??:`));
  }
  assert.match(types, /export type AnalyticsDays\s*=\s*7\s*\|\s*30\s*\|\s*90/);
  assert.match(types, /export interface AnalyticsTokenUsage[\s\S]*usageCoveragePct:\s*number \| null/);
  assert.match(contract, /timezone:\s*"Europe\/Moscow"/);
  assert.match(contract, /status:\s*"complete"\s*\|\s*"partial"\s*\|\s*"unavailable"/);
  assert.match(contract, /completeFrom:\s*string/);
  assert.match(contract, /incompleteBefore:\s*string \| null/);
  assert.doesNotMatch(
    contract,
    /\b(?:transcript|messages|analysis|responseContent|requestContent|telegramId)\b/,
    "analytics response must not expose sensitive raw content",
  );
});

test("dashboard preserves legacy KPIs and isolates analytics requests", () => {
  const page = read("src/pages/DashboardPage.vue");

  assert.match(page, /adminApi\.getDashboard\(\)/);
  assert.match(page, /const analyticsDays\s*=\s*ref<AnalyticsDays>\(30\)/);
  assert.match(page, /adminApi\.getAnalytics\(requestedDays\)/);
  assert.match(page, /let analyticsRequestSequence\s*=\s*0/);
  assert.match(page, /const requestId\s*=\s*\+\+analyticsRequestSequence/);
  assert.match(page, /if\s*\(requestId\s*===\s*analyticsRequestSequence\)\s*analytics\.value\s*=\s*result/);
  assert.match(page, /parsed\s*!==\s*7\s*&&\s*parsed\s*!==\s*30\s*&&\s*parsed\s*!==\s*90/);
  assert.match(page, /<ToggleGroup[\s\S]*type="single"[\s\S]*value="7"[\s\S]*value="30"[\s\S]*value="90"/);
  assert.match(page, /statsLoading[\s\S]*statsError[\s\S]*analyticsLoading[\s\S]*analyticsError/);
  assert.match(page, /@retry="loadDashboard"/);
  assert.match(page, /@retry="loadAnalytics"/);
});

test("analytics renders every approved domain with explicit partial and empty states", () => {
  const page = read("src/pages/DashboardPage.vue");

  for (const title of [
    "Динамика продукта",
    "Воронка сессии",
    "Возвращаемость пользователей",
    "Оценки отчётов",
    "Темы",
    "AI provider",
    "Рассылки",
  ]) {
    assert.match(page, new RegExp(`title="${title}"`));
  }
  assert.match(page, /aiCoveragePartial/);
  assert.match(page, /usageCoveragePct/);
  assert.match(
    page,
    /какая доля зарегистрировавшихся в один день вернулась через 1, 7 и 30 дней/i,
  );
  assert.doesNotMatch(page, /Cohort retention|eligible cohorts|immature cohort/i);
  assert.match(page, /fallbackCount/);
  assert.match(page, /broadcasts\.recipients\.deliveryRatePct/);
  assert.doesNotMatch(page, /analytics\.coverage\.status === 'unavailable'/);
  assert.doesNotMatch(page, /analytics\.coverage\.status !== 'complete'/);
  assert.doesNotMatch(page, /Частичное историческое покрытие/);
  assert.doesNotMatch(page, /Историческое покрытие пока недоступно/);
  assert.match(page, /v-if="topicChartRows\.length"/);
  assert.match(page, /v-if="broadcastErrorRows\.length"/);
});

test("Unovis charts are supplemental to equivalent accessible shadcn tables", () => {
  const chart = read("src/components/analytics/MetricBarChart.vue");
  const container = read("src/components/ui/chart/ChartContainer.vue");
  const table = read("src/components/analytics/AccessibleDataTable.vue");
  const section = read("src/components/analytics/AnalyticsSection.vue");

  assert.match(chart, /from\s*"@unovis\/vue"/);
  assert.match(chart, /<VisXYContainer/);
  assert.match(chart, /<VisGroupedBar/);
  assert.match(chart, /<VisAxis/);
  assert.match(chart, /<VisTooltip/);
  assert.match(chart, /escapeHtml/);
  assert.match(container, /data-slot="chart"/);
  assert.match(container, /<figcaption\s+class="sr-only"/);
  assert.match(table, /<TableCaption>/);
  assert.match(table, /<TableHeader>/);
  assert.match(table, /<TableHead[^>]*scope="col"/);
  assert.match(table, /<TableBody>/);
  assert.doesNotMatch(table, /(?:sr-only|aria-hidden="true")/);
  assert.match(table, /compact\??:\s*boolean/);
  assert.match(table, /compact[\s\S]*max-h-64[\s\S]*overflow-y-auto/);
  assert.match(section, /<CardHeader>[\s\S]*<CardTitle>[\s\S]*<CardDescription>[\s\S]*<CardContent/);
  assert.match(section, /<Empty\s+v-if="empty"/);
});

test("only long daily and detailed retention tables use bounded vertical scrolling", () => {
  const page = read("src/pages/DashboardPage.vue");
  const tableTags = [...page.matchAll(/<AccessibleDataTable\b[\s\S]*?\/>/g)].map(
    ([tag]) => tag,
  );
  const compactTables = tableTags.filter((tag) => /\bcompact\b/.test(tag));

  assert.equal(compactTables.length, 2);
  assert.ok(compactTables.some((tag) => /:rows="dailyTableRows"/.test(tag)));
  assert.ok(compactTables.some((tag) => /:rows="retentionTableRows"/.test(tag)));
  assert.ok(
    tableTags
      .filter((tag) => !/:rows="(?:dailyTableRows|retentionTableRows)"/.test(tag))
      .every((tag) => !/\bcompact\b/.test(tag)),
  );
});

test("review fixes preserve partial datasets, Moscow dates, summaries, and touch targets", () => {
  const page = read("src/pages/DashboardPage.vue");
  const chart = read("src/components/analytics/MetricBarChart.vue");

  const dateFormatter = page.match(
    /function formatDate\(value: string\): string \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(dateFormatter);
  assert.match(dateFormatter, /value\.split\("-"\)/);
  assert.doesNotMatch(dateFormatter, /(?:new Date|Intl\.DateTimeFormat)/);

  const retentionEmpty = page.match(
    /const retentionEmpty = computed\(\(\) =>([\s\S]*?)\n\);/,
  )?.[1];
  assert.ok(retentionEmpty);
  assert.match(retentionEmpty, /retention\.cohorts\.length/);
  assert.match(page, /v-if="!retentionSummaryEmpty"[\s\S]*Возвращаемость через 1, 7 и 30 дней/);
  assert.match(page, /Для зарегистрировавшихся пользователей ещё не наступил срок в 1, 7 или 30 дней/);

  const scoresEmpty = page.match(
    /const scoresEmpty = computed\(\(\) => \{([\s\S]*?)\n\}\);/,
  )?.[1];
  assert.ok(scoresEmpty);
  assert.match(scoresEmpty, /fallbackCount === 0/);
  assert.match(scoresEmpty, /scores\.topics\.length === 0/);
  assert.match(scoresEmpty, /scores\.distribution\.every/);
  assert.match(page, /analytics\.scores\.scoredCount === 0[\s\S]*fallback и invalid/);

  assert.match(page, /analytics\.ai\.outcomes\.successRatePct/);
  assert.match(page, /analytics\.ai\.latency\.averageMs/);
  assert.match(page, /analytics\.ai\.latency\.p50Ms/);
  assert.match(page, /analytics\.ai\.latency\.p95Ms/);

  assert.match(chart, /return typeof value === "number" \? value : 0/);
  assert.match(chart, /:bar-min-height="0"/);
  assert.doesNotMatch(chart, /Number\.NaN/);

  assert.match(
    page,
    /<Button[\s\S]*variant="outline"[\s\S]*class="min-h-11"[\s\S]*@click="refreshAll"/,
  );
  assert.equal(
    (page.match(/<ToggleGroupItem[^>]*class="min-h-11 min-w-11"/g) ?? []).length,
    3,
  );
});
