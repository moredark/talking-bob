<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { Drama, Pencil, Plus, Power, PowerOff, RefreshCw, Star } from "@lucide/vue";
import { toast } from "vue-sonner";
import { adminApi } from "../api/admin.api";
import StatePanel from "../components/StatePanel.vue";
import type { CreatePersonalityDto, Personality, UpdatePersonalityDto } from "../types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const KEY_MAX_LENGTH = 32;
const NAME_MAX_LENGTH = 80;
const DESCRIPTION_MAX_LENGTH = 240;
const PROMPT_MAX_LENGTH = 8000;
const SORT_ORDER_MAX = 2147483647;

const personalities = ref<Personality[]>([]);
const loading = ref(true);
const loadError = ref(false);
const dialogOpen = ref(false);
const saving = ref(false);
const editing = ref<Personality | null>(null);
const pendingAction = ref<string | null>(null);
const deactivateCandidate = ref<Personality | null>(null);
const errors = reactive<Record<string, string>>({});
const rulesSaving = ref(false);
const rulesErrors = reactive<Record<string, string>>({});
const rulesForm = reactive({ followUpPrompt: "", analysisPrompt: "" });
const form = reactive({
  key: "",
  name: "",
  description: "",
  followUpStylePrompt: "",
  analysisStylePrompt: "",
  isActive: true,
  sortOrder: 0,
});
let requestSequence = 0;

function resetErrors() {
  for (const key of Object.keys(errors)) delete errors[key];
}

function openCreate() {
  editing.value = null;
  Object.assign(form, {
    key: "",
    name: "",
    description: "",
    followUpStylePrompt: "",
    analysisStylePrompt: "",
    isActive: true,
    sortOrder: 0,
  });
  resetErrors();
  dialogOpen.value = true;
}

function openEdit(personality: Personality) {
  editing.value = personality;
  Object.assign(form, {
    key: personality.key,
    name: personality.name,
    description: personality.description,
    followUpStylePrompt: personality.followUpStylePrompt,
    analysisStylePrompt: personality.analysisStylePrompt,
    isActive: personality.isActive,
    sortOrder: personality.sortOrder,
  });
  resetErrors();
  dialogOpen.value = true;
}

function validate() {
  resetErrors();
  const key = form.key.trim();
  const name = form.name.trim();
  const description = form.description.trim();
  const followUpStylePrompt = form.followUpStylePrompt.trim();
  const analysisStylePrompt = form.analysisStylePrompt.trim();

  if (!editing.value && !key) errors.key = "Введите ключ";
  else if (!editing.value && !/^[a-z0-9][a-z0-9_-]*$/.test(key)) errors.key = "Используйте строчные латинские буквы, цифры, дефис или подчёркивание";
  else if (!editing.value && key.length > KEY_MAX_LENGTH) errors.key = `Не более ${KEY_MAX_LENGTH} символов`;
  if (!name) errors.name = "Введите название";
  else if (name.length > NAME_MAX_LENGTH) errors.name = `Не более ${NAME_MAX_LENGTH} символов`;
  if (description.length > DESCRIPTION_MAX_LENGTH) errors.description = `Не более ${DESCRIPTION_MAX_LENGTH} символов`;
  if (!followUpStylePrompt) errors.followUpStylePrompt = "Введите правила стиля продолжения";
  else if (followUpStylePrompt.length > PROMPT_MAX_LENGTH) errors.followUpStylePrompt = `Не более ${PROMPT_MAX_LENGTH} символов`;
  if (!analysisStylePrompt) errors.analysisStylePrompt = "Введите правила стиля анализа";
  else if (analysisStylePrompt.length > PROMPT_MAX_LENGTH) errors.analysisStylePrompt = `Не более ${PROMPT_MAX_LENGTH} символов`;
  if (!Number.isSafeInteger(form.sortOrder) || form.sortOrder < 0 || form.sortOrder > SORT_ORDER_MAX) errors.sortOrder = `Введите целое число от 0 до ${SORT_ORDER_MAX}`;

  return Object.keys(errors).length === 0;
}

async function load() {
  const requestId = ++requestSequence;
  loading.value = true;
  loadError.value = false;
  try {
    const [result, rules] = await Promise.all([adminApi.getPersonalities(), adminApi.getPersonalityRules()]);
    if (requestId === requestSequence) {
      personalities.value = result;
      Object.assign(rulesForm, { followUpPrompt: rules.followUpPrompt, analysisPrompt: rules.analysisPrompt });
    }
  } catch {
    if (requestId === requestSequence) loadError.value = true;
  } finally {
    if (requestId === requestSequence) loading.value = false;
  }
}

async function refreshPersonalities() {
  personalities.value = await adminApi.getPersonalities();
}

async function saveRules() {
  for (const key of Object.keys(rulesErrors)) delete rulesErrors[key];
  const followUpPrompt = rulesForm.followUpPrompt.trim();
  const analysisPrompt = rulesForm.analysisPrompt.trim();
  if (!followUpPrompt) rulesErrors.followUpPrompt = "Введите общие правила продолжения";
  else if (followUpPrompt.length > PROMPT_MAX_LENGTH) rulesErrors.followUpPrompt = `Не более ${PROMPT_MAX_LENGTH} символов`;
  if (!analysisPrompt) rulesErrors.analysisPrompt = "Введите общие правила анализа";
  else if (analysisPrompt.length > PROMPT_MAX_LENGTH) rulesErrors.analysisPrompt = `Не более ${PROMPT_MAX_LENGTH} символов`;
  if (Object.keys(rulesErrors).length) return;
  rulesSaving.value = true;
  try {
    const updated = await adminApi.updatePersonalityRules({ followUpPrompt, analysisPrompt });
    Object.assign(rulesForm, { followUpPrompt: updated.followUpPrompt, analysisPrompt: updated.analysisPrompt });
    toast.success("Общие правила обновлены");
  } catch {
    toast.error("Не удалось сохранить общие правила");
  } finally {
    rulesSaving.value = false;
  }
}

async function save() {
  if (!validate()) return;
  saving.value = true;
  const common = {
    name: form.name.trim(),
    description: form.description.trim(),
    followUpStylePrompt: form.followUpStylePrompt.trim(),
    analysisStylePrompt: form.analysisStylePrompt.trim(),
    sortOrder: Number(form.sortOrder),
  };
  try {
    if (editing.value) {
      const data: UpdatePersonalityDto = common;
      await adminApi.updatePersonality(editing.value.id, data);
      toast.success("Личность обновлена");
    } else {
      const data: CreatePersonalityDto = {
        ...common,
        key: form.key.trim(),
        isActive: form.isActive,
      };
      await adminApi.createPersonality(data);
      toast.success("Личность создана");
    }
    dialogOpen.value = false;
    await refreshPersonalities();
  } catch {
    toast.error("Не удалось сохранить личность");
  } finally {
    saving.value = false;
  }
}

async function runAction(personality: Personality, action: "activate" | "deactivate" | "set-default") {
  pendingAction.value = `${action}:${personality.id}`;
  try {
    if (action === "activate") await adminApi.activatePersonality(personality.id);
    else if (action === "deactivate") await adminApi.deactivatePersonality(personality.id);
    else await adminApi.setDefaultPersonality(personality.id);
    toast.success(action === "activate" ? "Личность активирована" : action === "deactivate" ? "Личность деактивирована" : "Личность назначена по умолчанию");
    deactivateCandidate.value = null;
    await refreshPersonalities();
  } catch {
    toast.error(action === "deactivate" ? "Не удалось деактивировать личность" : "Не удалось изменить личность");
  } finally {
    pendingAction.value = null;
  }
}

function isPending(personality: Personality, action: string) {
  return pendingAction.value === `${action}:${personality.id}`;
}

onMounted(load);
</script>

<template>
  <section class="flex flex-col gap-6">
    <header class="page-header">
      <div>
        <p class="eyebrow">Поведение бота</p>
        <h1>Личности</h1>
        <p>Общие правила ответов и индивидуальный стиль каждого профиля.</p>
      </div>
      <div class="header-actions">
        <Button variant="outline" :disabled="loading || pendingAction !== null" @click="load">
          <RefreshCw data-icon="inline-start" /> Обновить
        </Button>
        <Button :disabled="pendingAction !== null" @click="openCreate">
          <Plus data-icon="inline-start" /> Добавить личность
        </Button>
      </div>
    </header>

    <StatePanel
      v-if="loadError && !loading"
      title="Не удалось загрузить личности"
      description="Проверьте соединение с сервером и повторите запрос."
      retry-label="Повторить"
      @retry="load"
    />

    <template v-else>
      <Card>
        <CardHeader>
          <CardTitle>Общие правила</CardTitle>
          <CardDescription>Формат и обязательные ограничения, которые применяются ко всем личностям. Изменения действуют со следующего ответа.</CardDescription>
        </CardHeader>
        <CardContent>
          <div v-if="loading" class="flex flex-col gap-4">
            <Skeleton class="h-40 w-full" /><Skeleton class="h-56 w-full" />
          </div>
          <FieldGroup v-else>
            <Field :data-invalid="Boolean(rulesErrors.followUpPrompt)">
              <FieldLabel for="common-follow-up-prompt">Общие правила продолжения</FieldLabel>
              <Textarea id="common-follow-up-prompt" v-model="rulesForm.followUpPrompt" class="min-h-40" :maxlength="PROMPT_MAX_LENGTH" :aria-invalid="Boolean(rulesErrors.followUpPrompt)" :disabled="rulesSaving" />
              <FieldDescription>Язык, длина и формат следующей реплики. {{ rulesForm.followUpPrompt.length }}/{{ PROMPT_MAX_LENGTH }} символов.</FieldDescription>
              <FieldError v-if="rulesErrors.followUpPrompt">{{ rulesErrors.followUpPrompt }}</FieldError>
            </Field>
            <Field :data-invalid="Boolean(rulesErrors.analysisPrompt)">
              <FieldLabel for="common-analysis-prompt">Общие правила анализа</FieldLabel>
              <Textarea id="common-analysis-prompt" v-model="rulesForm.analysisPrompt" class="min-h-56" :maxlength="PROMPT_MAX_LENGTH" :aria-invalid="Boolean(rulesErrors.analysisPrompt)" :disabled="rulesSaving" />
              <FieldDescription>Схема JSON, язык и общие критерии анализа. {{ rulesForm.analysisPrompt.length }}/{{ PROMPT_MAX_LENGTH }} символов.</FieldDescription>
              <FieldError v-if="rulesErrors.analysisPrompt">{{ rulesErrors.analysisPrompt }}</FieldError>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter class="justify-end">
          <Button :disabled="loading || rulesSaving" @click="saveRules"><Spinner v-if="rulesSaving" data-icon="inline-start" />Сохранить общие правила</Button>
        </CardFooter>
      </Card>

      <Card>
      <CardHeader>
        <CardTitle>Профили общения</CardTitle>
        <CardDescription>Активные личности доступны пользователям. Личность по умолчанию получает новые назначения.</CardDescription>
        <CardAction><Badge variant="outline">Всего: {{ personalities.length }}</Badge></CardAction>
      </CardHeader>
      <CardContent class="px-0">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Название и ключ</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Пользователей</TableHead>
                <TableHead>Порядок</TableHead>
                <TableHead class="text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody v-if="loading">
              <TableRow v-for="row in 5" :key="row">
                <TableCell v-for="column in 5" :key="column"><Skeleton class="h-6 w-full" /></TableCell>
              </TableRow>
            </TableBody>
            <TableBody v-else>
              <TableRow v-for="personality in personalities" :key="personality.id">
                <TableCell class="min-w-64">
                  <div class="flex flex-col gap-1">
                    <span class="font-medium">{{ personality.name }}</span>
                    <code class="text-xs text-muted-foreground">{{ personality.key }}</code>
                    <span v-if="personality.description" class="max-w-md text-sm text-muted-foreground">{{ personality.description }}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div class="flex flex-wrap gap-1">
                    <Badge :variant="personality.isActive ? 'default' : 'secondary'">{{ personality.isActive ? "Активна" : "Неактивна" }}</Badge>
                    <Badge v-if="personality.isDefault" variant="outline"><Star data-icon="inline-start" />По умолчанию</Badge>
                  </div>
                </TableCell>
                <TableCell>{{ personality.selectedUsersCount }}</TableCell>
                <TableCell>{{ personality.sortOrder }}</TableCell>
                <TableCell>
                  <div class="flex min-w-max justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label="Редактировать личность" :disabled="pendingAction !== null" @click="openEdit(personality)"><Pencil /></Button>
                    <Button v-if="!personality.isActive" variant="outline" size="sm" :disabled="pendingAction !== null" @click="runAction(personality, 'activate')">
                      <Spinner v-if="isPending(personality, 'activate')" data-icon="inline-start" /><Power v-else data-icon="inline-start" />Активировать
                    </Button>
                    <Button v-else variant="outline" size="sm" :disabled="pendingAction !== null || personality.isDefault" @click="deactivateCandidate = personality">
                      <PowerOff data-icon="inline-start" />Деактивировать
                    </Button>
                    <Button v-if="!personality.isDefault" variant="outline" size="sm" :disabled="pendingAction !== null" @click="runAction(personality, 'set-default')">
                      <Spinner v-if="isPending(personality, 'set-default')" data-icon="inline-start" /><Star v-else data-icon="inline-start" />По умолчанию
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <Empty v-if="!loading && !personalities.length">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Drama /></EmptyMedia>
            <EmptyTitle>Личностей пока нет</EmptyTitle>
            <EmptyDescription>Создайте первый профиль общения и назначьте его по умолчанию.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
      <CardFooter class="justify-between">
        <p class="text-sm text-muted-foreground">Удаление недоступно: используйте деактивацию.</p>
        <Button v-if="!loading && !personalities.length" variant="outline" @click="openCreate"><Plus data-icon="inline-start" />Создать</Button>
      </CardFooter>
      </Card>
    </template>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-3xl" :show-close-button="!saving" @escape-key-down="saving && $event.preventDefault()" @pointer-down-outside="saving && $event.preventDefault()">
        <DialogHeader>
          <DialogTitle>{{ editing ? "Редактировать личность" : "Новая личность" }}</DialogTitle>
          <DialogDescription>{{ editing ? "Обновите описание и стилевые инструкции. Ключ и статусы изменяются отдельно." : "Создайте профиль поведения бота. Ключ нельзя будет изменить после создания." }}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldGroup class="sm:grid sm:grid-cols-2">
            <Field :data-invalid="Boolean(errors.key)" :data-disabled="Boolean(editing)">
              <FieldLabel for="personality-key">Ключ</FieldLabel>
              <Input id="personality-key" v-model="form.key" :maxlength="KEY_MAX_LENGTH" :aria-invalid="Boolean(errors.key)" :disabled="saving || Boolean(editing)" placeholder="friendly_tutor" />
              <FieldDescription>До {{ KEY_MAX_LENGTH }} символов: a–z, 0–9, «-» и «_».</FieldDescription>
              <FieldError v-if="errors.key">{{ errors.key }}</FieldError>
            </Field>
            <Field :data-invalid="Boolean(errors.name)">
              <FieldLabel for="personality-name">Название</FieldLabel>
              <Input id="personality-name" v-model="form.name" :maxlength="NAME_MAX_LENGTH" :aria-invalid="Boolean(errors.name)" :disabled="saving" placeholder="Дружелюбный преподаватель" />
              <FieldDescription>До {{ NAME_MAX_LENGTH }} символов.</FieldDescription>
              <FieldError v-if="errors.name">{{ errors.name }}</FieldError>
            </Field>
          </FieldGroup>
          <Field :data-invalid="Boolean(errors.description)">
            <FieldLabel for="personality-description">Описание</FieldLabel>
            <Input id="personality-description" v-model="form.description" :maxlength="DESCRIPTION_MAX_LENGTH" :aria-invalid="Boolean(errors.description)" :disabled="saving" placeholder="Кратко объясните назначение профиля" />
            <FieldDescription>{{ form.description.length }}/{{ DESCRIPTION_MAX_LENGTH }} символов.</FieldDescription>
            <FieldError v-if="errors.description">{{ errors.description }}</FieldError>
          </Field>
          <Field :data-invalid="Boolean(errors.followUpStylePrompt)">
            <FieldLabel for="follow-up-prompt">Стиль продолжения</FieldLabel>
            <Textarea id="follow-up-prompt" v-model="form.followUpStylePrompt" class="min-h-48" :maxlength="PROMPT_MAX_LENGTH" :aria-invalid="Boolean(errors.followUpStylePrompt)" :disabled="saving" placeholder="Только особенности тона и характера следующей реплики" />
            <FieldDescription>{{ form.followUpStylePrompt.length }}/{{ PROMPT_MAX_LENGTH }} символов.</FieldDescription>
            <FieldError v-if="errors.followUpStylePrompt">{{ errors.followUpStylePrompt }}</FieldError>
          </Field>
          <Field :data-invalid="Boolean(errors.analysisStylePrompt)">
            <FieldLabel for="analysis-prompt">Стиль анализа</FieldLabel>
            <Textarea id="analysis-prompt" v-model="form.analysisStylePrompt" class="min-h-48" :maxlength="PROMPT_MAX_LENGTH" :aria-invalid="Boolean(errors.analysisStylePrompt)" :disabled="saving" placeholder="Только особенности тона и подачи анализа" />
            <FieldDescription>{{ form.analysisStylePrompt.length }}/{{ PROMPT_MAX_LENGTH }} символов.</FieldDescription>
            <FieldError v-if="errors.analysisStylePrompt">{{ errors.analysisStylePrompt }}</FieldError>
          </Field>
          <FieldGroup class="sm:grid sm:grid-cols-2">
            <Field :data-invalid="Boolean(errors.sortOrder)">
              <FieldLabel for="personality-order">Порядок</FieldLabel>
              <Input id="personality-order" v-model.number="form.sortOrder" type="number" min="0" :max="SORT_ORDER_MAX" step="1" :aria-invalid="Boolean(errors.sortOrder)" :disabled="saving" />
              <FieldDescription>Меньшие значения показываются первыми.</FieldDescription>
              <FieldError v-if="errors.sortOrder">{{ errors.sortOrder }}</FieldError>
            </Field>
            <Field v-if="!editing" orientation="horizontal">
              <div class="flex flex-col gap-1">
                <FieldLabel for="personality-active">Активна</FieldLabel>
                <FieldDescription>Сразу сделать профиль доступным пользователям.</FieldDescription>
              </div>
              <Switch id="personality-active" v-model="form.isActive" :disabled="saving" />
            </Field>
          </FieldGroup>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" :disabled="saving" @click="dialogOpen = false">Отмена</Button>
          <Button :disabled="saving" @click="save"><Spinner v-if="saving" data-icon="inline-start" />Сохранить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="Boolean(deactivateCandidate)" @update:open="(open) => { if (!open && pendingAction === null) deactivateCandidate = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Деактивировать личность?</AlertDialogTitle>
          <AlertDialogDescription>
            Личность «{{ deactivateCandidate?.name }}» станет недоступна. {{ deactivateCandidate?.selectedUsersCount ?? 0 }} назначенных пользователей будут переведены на активную личность по умолчанию.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="pendingAction !== null">Отмена</AlertDialogCancel>
          <AlertDialogAction variant="destructive" :disabled="pendingAction !== null" @click.prevent="deactivateCandidate && runAction(deactivateCandidate, 'deactivate')">
            <Spinner v-if="deactivateCandidate && isPending(deactivateCandidate, 'deactivate')" data-icon="inline-start" />Деактивировать
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>
