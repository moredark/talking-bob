<script setup lang="ts">
import { BarChart3 } from "@lucide/vue";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

withDefaults(defineProps<{
  title: string;
  description: string;
  empty?: boolean;
  emptyDescription?: string;
}>(), {
  empty: false,
  emptyDescription: "За выбранный период данных нет.",
});
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ title }}</CardTitle>
      <CardDescription>{{ description }}</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-5">
      <Empty v-if="empty" class="min-h-48 border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><BarChart3 /></EmptyMedia>
          <EmptyTitle>Нет данных</EmptyTitle>
          <EmptyDescription>{{ emptyDescription }}</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <slot v-else />
    </CardContent>
  </Card>
</template>
