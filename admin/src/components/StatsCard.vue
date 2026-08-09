<script setup lang="ts">
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
defineProps<{ label: string; value: number | string | null; suffix?: string; tone?: "blue" | "green" | "amber" | "violet" }>();
</script>
<template>
  <Card><CardHeader class="pb-2"><CardTitle class="text-sm font-medium text-muted-foreground">{{ label }}</CardTitle></CardHeader>
    <CardContent><div class="text-3xl font-semibold tracking-tight">{{ value ?? '—' }}<span v-if="suffix" class="ml-1 text-sm font-normal text-muted-foreground">{{ suffix }}</span></div></CardContent>
  </Card>
</template>
