<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RefreshCw } from "@lucide/vue";
import { adminApi } from "../api/admin.api";
import type {
  AdminAnalytics,
  AnalyticsDays,
  DashboardStats,
} from "../types";
import type {
  ChartDatum,
  ChartSeries,
} from "@/components/ui/chart";
import StatsCard from "../components/StatsCard.vue";
import StatePanel from "../components/StatePanel.vue";
import AccessibleDataTable from "../components/analytics/AccessibleDataTable.vue";
import AnalyticsSection from "../components/analytics/AnalyticsSection.vue";
import MetricBarChart from "../components/analytics/MetricBarChart.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

const stats = ref<DashboardStats | null>(null);
const statsLoading = ref(true);
const statsError = ref(false);
const analytics = ref<AdminAnalytics | null>(null);
const analyticsDays = ref<AnalyticsDays>(30);
const analyticsLoading = ref(true);
const analyticsError = ref(false);
let analyticsRequestSequence = 0;

const colors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const dailySeries: ChartSeries[] = [
  { key: "newUsers", label: "Новые пользователи", color: colors[0] },
  { key: "activeUsers", label: "Активные пользователи", color: colors[1] },
  { key: "promptsSent", label: "Промпты", color: colors[2] },
  { key: "responsesReceived", label: "Ответы", color: colors[3] },
];
const singleCountSeries: ChartSeries[] = [
  { key: "count", label: "Количество", color: colors[2] },
];
const singleRateSeries: ChartSeries[] = [
  { key: "rate", label: "Доля", color: colors[1] },
];
const aiOutcomeSeries: ChartSeries[] = [
  { key: "succeeded", label: "Успешно", color: colors[1] },
  { key: "empty", label: "Пустой ответ", color: colors[2] },
  { key: "failed", label: "Ошибка", color: colors[4] },
];
const aiLatencySeries: ChartSeries[] = [
  { key: "averageMs", label: "Средняя", color: colors[1] },
  { key: "p95Ms", label: "P95", color: colors[3] },
];
const broadcastRecipientSeries: ChartSeries[] = [
  { key: "sent", label: "Доставлено", color: colors[1] },
  { key: "failed", label: "Ошибка", color: colors[3] },
  { key: "ambiguous", label: "Неопределённо", color: colors[4] },
  { key: "skipped", label: "Пропущено", color: colors[2] },
];

const dailyColumns = [
  { key: "date", label: "Дата (Москва)" },
  { key: "newUsers", label: "Новые" },
  { key: "activeUsers", label: "Активные" },
  { key: "promptsSent", label: "Промпты" },
  { key: "responsesReceived", label: "Ответы" },
];
const funnelColumns = [
  { key: "stage", label: "Этап" },
  { key: "count", label: "Количество" },
  { key: "rate", label: "От отправленных" },
  { key: "dropOff", label: "Потеря с прошлого этапа" },
];
const retentionColumns = [
  { key: "date", label: "Дата регистрации" },
  { key: "cohortSize", label: "Размер" },
  { key: "d1", label: "D1" },
  { key: "d7", label: "D7" },
  { key: "d30", label: "D30" },
];
const retentionSummaryColumns = [
  { key: "period", label: "Период" },
  { key: "eligible", label: "Пользователи, для которых срок наступил" },
  { key: "retained", label: "Вернулись" },
  { key: "rate", label: "Доля" },
];
const scoreColumns = [
  { key: "score", label: "Оценка" },
  { key: "count", label: "Отчёты" },
];
const topicColumns = [
  { key: "topic", label: "Тема" },
  { key: "reports", label: "Отчёты" },
  { key: "scored", label: "С оценкой" },
  { key: "invalid", label: "Некорректная оценка" },
  { key: "fallback", label: "Fallback" },
  { key: "average", label: "Средняя оценка" },
];
const aiOutcomeColumns = [
  { key: "result", label: "Результат" },
  { key: "count", label: "Вызовы" },
];
const aiLatencyColumns = [
  { key: "date", label: "Дата (Москва)" },
  { key: "calls", label: "Вызовы" },
  { key: "average", label: "Средняя" },
  { key: "p95", label: "P95" },
];
const tokenColumns = [
  { key: "kind", label: "Токены" },
  { key: "calls", label: "Вызовы с usage" },
  { key: "sum", label: "Сумма" },
  { key: "coverage", label: "Покрытие" },
];
const broadcastTerminalColumns = [
  { key: "status", label: "Статус кампании" },
  { key: "count", label: "Количество" },
];
const broadcastRecipientColumns = [
  { key: "status", label: "Статус получателя" },
  { key: "count", label: "Количество" },
];
const errorCodeColumns = [
  { key: "code", label: "Безопасный код ошибки" },
  { key: "count", label: "Количество" },
];

const funnelLabels: Record<string, string> = {
  sent: "Отправлен промпт",
  message: "Получено сообщение",
  closed: "Диалог закрыт",
  generated: "Отчёт сгенерирован",
  delivered: "Отчёт доставлен",
};

function formatDate(value: string): string {
  const [, month, day] = value.split("-");
  const monthLabels = ["", "янв.", "февр.", "мар.", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."];
  const monthLabel = monthLabels[Number(month)];
  return day && monthLabel ? `${day} ${monthLabel}` : value;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("ru-RU");
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
}

function formatMilliseconds(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} мс`;
}

function retentionValue(point: { retainedUsers: number; ratePct: number | null } | null): string {
  return point === null ? "—" : `${formatNumber(point.retainedUsers)} · ${formatPercent(point.ratePct)}`;
}

async function loadDashboard(): Promise<void> {
  statsLoading.value = true;
  statsError.value = false;
  try {
    stats.value = await adminApi.getDashboard();
  } catch {
    statsError.value = true;
  } finally {
    statsLoading.value = false;
  }
}

async function loadAnalytics(): Promise<void> {
  const requestId = ++analyticsRequestSequence;
  const requestedDays = analyticsDays.value;
  analyticsLoading.value = true;
  analyticsError.value = false;
  analytics.value = null;
  try {
    const result = await adminApi.getAnalytics(requestedDays);
    if (requestId === analyticsRequestSequence) analytics.value = result;
  } catch {
    if (requestId === analyticsRequestSequence) analyticsError.value = true;
  } finally {
    if (requestId === analyticsRequestSequence) analyticsLoading.value = false;
  }
}

function selectAnalyticsDays(value: unknown): void {
  const parsed = Number(value);
  if (parsed !== 7 && parsed !== 30 && parsed !== 90) return;
  analyticsDays.value = parsed;
  void loadAnalytics();
}

function refreshAll(): void {
  void Promise.all([loadDashboard(), loadAnalytics()]);
}

const dailyChartRows = computed<ChartDatum[]>(() =>
  (analytics.value?.daily ?? []).map((row) => ({
    label: formatDate(row.localDate),
    newUsers: row.newUsers,
    activeUsers: row.activeUsers,
    promptsSent: row.promptsSent,
    responsesReceived: row.responsesReceived,
  })),
);
const dailyTableRows = computed(() =>
  (analytics.value?.daily ?? []).map((row) => ({
    date: row.localDate,
    newUsers: row.newUsers,
    activeUsers: row.activeUsers,
    promptsSent: row.promptsSent,
    responsesReceived: row.responsesReceived,
  })),
);
const dailyEmpty = computed(() =>
  (analytics.value?.daily ?? []).every((row) =>
    row.newUsers === 0 &&
    row.activeUsers === 0 &&
    row.promptsSent === 0 &&
    row.responsesReceived === 0
  ),
);

const funnelChartRows = computed<ChartDatum[]>(() =>
  (analytics.value?.funnel.stages ?? []).map((stage) => ({
    label: funnelLabels[stage.key],
    count: stage.count,
  })),
);
const funnelTableRows = computed(() =>
  (analytics.value?.funnel.stages ?? []).map((stage) => ({
    stage: funnelLabels[stage.key],
    count: stage.count,
    rate: formatPercent(stage.rateFromSentPct),
    dropOff: stage.dropOffFromPreviousCount === null
      ? "—"
      : `${formatNumber(stage.dropOffFromPreviousCount)} · ${formatPercent(stage.dropOffFromPreviousPct)}`,
  })),
);
const funnelEmpty = computed(() =>
  (analytics.value?.funnel.stages.find((stage) => stage.key === "sent")?.count ?? 0) === 0,
);

const retentionChartRows = computed<ChartDatum[]>(() => {
  const summary = analytics.value?.retention.summary;
  if (!summary) return [];
  return (["d1", "d7", "d30"] as const).map((key) => ({
    label: key.toUpperCase(),
    rate: summary[key]?.ratePct ?? null,
  }));
});
const retentionSummaryRows = computed(() => {
  const summary = analytics.value?.retention.summary;
  if (!summary) return [];
  return (["d1", "d7", "d30"] as const).map((key) => ({
    period: key.toUpperCase(),
    eligible: summary[key]?.eligibleUsers ?? "—",
    retained: summary[key]?.retainedUsers ?? "—",
    rate: formatPercent(summary[key]?.ratePct ?? null),
  }));
});
const retentionTableRows = computed(() =>
  (analytics.value?.retention.cohorts ?? []).map((cohort) => ({
    date: cohort.localDate,
    cohortSize: cohort.cohortSize,
    d1: retentionValue(cohort.d1),
    d7: retentionValue(cohort.d7),
    d30: retentionValue(cohort.d30),
  })),
);
const retentionSummaryEmpty = computed(() => {
  const summary = analytics.value?.retention.summary;
  return !summary || (summary.d1 === null && summary.d7 === null && summary.d30 === null);
});
const retentionEmpty = computed(() =>
  (analytics.value?.retention.cohorts.length ?? 0) === 0 && retentionSummaryEmpty.value,
);

const scoreChartRows = computed<ChartDatum[]>(() =>
  (analytics.value?.scores.distribution ?? []).map((row) => ({
    label: String(row.score),
    count: row.count,
  })),
);
const scoreTableRows = computed(() =>
  (analytics.value?.scores.distribution ?? []).map((row) => ({
    score: row.score,
    count: row.count,
  })),
);
const scoresEmpty = computed(() => {
  const scores = analytics.value?.scores;
  return !scores || (
    scores.generatedModelLegacyCount === 0 &&
    scores.scoredCount === 0 &&
    scores.invalidScoreCount === 0 &&
    scores.fallbackCount === 0 &&
    scores.topics.length === 0 &&
    scores.distribution.every((row) => row.count === 0)
  );
});

const topicChartRows = computed<ChartDatum[]>(() =>
  (analytics.value?.scores.topics ?? [])
    .filter((topic) => topic.averageScore !== null)
    .map((topic) => ({
      label: topic.topic,
      average: topic.averageScore,
    })),
);
const topicTableRows = computed(() =>
  (analytics.value?.scores.topics ?? []).map((topic) => ({
    topic: topic.topic,
    reports: topic.reportCount,
    scored: topic.scoredCount,
    invalid: topic.invalidScoreCount,
    fallback: topic.fallbackCount,
    average: formatNumber(topic.averageScore),
  })),
);
const topicSeries: ChartSeries[] = [
  { key: "average", label: "Средняя оценка", color: colors[1] },
];

const aiOutcomeChartRows = computed<ChartDatum[]>(() => {
  const outcomes = analytics.value?.ai.outcomes;
  return outcomes ? [{
    label: "AI-вызовы",
    succeeded: outcomes.succeeded,
    empty: outcomes.empty,
    failed: outcomes.failed,
  }] : [];
});
const aiOutcomeTableRows = computed(() => {
  const outcomes = analytics.value?.ai.outcomes;
  return outcomes ? [
    { result: "Успешно", count: outcomes.succeeded },
    { result: "Пустой ответ", count: outcomes.empty },
    { result: "Ошибка", count: outcomes.failed },
  ] : [];
});
const aiLatencyChartRows = computed<ChartDatum[]>(() =>
  (analytics.value?.ai.latency.daily ?? []).map((row) => ({
    label: formatDate(row.localDate),
    averageMs: row.averageMs,
    p95Ms: row.p95Ms,
  })),
);
const aiLatencyTableRows = computed(() =>
  (analytics.value?.ai.latency.daily ?? []).map((row) => ({
    date: row.localDate,
    calls: row.calls,
    average: formatMilliseconds(row.averageMs),
    p95: formatMilliseconds(row.p95Ms),
  })),
);
const tokenTableRows = computed(() => {
  const tokens = analytics.value?.ai.tokens;
  return tokens ? [
    { kind: "Входные", calls: tokens.input.callsWithUsage, sum: formatNumber(tokens.input.sum), coverage: formatPercent(tokens.input.usageCoveragePct) },
    { kind: "Выходные", calls: tokens.output.callsWithUsage, sum: formatNumber(tokens.output.sum), coverage: formatPercent(tokens.output.usageCoveragePct) },
    { kind: "Всего", calls: tokens.total.callsWithUsage, sum: formatNumber(tokens.total.sum), coverage: formatPercent(tokens.total.usageCoveragePct) },
  ] : [];
});
const aiEmpty = computed(() => {
  const ai = analytics.value?.ai;
  return !ai || (
    ai.outcomes.total === 0 &&
    ai.latency.daily.every((row) => row.calls === 0) &&
    ai.tokens.input.callsWithUsage === 0 &&
    ai.tokens.output.callsWithUsage === 0 &&
    ai.tokens.total.callsWithUsage === 0
  );
});
const aiCoveragePartial = computed(() => {
  const value = analytics.value;
  return value?.ai.coverageFrom !== null &&
    value?.ai.coverageFrom !== undefined &&
    new Date(value.ai.coverageFrom).getTime() > new Date(value.period.startAt).getTime();
});
const aiCoverageText = computed(() => {
  const coverageFrom = analytics.value?.ai.coverageFrom;
  if (!coverageFrom) return "Сохранённых AI traces за выбранный период нет.";
  return `AI traces доступны с ${formatTimestamp(coverageFrom)}. Token usage отражает только вызовы, где провайдер вернул usage.`;
});

const broadcastRecipientChartRows = computed<ChartDatum[]>(() => {
  const recipients = analytics.value?.broadcasts.recipients;
  return recipients ? [{
    label: "Получатели",
    sent: recipients.sent,
    failed: recipients.failed,
    ambiguous: recipients.ambiguous,
    skipped: recipients.skipped,
  }] : [];
});
const broadcastTerminalTableRows = computed(() => {
  const terminal = analytics.value?.broadcasts.terminal;
  return terminal ? [
    { status: "Завершено", count: terminal.completed },
    { status: "Завершено с ошибками", count: terminal.completedWithErrors },
    { status: "Отменено", count: terminal.cancelled },
  ] : [];
});
const broadcastRecipientTableRows = computed(() => {
  const recipients = analytics.value?.broadcasts.recipients;
  return recipients ? [
    { status: "Доставлено", count: recipients.sent },
    { status: "Ошибка", count: recipients.failed },
    { status: "Неопределённо", count: recipients.ambiguous },
    { status: "Пропущено", count: recipients.skipped },
  ] : [];
});
const broadcastErrorRows = computed(() =>
  (analytics.value?.broadcasts.errorCodes ?? []).map((row) => ({
    code: row.code,
    count: row.count,
  })),
);
const broadcastsEmpty = computed(() =>
  (analytics.value?.broadcasts.terminal.total ?? 0) === 0 &&
  (analytics.value?.broadcasts.recipients.total ?? 0) === 0,
);

onMounted(() => {
  void loadDashboard();
  void loadAnalytics();
});
</script>

<template>
  <section class="flex flex-col gap-8">
    <header class="page-header">
      <div>
        <p class="eyebrow">Обзор сервиса</p>
        <h1>Дашборд</h1>
        <p>Ключевые показатели и продуктовая аналитика Talking Bob.</p>
      </div>
      <Button
        variant="outline"
        class="min-h-11"
        :disabled="statsLoading || analyticsLoading"
        @click="refreshAll"
      >
        <Spinner v-if="statsLoading || analyticsLoading" data-icon="inline-start" />
        <RefreshCw v-else data-icon="inline-start" />
        Обновить
      </Button>
    </header>

    <section class="flex flex-col gap-4" aria-labelledby="legacy-kpi-title">
      <div>
        <h2 id="legacy-kpi-title" class="text-xl font-semibold">Основные KPI</h2>
        <p class="text-sm text-muted-foreground">Существующий lifetime и 7-дневный обзор.</p>
      </div>
      <div v-if="statsLoading" class="stats-grid" aria-label="Загрузка основных KPI">
        <Skeleton v-for="i in 8" :key="i" class="h-32" />
      </div>
      <StatePanel
        v-else-if="statsError"
        title="Основные KPI недоступны"
        description="Аналитика ниже загружается независимо. Повторите запрос KPI."
        retry-label="Повторить"
        @retry="loadDashboard"
      />
      <div v-else-if="stats" class="stats-grid">
        <StatsCard label="Всего пользователей" :value="stats.totalUsers" />
        <StatsCard label="Активных за 7 дней" :value="stats.activeUsers" />
        <StatsCard label="Новых за 7 дней" :value="stats.newUsersThisWeek" />
        <StatsCard label="С ежедневной рассылкой" :value="stats.usersWithDailyEnabled" />
        <StatsCard label="Отправлено промптов" :value="stats.totalPromptsSent" />
        <StatsCard label="Получено ответов" :value="stats.totalResponses" />
        <StatsCard label="Конверсия в ответ" :value="stats.responseRate" suffix="%" />
        <StatsCard label="Средняя оценка" :value="stats.averageScore" suffix=" / 10" />
      </div>
    </section>

    <section class="flex flex-col gap-5" aria-labelledby="analytics-title">
      <div class="flex flex-col justify-between gap-3 md:flex-row md:items-end">
        <div>
          <p class="eyebrow">Europe/Moscow</p>
          <h2 id="analytics-title" class="text-2xl font-semibold">Подробная аналитика</h2>
          <p class="text-sm text-muted-foreground">
            <template v-if="analytics">
              {{ analytics.days }} календарных дней, наблюдения по
              {{ formatTimestamp(analytics.period.observedThrough) }}.
            </template>
            <template v-else>Выберите окно отчёта.</template>
          </p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          :model-value="String(analyticsDays)"
          aria-label="Период аналитики"
          @update:model-value="selectAnalyticsDays"
        >
          <ToggleGroupItem value="7" aria-label="7 дней" class="min-h-11 min-w-11">7 дней</ToggleGroupItem>
          <ToggleGroupItem value="30" aria-label="30 дней" class="min-h-11 min-w-11">30 дней</ToggleGroupItem>
          <ToggleGroupItem value="90" aria-label="90 дней" class="min-h-11 min-w-11">90 дней</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div v-if="analyticsLoading" class="grid gap-4 lg:grid-cols-2" aria-label="Загрузка аналитики">
        <Skeleton v-for="i in 8" :key="i" class="h-96" />
      </div>
      <StatePanel
        v-else-if="analyticsError"
        title="Аналитика недоступна"
        description="Основные KPI выше остаются доступными. Повторите запрос выбранного периода."
        retry-label="Повторить"
        @retry="loadAnalytics"
      />
      <div v-else-if="analytics" class="grid gap-5 xl:grid-cols-2">
        <AnalyticsSection
          title="Динамика продукта"
          description="Новые и активные пользователи, учебные промпты и ответы по московским дням."
          :empty="dailyEmpty"
        >
          <MetricBarChart
            title="Динамика продукта по дням"
            description="Четыре серии по каждому московскому календарному дню."
            :rows="dailyChartRows"
            :series="dailySeries"
          />
          <AccessibleDataTable
            caption="Точные значения динамики продукта по московским дням"
            :columns="dailyColumns"
            :rows="dailyTableRows"
            compact
          />
        </AnalyticsSection>

        <AnalyticsSection
          title="Воронка сессии"
          description="Одна population отправленных UserPrompt: sent → message → closed → generated → delivered."
          :empty="funnelEmpty"
        >
          <div class="flex flex-wrap gap-2">
            <Badge variant="secondary">
              Конверсия в ответ: {{ formatPercent(analytics.funnel.responseRatePct) }}
            </Badge>
          </div>
          <MetricBarChart
            title="Воронка учебной сессии"
            description="Количество исходных UserPrompt на каждом последовательном этапе."
            :rows="funnelChartRows"
            :series="singleCountSeries"
          />
          <AccessibleDataTable
            caption="Точные значения и потери этапов воронки"
            :columns="funnelColumns"
            :rows="funnelTableRows"
          />
        </AnalyticsSection>

        <AnalyticsSection
          title="Возвращаемость пользователей"
          description="Показывает, какая доля зарегистрировавшихся в один день вернулась через 1, 7 и 30 дней. Прочерк означает, что нужный срок ещё не наступил."
          :empty="retentionEmpty"
        >
          <MetricBarChart
            v-if="!retentionSummaryEmpty"
            title="Возвращаемость через 1, 7 и 30 дней"
            description="Доля вернувшихся среди пользователей, для которых соответствующий срок уже наступил."
            :rows="retentionChartRows"
            :series="singleRateSeries"
            value-suffix="%"
          />
          <p v-if="retentionSummaryEmpty" class="text-sm text-muted-foreground" role="status">
            Для зарегистрировавшихся пользователей ещё не наступил срок в 1, 7 или 30 дней; такие значения показаны прочерками в таблице.
          </p>
          <AccessibleDataTable
            v-if="!retentionSummaryEmpty"
            caption="Точные сводные значения возвращаемости с графика"
            :columns="retentionSummaryColumns"
            :rows="retentionSummaryRows"
          />
          <AccessibleDataTable
            caption="Возвращаемость пользователей по дате регистрации; значения содержат число вернувшихся и долю"
            :columns="retentionColumns"
            :rows="retentionTableRows"
            compact
          />
        </AnalyticsSection>

        <AnalyticsSection
          title="Оценки отчётов"
          description="Распределение валидных overall score; invalid и fallback не превращаются в нули."
          :empty="scoresEmpty"
        >
          <div class="flex flex-wrap gap-2">
            <Badge variant="secondary">Средняя: {{ formatNumber(analytics.scores.averageScore) }}</Badge>
            <Badge variant="outline">С оценкой: {{ analytics.scores.scoredCount }}</Badge>
            <Badge variant="outline">Invalid: {{ analytics.scores.invalidScoreCount }}</Badge>
            <Badge variant="outline">Fallback: {{ analytics.scores.fallbackCount }}</Badge>
          </div>
          <MetricBarChart
            v-if="analytics.scores.scoredCount > 0"
            title="Распределение оценок"
            description="Количество сгенерированных model/legacy отчётов с валидной оценкой от 1 до 10."
            :rows="scoreChartRows"
            :series="singleCountSeries"
          />
          <p v-if="analytics.scores.scoredCount === 0" class="text-sm text-muted-foreground" role="status">
            Валидных оценок пока нет; fallback и invalid отчёты учтены в сводке.
          </p>
          <AccessibleDataTable
            caption="Точное распределение валидных оценок отчётов"
            :columns="scoreColumns"
            :rows="scoreTableRows"
          />
        </AnalyticsSection>

        <AnalyticsSection
          title="Темы"
          description="Качество и объём отчётов по теме prompt."
          :empty="analytics.scores.topics.length === 0"
        >
          <MetricBarChart
            v-if="topicChartRows.length"
            title="Средняя оценка по темам"
            description="Только темы с валидной средней оценкой."
            :rows="topicChartRows"
            :series="topicSeries"
          />
          <p v-else class="text-sm text-muted-foreground" role="status">
            У тем есть отчёты, но валидных средних оценок пока нет.
          </p>
          <AccessibleDataTable
            caption="Объём, оценки, invalid и fallback по темам"
            :columns="topicColumns"
            :rows="topicTableRows"
          />
        </AnalyticsSection>

        <AnalyticsSection
          title="AI provider"
          description="Outcomes, latency и token usage из санитизированных provider calls."
          :empty="aiEmpty"
        >
          <p
            class="text-sm text-muted-foreground"
            :role="aiCoveragePartial ? 'status' : undefined"
          >
            {{ aiCoverageText }}
          </p>
          <div class="flex flex-wrap gap-2">
            <Badge v-if="aiCoveragePartial" variant="outline">Частичное retention-покрытие</Badge>
            <Badge variant="secondary">Успех AI: {{ formatPercent(analytics.ai.outcomes.successRatePct) }}</Badge>
            <Badge variant="outline">Средняя latency: {{ formatMilliseconds(analytics.ai.latency.averageMs) }}</Badge>
            <Badge variant="outline">P50: {{ formatMilliseconds(analytics.ai.latency.p50Ms) }}</Badge>
            <Badge variant="outline">P95: {{ formatMilliseconds(analytics.ai.latency.p95Ms) }}</Badge>
          </div>
          <div class="grid gap-5">
            <div class="flex flex-col gap-4">
              <MetricBarChart
                title="Результаты AI-вызовов"
                description="Успешные, пустые и завершившиеся ошибкой provider calls."
                :rows="aiOutcomeChartRows"
                :series="aiOutcomeSeries"
              />
              <AccessibleDataTable
                caption="Точные outcomes AI provider calls"
                :columns="aiOutcomeColumns"
                :rows="aiOutcomeTableRows"
              />
            </div>
            <div class="flex flex-col gap-4">
              <MetricBarChart
                v-if="analytics.ai.latency.daily.some((row) => row.calls > 0)"
                title="Latency AI по дням"
                description="Средняя и P95 latency в миллисекундах."
                :rows="aiLatencyChartRows"
                :series="aiLatencySeries"
              />
              <p v-else class="text-sm text-muted-foreground" role="status">
                Latency series за период отсутствует.
              </p>
              <AccessibleDataTable
                caption="Точные daily latency значения AI-вызовов"
                :columns="aiLatencyColumns"
                :rows="aiLatencyTableRows"
              />
            </div>
            <AccessibleDataTable
              caption="Token usage и фактическое покрытие usage metadata"
              :columns="tokenColumns"
              :rows="tokenTableRows"
            />
          </div>
        </AnalyticsSection>

        <AnalyticsSection
          title="Рассылки"
          description="Кампании и доставки анонсов считаются отдельно от учебных промптов."
          :empty="broadcastsEmpty"
        >
          <div class="flex flex-wrap gap-2">
            <Badge variant="secondary">
              Delivery rate: {{ formatPercent(analytics.broadcasts.recipients.deliveryRatePct) }}
            </Badge>
          </div>
          <MetricBarChart
            title="Статусы получателей рассылок"
            description="Итоговые sent, failed, ambiguous и skipped доставки."
            :rows="broadcastRecipientChartRows"
            :series="broadcastRecipientSeries"
          />
          <AccessibleDataTable
            caption="Точные terminal statuses кампаний"
            :columns="broadcastTerminalColumns"
            :rows="broadcastTerminalTableRows"
          />
          <AccessibleDataTable
            caption="Точные terminal statuses получателей"
            :columns="broadcastRecipientColumns"
            :rows="broadcastRecipientTableRows"
          />
          <AccessibleDataTable
            v-if="broadcastErrorRows.length"
            caption="Безопасные коды ошибок доставки"
            :columns="errorCodeColumns"
            :rows="broadcastErrorRows"
          />
          <p v-else class="text-sm text-muted-foreground" role="status">
            Ошибок доставки за выбранный период нет.
          </p>
        </AnalyticsSection>
      </div>
    </section>
  </section>
</template>
