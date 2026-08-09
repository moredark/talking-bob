<script setup lang="ts">
defineProps<{ label: string; value: number | string | null; suffix?: string; tone?: "blue" | "green" | "amber" | "violet" }>();
</script>
<template>
  <article class="stats-card" :class="`stats-card--${tone || 'blue'}`">
    <div class="stats-card__label">{{ label }}</div>
    <div class="stats-card__value">{{ value ?? '—' }}<span v-if="suffix">{{ suffix }}</span></div>
    <div class="stats-card__accent" aria-hidden="true"></div>
  </article>
</template>
