<script setup lang="ts">
import IconSymbol from "./IconSymbol.vue";
defineProps<{ title: string; description?: string; retryLabel?: string }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <div class="state-panel" role="status">
    <div class="state-panel__mark"><IconSymbol name="refresh" /></div>
    <strong>{{ title }}</strong>
    <p v-if="description">{{ description }}</p>
    <el-button v-if="retryLabel" @click="$emit('retry')"><IconSymbol name="refresh" />{{ retryLabel }}</el-button>
  </div>
</template>
