<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RefreshCw } from "@lucide/vue";
import { adminApi } from "../api/admin.api";
import type { DashboardStats } from "../types";
import StatsCard from "../components/StatsCard.vue";
import StatePanel from "../components/StatePanel.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
const stats = ref<DashboardStats | null>(null); const loading = ref(true); const error = ref(false);
async function load() { loading.value = true; error.value = false; try { stats.value = await adminApi.getDashboard(); } catch { error.value = true; } finally { loading.value = false; } }
onMounted(load);
</script>
<template>
  <section class="flex flex-col gap-6">
    <header class="page-header"><div><p class="eyebrow">Обзор сервиса</p><h1>Дашборд</h1><p>Ключевые показатели работы Talking Bob.</p></div><Button variant="outline" :disabled="loading" @click="load"><Spinner v-if="loading" data-icon="inline-start" /><RefreshCw v-else data-icon="inline-start" />Обновить</Button></header>
    <div v-if="loading" class="stats-grid" aria-label="Загрузка статистики"><Skeleton v-for="i in 8" :key="i" class="h-32" /></div>
    <StatePanel v-else-if="error" title="Статистика недоступна" description="Проверьте соединение и попробуйте ещё раз." retry-label="Повторить" @retry="load" />
    <div v-else-if="stats" class="stats-grid">
      <StatsCard label="Всего пользователей" :value="stats.totalUsers" /><StatsCard label="Активных за 7 дней" :value="stats.activeUsers" /><StatsCard label="Новых за 7 дней" :value="stats.newUsersThisWeek" /><StatsCard label="С ежедневной рассылкой" :value="stats.usersWithDailyEnabled" /><StatsCard label="Отправлено промптов" :value="stats.totalPromptsSent" /><StatsCard label="Получено ответов" :value="stats.totalResponses" /><StatsCard label="Конверсия в ответ" :value="stats.responseRate" suffix="%" /><StatsCard label="Средняя оценка" :value="stats.averageScore" suffix=" / 10" />
    </div>
  </section>
</template>
