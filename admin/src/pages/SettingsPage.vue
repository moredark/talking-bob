<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { isAxiosError } from "axios";
import { Database, RefreshCw, RotateCcw, Save, Settings2, ShieldCheck } from "@lucide/vue";
import { toast } from "vue-sonner";
import { adminApi } from "../api/admin.api";
import StatePanel from "../components/StatePanel.vue";
import type {
  AdminRuntimeSettingEntry,
  AdminRuntimeSettings,
  RuntimeSettingValue,
} from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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

const settings = ref<AdminRuntimeSettings | null>(null);
const loading = ref(true);
const loadError = ref(false);
const saving = ref<"product" | "infrastructure" | null>(null);
const infrastructureConfirmationOpen = ref(false);
const conflict = ref<"product" | "infrastructure" | null>(null);
const drafts = reactive<Record<"product" | "infrastructure", Record<string, string>>>({
  product: {},
  infrastructure: {},
});
const fieldErrors = reactive<Record<string, string>>({});

const productDirty = computed(() => isDirty("product"));
const infrastructureDirty = computed(() => isDirty("infrastructure"));

function draftValue(entry: AdminRuntimeSettingEntry) {
  return entry.overrideValue === null ? "" : String(entry.overrideValue);
}

function initializeDraft(group: "product" | "infrastructure") {
  const source = settings.value?.[group];
  if (!source) return;
  drafts[group] = Object.fromEntries(source.entries.map((entry) => [entry.key, draftValue(entry)]));
}

function isDirty(group: "product" | "infrastructure") {
  return Boolean(settings.value?.[group].entries.some((entry) => drafts[group][entry.key] !== draftValue(entry)));
}

function resetEntry(group: "product" | "infrastructure", key: string) {
  drafts[group][key] = "";
  delete fieldErrors[key];
}

function restoreGroup(group: "product" | "infrastructure") {
  initializeDraft(group);
  conflict.value = null;
  for (const entry of settings.value?.[group].entries ?? []) delete fieldErrors[entry.key];
}

function parseEntry(entry: AdminRuntimeSettingEntry, raw: string): RuntimeSettingValue | null {
  const value = raw.trim();
  delete fieldErrors[entry.key];
  if (!value) return null;
  if (entry.type === "string") {
    if (entry.max !== undefined && value.length > entry.max) {
      fieldErrors[entry.key] = `Не более ${entry.max} символов`;
      return null;
    }
    return value;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fieldErrors[entry.key] = "Введите целое число";
    return null;
  }
  if (entry.min !== undefined && parsed < entry.min) fieldErrors[entry.key] = `Минимум: ${entry.min}`;
  if (entry.max !== undefined && parsed > entry.max) fieldErrors[entry.key] = `Максимум: ${entry.max}`;
  return parsed;
}

function buildValues(group: "product" | "infrastructure") {
  const entries = settings.value?.[group].entries ?? [];
  for (const entry of entries) delete fieldErrors[entry.key];
  const values: Record<string, RuntimeSettingValue | null> = {};
  for (const entry of entries) {
    if (drafts[group][entry.key] !== draftValue(entry)) {
      values[entry.key] = parseEntry(entry, drafts[group][entry.key] ?? "");
    }
  }
  return entries.some((entry) => Boolean(fieldErrors[entry.key])) ? null : values;
}

async function load(preserved?: { group: "product" | "infrastructure"; draft: Record<string, string> }) {
  loading.value = true;
  loadError.value = false;
  try {
    settings.value = await adminApi.getRuntimeSettings();
    initializeDraft("product");
    initializeDraft("infrastructure");
    if (preserved) drafts[preserved.group] = preserved.draft;
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function saveGroup(group: "product" | "infrastructure") {
  const values = buildValues(group);
  if (!values || !Object.keys(values).length || !settings.value) return;
  const attemptedDraft = { ...drafts[group] };
  saving.value = group;
  conflict.value = null;
  try {
    const payload = { expectedVersion: settings.value[group].version, values };
    const updated = group === "product"
      ? await adminApi.updateProductSettings(payload)
      : await adminApi.updateInfrastructureSettings(payload);
    settings.value[group] = updated;
    initializeDraft(group);
    toast.success(group === "product" ? "Настройки применены" : "Настройки сохранены до перезапуска");
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 409) {
      await load({ group, draft: attemptedDraft });
      conflict.value = group;
      toast.error("Настройки уже изменились. Проверьте актуальные значения и сохраните снова.");
    } else if (isAxiosError(error) && error.response?.status === 422) {
      toast.error("Проверьте значения настроек");
    } else if (isAxiosError(error) && error.response?.status === 503) {
      toast.error("Хранилище настроек временно недоступно");
    } else {
      toast.error("Не удалось сохранить настройки");
    }
  } finally {
    saving.value = null;
    infrastructureConfirmationOpen.value = false;
  }
}

function requestInfrastructureSave() {
  const values = buildValues("infrastructure");
  if (values && Object.keys(values).length) infrastructureConfirmationOpen.value = true;
}

function sourceLabel(source: string) {
  return { override: "Переопределение", env: "ENV", default: "По умолчанию" }[source] ?? source;
}

function applyLabel(mode: string) {
  return mode === "hot" ? "Применяется сразу" : mode === "restart" ? "После перезапуска" : "Только чтение";
}

function groupFor(entry: AdminRuntimeSettingEntry): "product" | "infrastructure" {
  return entry.applyMode === "hot" ? "product" : "infrastructure";
}

onMounted(() => load());
</script>

<template>
  <section class="flex flex-col gap-6">
    <header class="page-header">
      <div>
        <p class="eyebrow">Конфигурация</p>
        <h1>Runtime-настройки</h1>
        <p>Безопасное управление разрешёнными параметрами без доступа к секретам.</p>
      </div>
      <Button variant="outline" :disabled="loading || saving !== null" @click="load()">
        <RefreshCw data-icon="inline-start" /> Обновить
      </Button>
    </header>

    <StatePanel
      v-if="loadError && !loading"
      title="Не удалось загрузить настройки"
      description="Проверьте соединение с сервером и повторите запрос."
      retry-label="Повторить"
      @retry="load()"
    />

    <template v-else-if="loading || !settings">
      <Card v-for="block in 3" :key="block">
        <CardHeader><Skeleton class="h-6 w-52" /><Skeleton class="h-4 w-80 max-w-full" /></CardHeader>
        <CardContent class="grid gap-4 md:grid-cols-2"><Skeleton v-for="row in 4" :key="row" class="h-24 w-full" /></CardContent>
      </Card>
    </template>

    <template v-else>
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><Settings2 class="size-5" /> Продуктовые лимиты</CardTitle>
          <CardDescription>Версия {{ settings.product.version }}. Новые значения используются со следующего запроса.</CardDescription>
        </CardHeader>
        <CardContent>
          <p v-if="conflict === 'product'" role="alert" class="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            Загружена актуальная версия. Ваш черновик сохранён — проверьте его и нажмите «Применить» ещё раз.
          </p>
          <FieldGroup class="md:grid md:grid-cols-2">
            <Field v-for="entry in settings.product.entries" :key="entry.key" :data-invalid="Boolean(fieldErrors[entry.key])">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel :for="`setting-${entry.key}`">{{ entry.key }}</FieldLabel>
                <div class="flex gap-1"><Badge variant="outline">{{ sourceLabel(entry.source) }}</Badge><Badge variant="secondary">{{ applyLabel(entry.applyMode) }}</Badge></div>
              </div>
              <div class="flex gap-2">
                <Input :id="`setting-${entry.key}`" v-model="drafts[groupFor(entry)][entry.key]" :type="entry.type === 'integer' ? 'number' : 'text'" :min="entry.min" :max="entry.max" :aria-invalid="Boolean(fieldErrors[entry.key])" :disabled="saving !== null" />
                <Button type="button" variant="outline" size="icon" :aria-label="`Сбросить ${entry.key} к ENV или default`" :disabled="saving !== null" @click="resetEntry('product', entry.key)"><RotateCcw /></Button>
              </div>
              <FieldDescription>{{ entry.description }} · эффективно: {{ entry.effectiveValue }}</FieldDescription>
              <FieldError v-if="fieldErrors[entry.key]">{{ fieldErrors[entry.key] }}</FieldError>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter class="justify-end gap-2">
          <Button variant="outline" :disabled="!productDirty || saving !== null" @click="restoreGroup('product')">Отменить</Button>
          <Button :disabled="!productDirty || saving !== null" @click="saveGroup('product')"><Save data-icon="inline-start" /> Применить</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><Database class="size-5" /> Инфраструктура</CardTitle>
          <CardDescription>Версия {{ settings.infrastructure.version }}. Изменения сохраняются как pending и вступят в силу после перезапуска.</CardDescription>
        </CardHeader>
        <CardContent>
          <p v-if="settings.infrastructure.restartRequired" class="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm" role="status">Есть сохранённые изменения, ожидающие перезапуска приложения.</p>
          <p v-if="conflict === 'infrastructure'" role="alert" class="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">Загружена актуальная версия. Проверьте сохранённый черновик и подтвердите его повторно.</p>
          <FieldGroup class="md:grid md:grid-cols-2">
            <Field v-for="entry in settings.infrastructure.entries" :key="entry.key" :data-invalid="Boolean(fieldErrors[entry.key])">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel :for="`setting-${entry.key}`">{{ entry.key }}</FieldLabel>
                <div class="flex gap-1"><Badge variant="outline">{{ sourceLabel(entry.source) }}</Badge><Badge variant="secondary">После перезапуска</Badge></div>
              </div>
              <div class="flex gap-2">
                <Input :id="`setting-${entry.key}`" v-model="drafts[groupFor(entry)][entry.key]" :type="entry.type === 'integer' ? 'number' : 'text'" :min="entry.min" :max="entry.max" :aria-invalid="Boolean(fieldErrors[entry.key])" :disabled="saving !== null" />
                <Button type="button" variant="outline" size="icon" :aria-label="`Сбросить ${entry.key} к ENV или default`" :disabled="saving !== null" @click="resetEntry('infrastructure', entry.key)"><RotateCcw /></Button>
              </div>
              <FieldDescription>{{ entry.description }} · сейчас: {{ entry.effectiveValue }} · после restart: {{ entry.pendingValue }}</FieldDescription>
              <FieldError v-if="fieldErrors[entry.key]">{{ fieldErrors[entry.key] }}</FieldError>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter class="justify-end gap-2">
          <Button variant="outline" :disabled="!infrastructureDirty || saving !== null" @click="restoreGroup('infrastructure')">Отменить</Button>
          <Button :disabled="!infrastructureDirty || saving !== null" @click="requestInfrastructureSave"><Save data-icon="inline-start" /> Сохранить</Button>
        </CardFooter>
      </Card>

      <div class="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Только чтение</CardTitle><CardDescription>Безопасная проекция параметров развёртывания.</CardDescription></CardHeader>
          <CardContent class="space-y-3">
            <div v-for="entry in settings.readonly" :key="entry.key" class="rounded-lg border p-3">
              <div class="flex items-center justify-between gap-3"><code class="text-xs font-semibold">{{ entry.key }}</code><Badge variant="outline">Только чтение</Badge></div>
              <p class="mt-1 text-sm text-muted-foreground">{{ entry.description }}</p>
              <p class="mt-2 text-sm">{{ entry.value ?? (entry.configured ? 'Настроено' : 'Не настроено') }}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle class="flex items-center gap-2"><ShieldCheck class="size-5" /> Секреты</CardTitle><CardDescription>Значения никогда не возвращаются в браузер.</CardDescription></CardHeader>
          <CardContent class="space-y-3">
            <div v-for="entry in settings.secret" :key="entry.key" class="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div><code class="text-xs font-semibold">{{ entry.key }}</code><p class="mt-1 text-sm text-muted-foreground">{{ entry.description }}</p></div>
              <Badge :variant="entry.configured ? 'secondary' : 'destructive'">{{ entry.configured ? 'Настроено' : 'Не настроено' }}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </template>

    <AlertDialog v-model:open="infrastructureConfirmationOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Сохранить инфраструктурные настройки?</AlertDialogTitle>
          <AlertDialogDescription>Текущий процесс продолжит использовать прежние значения. Новая конфигурация станет эффективной только после контролируемого перезапуска приложения.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="saving !== null">Отмена</AlertDialogCancel>
          <AlertDialogAction :disabled="saving !== null" @click="saveGroup('infrastructure')">Подтвердить сохранение</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>
