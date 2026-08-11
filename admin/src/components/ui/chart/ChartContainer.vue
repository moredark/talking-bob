<script setup lang="ts">
defineProps<{
  title: string;
  description: string;
}>();
</script>

<template>
  <figure class="flex flex-col gap-3" data-slot="chart">
    <div class="h-72 min-w-0" aria-hidden="true">
      <slot />
    </div>
    <figcaption class="sr-only">{{ title }}. {{ description }}</figcaption>
  </figure>
</template>
