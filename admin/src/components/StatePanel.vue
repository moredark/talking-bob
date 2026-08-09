<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
defineProps<{ title: string; description?: string; retryLabel?: string }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <Empty class="min-h-72 rounded-xl border" role="status">
    <EmptyHeader><EmptyMedia variant="icon"><RefreshCw /></EmptyMedia><EmptyTitle>{{ title }}</EmptyTitle><EmptyDescription v-if="description">{{ description }}</EmptyDescription></EmptyHeader>
    <EmptyContent v-if="retryLabel"><Button variant="outline" @click='$emit("retry")'><RefreshCw data-icon="inline-start" />{{ retryLabel }}</Button></EmptyContent>
  </Empty>
</template>
