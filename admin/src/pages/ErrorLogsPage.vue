<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { adminApi } from "../api/admin.api";
import type { ErrorLogItem } from "../types";
import IconSymbol from "../components/IconSymbol.vue";
import StatePanel from "../components/StatePanel.vue";
const types = [{ value: "ai", label: "AI" }, { value: "telegram", label: "Telegram" }, { value: "system", label: "Система" }];
const services = [{ value: "whisper", label: "Whisper" }, { value: "llm", label: "LLM" }, { value: "tts", label: "TTS" }, { value: "telegram", label: "Telegram" }, { value: "scheduler", label: "Планировщик" }, { value: "general", label: "Общее" }];
const logs = ref<ErrorLogItem[]>([]); const loading = ref(true); const error = ref(false); const clearing = ref(false); const selected = ref<ErrorLogItem | null>(null); const detailOpen = ref(false);
const filters = reactive<{ type?: string; service?: string }>({}); const pagination = reactive({ page: 1, limit: 50, total: 0 });
const formatDate = (value: string) => new Date(value).toLocaleString("ru-RU");
const typeColor = (value: string) => value === "system" ? "danger" : value === "telegram" ? "primary" : "warning";
let requestSequence = 0;
async function load(page = pagination.page) {
  const requestId = ++requestSequence;
  loading.value = true; error.value = false;
  try {
    const result = await adminApi.getErrorLogs(page, pagination.limit, filters.type, filters.service);
    if (requestId !== requestSequence) return;
    logs.value = result.data;
    Object.assign(pagination, { page: result.page, limit: result.limit, total: result.total });
  } catch {
    if (requestId === requestSequence) error.value = true;
  } finally {
    if (requestId === requestSequence) loading.value = false;
  }
}
function show(log: ErrorLogItem) { selected.value = log; detailOpen.value = true; }
async function clearOld() {
  try { await ElMessageBox.confirm("Будут удалены все логи старше 30 дней. Продолжить?", "Очистить старые логи", { type: "warning", confirmButtonText: "Удалить", cancelButtonText: "Отмена" }); } catch { return; }
  clearing.value = true; try { const result = await adminApi.clearOldErrorLogs(30); ElMessage.success(`Удалено записей: ${result.deleted}`); await load(1); } catch { ElMessage.error("Не удалось удалить записи"); } finally { clearing.value = false; }
}
watch(filters, () => load(1)); onMounted(() => load(1));
</script>
<template>
  <section><header class="page-header"><div><p class="eyebrow">Мониторинг</p><h1>Логи ошибок</h1><p>Диагностика сервисов и системных сбоев.</p></div><div class="header-actions"><el-select v-model="filters.type" clearable placeholder="Все типы" aria-label="Фильтр по типу"><el-option v-for="item in types" :key="item.value" :label="item.label" :value="item.value" /></el-select><el-select v-model="filters.service" clearable placeholder="Все сервисы" aria-label="Фильтр по сервису"><el-option v-for="item in services" :key="item.value" :label="item.label" :value="item.value" /></el-select><el-button type="danger" plain :loading="clearing" :disabled="clearing || loading" @click="clearOld"><IconSymbol name="delete" />Очистить старые</el-button></div></header>
    <StatePanel v-if="error && !loading" title="Не удалось загрузить логи" retry-label="Повторить" @retry="load()" />
    <div v-else class="table-card"><el-table v-loading="loading" :data="logs" row-key="id" stripe size="small" table-layout="auto" empty-text="По выбранным фильтрам логов нет">
      <el-table-column prop="createdAt" label="Дата" min-width="175"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      <el-table-column prop="type" label="Тип" width="110"><template #default="{ row }"><el-tag :type="typeColor(row.type)">{{ row.type.toUpperCase() }}</el-tag></template></el-table-column>
      <el-table-column prop="service" label="Сервис" min-width="120"><template #default="{ row }"><el-tag type="info" effect="plain">{{ row.service }}</el-tag></template></el-table-column>
      <el-table-column prop="message" label="Сообщение" min-width="300" show-overflow-tooltip /><el-table-column prop="userId" label="User ID" min-width="130"><template #default="{ row }">{{ row.userId || '—' }}</template></el-table-column>
      <el-table-column label="" fixed="right" width="62"><template #default="{ row }"><el-button circle plain aria-label="Посмотреть детали" @click="show(row)"><IconSymbol name="view" /></el-button></template></el-table-column>
    </el-table><div v-if="pagination.total > pagination.limit" class="pagination"><el-pagination background layout="prev, pager, next" :current-page="pagination.page" :page-size="pagination.limit" :total="pagination.total" @current-change="load" /></div></div>
    <el-dialog v-model="detailOpen" title="Детали ошибки" width="min(760px, 94vw)"><div v-if="selected" class="log-detail"><dl><div><dt>Дата</dt><dd>{{ formatDate(selected.createdAt) }}</dd></div><div><dt>Тип</dt><dd><el-tag :type="typeColor(selected.type)">{{ selected.type.toUpperCase() }}</el-tag></dd></div><div><dt>Сервис</dt><dd>{{ selected.service }}</dd></div><div v-if="selected.userId"><dt>User ID</dt><dd><code>{{ selected.userId }}</code></dd></div></dl><section><strong>Сообщение</strong><pre class="code-block code-block--light">{{ selected.message }}</pre></section><section v-if="selected.stack"><strong>Stack trace</strong><pre class="code-block">{{ selected.stack }}</pre></section><section v-if="selected.metadata != null"><strong>Metadata</strong><pre class="code-block code-block--light">{{ JSON.stringify(selected.metadata, null, 2) }}</pre></section></div></el-dialog>
  </section>
</template>
