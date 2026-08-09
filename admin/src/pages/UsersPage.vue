<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { adminApi } from "../api/admin.api";
import type { UserListItem } from "../types";
import StatePanel from "../components/StatePanel.vue";
import IconSymbol from "../components/IconSymbol.vue";

const router = useRouter();
const users = ref<UserListItem[]>([]);
const loading = ref(true);
const error = ref(false);
const pagination = reactive({ page: 1, limit: 20, total: 0 });
const date = (value: string | null) => value ? new Date(value).toLocaleDateString("ru-RU") : "Нет";
const dailyFilters = [{ text: "Включена", value: true }, { text: "Выключена", value: false }];
const filterByDaily = (value: unknown, row: UserListItem) => row.dailyPromptEnabled === value;
async function load(page = pagination.page) {
  loading.value = true; error.value = false;
  try { const result = await adminApi.getUsers(page, pagination.limit); users.value = result.data; Object.assign(pagination, { page: result.page, limit: result.limit, total: result.total }); }
  catch { error.value = true; }
  finally { loading.value = false; }
}
onMounted(() => load(1));
</script>
<template>
  <section>
    <header class="page-header"><div><p class="eyebrow">Аудитория</p><h1>Пользователи</h1><p>Активность, прогресс и настройки рассылки.</p></div><el-button :loading="loading" :disabled="loading" @click="load()">Обновить</el-button></header>
    <StatePanel v-if="error && !loading" title="Не удалось загрузить пользователей" description="Данные не были изменены." retry-label="Повторить" @retry="load()" />
    <div v-else class="table-card users-table-card">
      <el-table v-loading="loading" :data="users" row-key="id" stripe table-layout="auto" empty-text="Пользователей пока нет" @row-click="(row: UserListItem) => router.push(`/users/${row.id}`)">
        <el-table-column prop="username" label="Имя" min-width="150"><template #default="{ row }"><strong>{{ row.username || 'Без username' }}</strong></template></el-table-column>
        <el-table-column prop="telegramId" label="Telegram ID" min-width="150" />
        <el-table-column prop="promptsReceived" label="Промптов" sortable width="120" />
        <el-table-column prop="responsesCount" label="Ответов" sortable width="110" />
        <el-table-column prop="averageScore" label="Ср. оценка" sortable width="120"><template #default="{ row }">{{ row.averageScore !== null ? `${row.averageScore}/10` : '—' }}</template></el-table-column>
        <el-table-column prop="dailyPromptEnabled" label="Рассылка" width="120" :filters="dailyFilters" :filter-method="filterByDaily"><template #default="{ row }"><el-tag :type="row.dailyPromptEnabled ? 'success' : 'info'" effect="light">{{ row.dailyPromptEnabled ? 'Включена' : 'Выключена' }}</el-tag></template></el-table-column>
        <el-table-column prop="lastActivityAt" label="Активность" sortable min-width="130"><template #default="{ row }">{{ date(row.lastActivityAt) }}</template></el-table-column>
        <el-table-column prop="createdAt" label="Регистрация" sortable min-width="130"><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column>
        <el-table-column label="" fixed="right" width="62"><template #default="{ row }"><el-button circle plain aria-label="Открыть пользователя" @click.stop="router.push(`/users/${row.id}`)"><IconSymbol name="view" /></el-button></template></el-table-column>
      </el-table>
      <div v-if="pagination.total > pagination.limit" class="pagination"><el-pagination background layout="prev, pager, next" :current-page="pagination.page" :page-size="pagination.limit" :total="pagination.total" @current-change="load" /></div>
    </div>
  </section>
</template>
