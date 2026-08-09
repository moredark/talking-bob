<script setup lang="ts">
defineProps<{ label: string; value: number | string | null; suffix?: string; tone?: "blue" | "green" | "amber" | "violet" }>();
</script>
<template>
  <article class="stats-card">
    <div class="stats-card__value">{{ value ?? '—' }}<span v-if="suffix">{{ suffix }}</span></div>
    <div class="stats-card__label">{{ label }}</div>
  </article>
</template>
