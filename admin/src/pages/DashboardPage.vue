<script setup lang="ts">
import { onMounted, ref } from "vue";
import { adminApi } from "../api/admin.api";
import type { DashboardStats } from "../types";
import StatsCard from "../components/StatsCard.vue";
import StatePanel from "../components/StatePanel.vue";

const stats = ref<DashboardStats | null>(null);
const loading = ref(true);
const error = ref(false);
async function load() {
  loading.value = true; error.value = false;
  try { stats.value = await adminApi.getDashboard(); }
  catch { error.value = true; }
  finally { loading.value = false; }
}
onMounted(load);
</script>
<template>
  <section>
    <header class="page-header dashboard-header"><div><p class="eyebrow">Обзор сервиса</p><h1>Дашборд</h1><p>Ключевые показатели работы Talking Bob.</p></div><el-button plain :loading="loading" :disabled="loading" @click="load">Обновить</el-button></header>
    <div v-if="loading" class="stats-grid" aria-label="Загрузка статистики"><el-skeleton v-for="i in 8" :key="i" animated><template #template><el-skeleton-item variant="rect" class="stats-skeleton" /></template></el-skeleton></div>
    <StatePanel v-else-if="error" title="Статистика недоступна" description="Проверьте соединение и попробуйте ещё раз." retry-label="Повторить" @retry="load" />
    <div v-else-if="stats" class="stats-grid">
      <StatsCard label="Всего пользователей" :value="stats.totalUsers" />
      <StatsCard label="Активных за 7 дней" :value="stats.activeUsers" />
      <StatsCard label="Новых за 7 дней" :value="stats.newUsersThisWeek" />
      <StatsCard label="С ежедневной рассылкой" :value="stats.usersWithDailyEnabled" />
      <StatsCard label="Отправлено промптов" :value="stats.totalPromptsSent" />
      <StatsCard label="Получено ответов" :value="stats.totalResponses" />
      <StatsCard label="Конверсия в ответ" :value="stats.responseRate" suffix="%" />
      <StatsCard label="Средняя оценка" :value="stats.averageScore" suffix=" / 10" />
    </div>
  </section>
</template>
