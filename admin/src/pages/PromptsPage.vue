<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from "element-plus";
import { adminApi } from "../api/admin.api";
import type { CreatePromptDto, PromptItem, UpdatePromptDto } from "../types";
import IconSymbol from "../components/IconSymbol.vue";
import StatePanel from "../components/StatePanel.vue";

const difficulties = [{ value: "easy", label: "Лёгкий" }, { value: "medium", label: "Средний" }, { value: "hard", label: "Сложный" }];
const availableTags = ["grammar", "vocabulary", "tense", "pronunciation", "fluency", "conversation"];
const prompts = ref<PromptItem[]>([]);
const loading = ref(true);
const error = ref(false);
const saving = ref(false);
const deletingId = ref<string | null>(null);
const dialogOpen = ref(false);
const editing = ref<PromptItem | null>(null);
const formRef = ref<FormInstance>();
const pagination = reactive({ page: 1, limit: 20, total: 0 });
const form = reactive({ topic: "", textContent: "", audioFileId: "", difficulty: "medium", tags: [] as string[], isActive: true, sortOrder: 0 });
const rules: FormRules = { topic: [{ required: true, whitespace: true, message: "Введите тему", trigger: "blur" }] };
const difficultyLabel = (value: string) => difficulties.find(item => item.value === value)?.label || value;
const difficultyType = (value: string) => value === "easy" ? "success" : value === "hard" ? "danger" : "warning";
const difficultyFilters = difficulties.map(({ value, label }) => ({ text: label, value }));
const activeFilters = [{ text: "Активен", value: true }, { text: "Неактивен", value: false }];
const filterByDifficulty = (value: unknown, row: PromptItem) => row.difficulty === value;
const filterByActive = (value: unknown, row: PromptItem) => row.isActive === value;
async function load(page = pagination.page) {
  loading.value = true; error.value = false;
  try { const result = await adminApi.getPrompts(page, pagination.limit); prompts.value = result.data; Object.assign(pagination, { page: result.page, limit: result.limit, total: result.total }); }
  catch { error.value = true; }
  finally { loading.value = false; }
}
function openCreate() {
  editing.value = null;
  Object.assign(form, { topic: "", textContent: "", audioFileId: "", difficulty: "medium", tags: [], isActive: true, sortOrder: 0 });
  dialogOpen.value = true;
}
function openEdit(prompt: PromptItem) {
  editing.value = prompt;
  Object.assign(form, { topic: prompt.topic, textContent: prompt.textContent || "", audioFileId: prompt.audioFileId || "", difficulty: prompt.difficulty, tags: [...prompt.tags], isActive: prompt.isActive, sortOrder: prompt.sortOrder });
  dialogOpen.value = true;
}
async function save() {
  if (!await formRef.value?.validate().catch(() => false)) return;
  saving.value = true;
  const common = { topic: form.topic.trim(), audioFileId: form.audioFileId.trim() || null, difficulty: form.difficulty, tags: form.tags, isActive: form.isActive, sortOrder: form.sortOrder };
  try {
    if (editing.value) {
      const updateData: UpdatePromptDto = { ...common, textContent: form.textContent.trim() };
      await adminApi.updatePrompt(editing.value.id, updateData);
    } else {
      const createData: CreatePromptDto = { ...common, textContent: form.textContent.trim() || undefined };
      await adminApi.createPrompt(createData);
    }
    ElMessage.success(editing.value ? "Промпт обновлён" : "Промпт создан");
    dialogOpen.value = false; await load();
  } catch { ElMessage.error("Не удалось сохранить промпт"); }
  finally { saving.value = false; }
}
async function remove(prompt: PromptItem) {
  try { await ElMessageBox.confirm(`Удалить промпт «${prompt.topic}»? Это действие нельзя отменить.`, "Подтверждение", { confirmButtonText: "Удалить", cancelButtonText: "Отмена", type: "warning" }); }
  catch { return; }
  deletingId.value = prompt.id;
  try { await adminApi.deletePrompt(prompt.id); ElMessage.success("Промпт удалён"); const targetPage = prompts.value.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page; await load(targetPage); }
  catch { ElMessage.error("Не удалось удалить промпт"); }
  finally { deletingId.value = null; }
}
onMounted(() => load(1));
</script>
<template>
  <section>
    <header class="page-header"><div><p class="eyebrow">Контент</p><h1>Промпты</h1><p>Вопросы, сложность и порядок отправки.</p></div><el-button type="primary" @click="openCreate"><IconSymbol name="plus" />Добавить промпт</el-button></header>
    <StatePanel v-if="error && !loading" title="Не удалось загрузить промпты" retry-label="Повторить" @retry="load()" />
    <div v-else class="table-card">
      <el-table v-loading="loading" :data="prompts" row-key="id" stripe table-layout="auto" empty-text="Промптов пока нет">
        <el-table-column prop="topic" label="Тема" min-width="150"><template #default="{ row }"><strong>{{ row.topic }}</strong></template></el-table-column>
        <el-table-column prop="textContent" label="Текст" min-width="220" show-overflow-tooltip><template #default="{ row }">{{ row.textContent || '—' }}</template></el-table-column>
        <el-table-column prop="difficulty" label="Сложность" width="120" :filters="difficultyFilters" :filter-method="filterByDifficulty"><template #default="{ row }"><el-tag :type="difficultyType(row.difficulty)">{{ difficultyLabel(row.difficulty) }}</el-tag></template></el-table-column>
        <el-table-column label="Теги" min-width="210"><template #default="{ row }"><div class="tag-list"><el-tag v-for="tag in row.tags" :key="tag" type="info" effect="plain">{{ tag }}</el-tag><span v-if="!row.tags.length">—</span></div></template></el-table-column>
        <el-table-column prop="isActive" label="Статус" width="115" :filters="activeFilters" :filter-method="filterByActive"><template #default="{ row }"><el-tag :type="row.isActive ? 'success' : 'info'">{{ row.isActive ? 'Активен' : 'Неактивен' }}</el-tag></template></el-table-column>
        <el-table-column prop="timesSent" label="Отправлено" sortable width="125" />
        <el-table-column prop="sortOrder" label="Порядок" sortable width="110" />
        <el-table-column label="Действия" fixed="right" width="112"><template #default="{ row }"><div class="table-actions"><el-button circle plain aria-label="Редактировать" @click="openEdit(row)"><IconSymbol name="edit" /></el-button><el-button circle plain type="danger" aria-label="Удалить" :loading="deletingId === row.id" :disabled="deletingId !== null" @click="remove(row)"><IconSymbol v-if="deletingId !== row.id" name="delete" /></el-button></div></template></el-table-column>
      </el-table>
      <div v-if="pagination.total > pagination.limit" class="pagination"><el-pagination background layout="prev, pager, next" :current-page="pagination.page" :page-size="pagination.limit" :total="pagination.total" @current-change="load" /></div>
    </div>
    <el-dialog v-model="dialogOpen" :title="editing ? 'Редактировать промпт' : 'Новый промпт'" width="min(620px, 94vw)" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="Тема" prop="topic"><el-input v-model="form.topic" placeholder="Например: Travel" /></el-form-item>
        <el-form-item label="Текст вопроса"><el-input v-model="form.textContent" type="textarea" :rows="3" placeholder="Необязательно" /></el-form-item>
        <el-form-item label="Telegram Audio File ID"><el-input v-model="form.audioFileId" placeholder="Необязательно" /></el-form-item>
        <div class="form-grid"><el-form-item label="Сложность"><el-select v-model="form.difficulty"><el-option v-for="item in difficulties" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item><el-form-item label="Порядок"><el-input-number v-model="form.sortOrder" :min="0" /></el-form-item></div>
        <el-form-item label="Теги"><el-select v-model="form.tags" multiple placeholder="Выберите теги"><el-option v-for="tag in availableTags" :key="tag" :label="tag" :value="tag" /></el-select></el-form-item>
        <el-form-item label="Активность"><el-switch v-model="form.isActive" inline-prompt active-text="Да" inactive-text="Нет" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="dialogOpen = false">Отмена</el-button><el-button type="primary" :loading="saving" :disabled="saving" @click="save">Сохранить</el-button></template>
    </el-dialog>
  </section>
</template>
