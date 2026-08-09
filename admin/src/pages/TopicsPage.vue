<script setup lang="ts">
import { onMounted, ref } from "vue";
import { adminApi } from "../api/admin.api";
import type { TopicStats } from "../types";
import StatePanel from "../components/StatePanel.vue";
const topics = ref<TopicStats[]>([]); const loading = ref(true); const error = ref(false);
const scoreType = (score: number | null) => score === null ? "info" : score >= 7 ? "success" : score >= 5 ? "warning" : "danger";
const activeFilters = [{ text: "Активна", value: true }, { text: "Неактивна", value: false }];
const filterByActive = (value: unknown, row: TopicStats) => row.isActive === value;
async function load() { loading.value = true; error.value = false; try { topics.value = await adminApi.getTopics(); } catch { error.value = true; } finally { loading.value = false; } }
onMounted(load);
</script>
<template>
  <section><header class="page-header"><div><p class="eyebrow">Аналитика</p><h1>Статистика по темам</h1><p>Эффективность и вовлечённость для каждого направления.</p></div><el-button :loading="loading" :disabled="loading" @click="load">Обновить</el-button></header>
    <StatePanel v-if="error && !loading" title="Не удалось загрузить темы" retry-label="Повторить" @retry="load" />
    <div v-else class="table-card"><el-table v-loading="loading" :data="topics" row-key="id" stripe table-layout="auto" empty-text="Статистики по темам пока нет">
      <el-table-column prop="topic" label="Тема" min-width="180"><template #default="{ row }"><strong>{{ row.topic }}</strong></template></el-table-column>
      <el-table-column prop="isActive" label="Статус" width="125" :filters="activeFilters" :filter-method="filterByActive"><template #default="{ row }"><el-tag :type="row.isActive ? 'success' : 'info'">{{ row.isActive ? 'Активна' : 'Неактивна' }}</el-tag></template></el-table-column>
      <el-table-column prop="timesSent" label="Отправлено" sortable min-width="125" /><el-table-column prop="responsesCount" label="Ответов" sortable min-width="110" />
      <el-table-column prop="responseRate" label="Конверсия" sortable min-width="125"><template #default="{ row }">{{ row.responseRate }}%</template></el-table-column>
      <el-table-column prop="averageScore" label="Ср. оценка" sortable min-width="125"><template #default="{ row }"><el-tag :type="scoreType(row.averageScore)">{{ row.averageScore !== null ? `${row.averageScore}/10` : 'Нет данных' }}</el-tag></template></el-table-column>
    </el-table></div>
  </section>
</template>
