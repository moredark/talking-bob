<script setup lang="ts">
import { computed } from "vue";
import {
  VisAxis,
  VisGroupedBar,
  VisGroupedBarSelectors,
  VisTooltip,
  VisXYContainer,
} from "@unovis/vue";
import { ChartContainer } from "@/components/ui/chart";
import type { ChartDatum, ChartSeries } from "@/components/ui/chart";

const props = defineProps<{
  title: string;
  description: string;
  rows: ChartDatum[];
  series: ChartSeries[];
  valueSuffix?: string;
}>();

const x = (_datum: ChartDatum, index: number) => index;
const y = computed(() =>
  props.series.map((series) => (datum: ChartDatum) => {
    const value = datum[series.key];
    return typeof value === "number" ? value : 0;
  }),
);
const colors = computed(() => props.series.map((series) => series.color));
const tickValues = computed(() => props.rows.map((_row, index) => index));
const tickFormat = (value: number) => props.rows[value]?.label ?? "";
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character] ?? character));
const tooltipTriggers = computed(() => ({
  [VisGroupedBarSelectors.bar]: (datum: ChartDatum) => {
    const values = props.series
      .map((series) => {
        const value = datum?.[series.key];
        return `${escapeHtml(series.label)}: ${typeof value === "number" ? value.toLocaleString("ru-RU") : "—"}${props.valueSuffix ?? ""}`;
      })
      .join("<br>");
    return `<strong>${escapeHtml(datum?.label ?? "")}</strong><br>${values}`;
  },
}));
</script>

<template>
  <ChartContainer :title="title" :description="description">
    <VisXYContainer :data="rows" :height="280">
      <VisGroupedBar
        :x="x"
        :y="y"
        :color="colors"
        :group-padding="0.2"
        :bar-padding="0.08"
        :bar-min-height="0"
        :rounded-corners="3"
      />
      <VisAxis
        type="x"
        :tick-values="tickValues"
        :tick-format="tickFormat"
        :tick-text-hide-overlapping="true"
        :grid-line="false"
      />
      <VisAxis type="y" :grid-line="true" />
      <VisTooltip :triggers="tooltipTriggers" />
    </VisXYContainer>
  </ChartContainer>
  <ul class="flex flex-wrap gap-3 text-sm text-muted-foreground" aria-label="Легенда графика">
    <li v-for="seriesItem in series" :key="seriesItem.key" class="flex items-center gap-2">
      <span class="size-2 rounded-full" :style="{ backgroundColor: seriesItem.color }" aria-hidden="true" />
      {{ seriesItem.label }}
    </li>
  </ul>
</template>
