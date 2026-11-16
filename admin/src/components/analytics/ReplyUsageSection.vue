<script setup lang="ts">
import { computed } from "vue";
import type { AdminAnalytics } from "@/types";
import type { ChartDatum, ChartSeries } from "@/components/ui/chart";
import StatsCard from "../StatsCard.vue";
import AnalyticsSection from "./AnalyticsSection.vue";
import MetricBarChart from "./MetricBarChart.vue";
import AccessibleDataTable from "./AccessibleDataTable.vue";

const props = defineProps<{ usage: AdminAnalytics["replyUsage"] }>();
const series: ChartSeries[] = [
  { key: "text", label: "Пользователи текста", color: "var(--chart-1)" },
  { key: "voice", label: "Пользователи голоса", color: "var(--chart-2)" },
];
const columns = [
  { key: "date", label: "Дата (Москва)" },
  { key: "total", label: "Пользователи" },
  { key: "text", label: "Пользователи текста" },
  { key: "voice", label: "Пользователи голоса" },
  { key: "mixed", label: "Оба формата" },
  { key: "textReplies", label: "Текстовые ответы" },
  { key: "voiceReplies", label: "Голосовые ответы" },
];
const rows = computed(() => props.usage.daily.map(day => ({
  date: day.localDate, total: day.users.total, text: day.users.text, voice: day.users.voice,
  mixed: day.users.mixed, textReplies: day.replies.text, voiceReplies: day.replies.voice,
})));
const chartRows = computed<ChartDatum[]>(() => rows.value.map(row => ({ label: row.date, text: row.text, voice: row.voice })));
const collectedFrom = computed(() => new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow",
}).format(new Date(props.usage.coverage.completeFrom)));
const textShare = computed(() => props.usage.users.textSharePct === null
  ? "—" : `${props.usage.users.textSharePct.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`);
</script>

<template>
  <AnalyticsSection
    title="Использование текста и голоса"
    description="Уникальные пользователи и принятые ответы за выбранный период."
  >
    <p v-if="usage.coverage.status !== 'complete'" class="text-sm text-muted-foreground" role="status">
      {{ usage.coverage.status === 'unavailable' ? 'Учёт ещё не начался.' : 'Период покрыт частично.' }}
      Учёт форматов с {{ collectedFrom }} (Москва). Более ранние ответы не включены в разбивку.
    </p>
    <p v-else class="text-sm text-muted-foreground">Учёт форматов с {{ collectedFrom }} (Москва).</p>
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <StatsCard label="Пользователи" :value="usage.users.total" />
      <StatsCard label="Пользовались текстом" :value="usage.users.text" />
      <StatsCard label="Пользовались голосом" :value="usage.users.voice" />
      <StatsCard label="Использовали оба формата" :value="usage.users.mixed" />
      <StatsCard label="Доля пользователей текста" :value="textShare" />
    </div>
    <p class="text-sm text-muted-foreground">
      Принятых ответов: текстом — {{ usage.replies.text.toLocaleString('ru-RU') }},
      голосом — {{ usage.replies.voice.toLocaleString('ru-RU') }}.
      Пользователи обоих форматов входят в обе группы. Доля текста считается среди пользователей с известным форматом ответа.
    </p>
    <template v-if="usage.users.total > 0">
      <MetricBarChart
        title="Пользователи текста и голоса по дням"
        description="Уникальные пользователи каждого формата в московский календарный день; группы могут пересекаться."
        :rows="chartRows"
        :series="series"
      />
      <AccessibleDataTable caption="Использование форматов по московским дням" :columns="columns" :rows="rows" compact />
    </template>
    <p v-else class="text-sm text-muted-foreground" role="status">
      За выбранный период принятых ответов с известным форматом нет.
    </p>
  </AnalyticsSection>
</template>
