<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { isAxiosError } from "axios";
import { ArrowLeft, Eye, Megaphone, Send } from "@lucide/vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { adminApi } from "../api/admin.api";
import type { BroadcastActivity, BroadcastMode, BroadcastPreview, CreateBroadcastDto, LanguageLevel } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const LANGUAGE_LEVELS: LanguageLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
const router = useRouter();
const form = reactive({
  content: "",
  languageLevels: [] as LanguageLevel[],
  activity: "any" as BroadcastActivity,
  dailyPromptEnabled: "any" as "any" | "true" | "false",
  mode: "immediate" as BroadcastMode,
  scheduledFor: "",
});
const preview = ref<BroadcastPreview | null>(null);
const previewSignature = ref<string | null>(null);
const previewing = ref(false);
const creating = ref(false);
const confirmOpen = ref(false);
const requestError = ref("");

const utf16Length = computed(() => form.content.length);
const contentError = computed(() => {
  if (!form.content.trim()) return "Введите текст сообщения";
  if (utf16Length.value > 4096) return "Telegram принимает не более 4096 UTF-16 символов";
  return "";
});
const scheduleError = computed(() => form.mode === "scheduled" && !form.scheduledFor ? "Укажите дату и время по Москве" : "");
const currentSignature = computed(() => JSON.stringify(buildPayload()));
const previewIsCurrent = computed(() => Boolean(preview.value && previewSignature.value === currentSignature.value));
const canCreate = computed(() => previewIsCurrent.value && (preview.value?.audienceCount ?? 0) > 0);
const canPreview = computed(() => !contentError.value && !scheduleError.value && !previewing.value && !creating.value);

function buildPayload(): CreateBroadcastDto {
  return {
    content: form.content,
    filters: {
      languageLevels: [...form.languageLevels],
      activity: form.activity,
      dailyPromptEnabled: form.dailyPromptEnabled === "any" ? "any" : form.dailyPromptEnabled === "true",
    },
    mode: form.mode,
    scheduledFor: form.mode === "scheduled" ? form.scheduledFor : null,
  };
}

watch(currentSignature, () => {
  if (previewSignature.value !== currentSignature.value) preview.value = null;
  requestError.value = "";
});

function errorMessage(error: unknown, fallback: string) {
  if (!isAxiosError(error)) return fallback;
  if (error.response?.status === 422) return "Проверьте текст, фильтры и время отправки";
  if (!error.response) return "Сервер недоступен. Проверьте соединение.";
  return fallback;
}

async function requestPreview() {
  if (!canPreview.value) return;
  previewing.value = true;
  requestError.value = "";
  const signature = currentSignature.value;
  try {
    const result = await adminApi.previewBroadcast(buildPayload());
    if (signature !== currentSignature.value) return;
    preview.value = result;
    previewSignature.value = signature;
  } catch (error) {
    if (signature === currentSignature.value) {
      requestError.value = errorMessage(error, "Не удалось рассчитать аудиторию");
    }
  } finally {
    previewing.value = false;
  }
}

function updateMode(value: unknown) {
  if (value === "immediate" || value === "scheduled") form.mode = value;
}

async function createBroadcast() {
  if (!canCreate.value) return;
  creating.value = true;
  requestError.value = "";
  try {
    const result = await adminApi.createBroadcast(buildPayload());
    toast.success("Рассылка создана");
    await router.push({ name: "broadcast-detail", params: { id: result.id } });
  } catch (error) {
    requestError.value = errorMessage(error, "Не удалось создать рассылку");
    toast.error(requestError.value);
  } finally {
    creating.value = false;
    confirmOpen.value = false;
  }
}

function formatUtc(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "long", timeZone: "UTC" }).format(new Date(value));
}
</script>

<template>
  <section class="flex flex-col gap-6">
    <header class="page-header">
      <div><p class="eyebrow">Коммуникации</p><h1>Новая рассылка</h1><p>Сначала рассчитайте предварительную аудиторию, затем подтвердите создание.</p></div>
      <Button variant="outline" :disabled="creating" @click="router.push({ name: 'broadcasts' })"><ArrowLeft data-icon="inline-start" />К списку</Button>
    </header>

    <form @submit.prevent="requestPreview">
      <Card>
        <CardHeader><CardTitle>Сообщение и аудитория</CardTitle><CardDescription>Plain text без форматирования и разбиения на части. Отписавшиеся от анонсов всегда исключаются.</CardDescription></CardHeader>
        <CardContent>
          <FieldGroup>
            <Field :data-invalid="Boolean(contentError)" :data-disabled="previewing || creating">
              <div class="flex items-center justify-between gap-3"><FieldLabel for="broadcast-content">Текст сообщения</FieldLabel><Badge :variant="utf16Length > 4096 ? 'destructive' : 'outline'">{{ utf16Length }} / 4096 UTF-16</Badge></div>
              <Textarea id="broadcast-content" v-model="form.content" rows="8" :aria-invalid="Boolean(contentError)" :disabled="previewing || creating" placeholder="Напишите анонс…" />
              <FieldDescription>Текст отправится одним Telegram-сообщением без parse_mode.</FieldDescription>
              <FieldError v-if="contentError">{{ contentError }}</FieldError>
            </Field>

            <Field>
              <FieldLabel id="language-levels-label">Уровни языка</FieldLabel>
              <ToggleGroup v-model="form.languageLevels" type="multiple" variant="outline" :spacing="2" class="flex-wrap" aria-labelledby="language-levels-label" :disabled="previewing || creating">
                <ToggleGroupItem v-for="level in LANGUAGE_LEVELS" :key="level" :value="level">{{ level }}</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>Если ничего не выбрано, подходят все уровни.</FieldDescription>
            </Field>

            <FieldGroup class="md:grid md:grid-cols-2">
              <Field><FieldLabel for="broadcast-activity">Активность</FieldLabel><Select v-model="form.activity" :disabled="previewing || creating"><SelectTrigger id="broadcast-activity"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="any">Любая</SelectItem><SelectItem value="7d">За 7 дней</SelectItem><SelectItem value="30d">За 30 дней</SelectItem><SelectItem value="90d">За 90 дней</SelectItem><SelectItem value="never">Никогда не отвечали</SelectItem></SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel for="broadcast-daily">Ежедневные вопросы</FieldLabel><Select v-model="form.dailyPromptEnabled" :disabled="previewing || creating"><SelectTrigger id="broadcast-daily"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="any">Не учитывать</SelectItem><SelectItem value="true">Включены</SelectItem><SelectItem value="false">Выключены</SelectItem></SelectGroup></SelectContent></Select></Field>
            </FieldGroup>

            <Field>
              <FieldLabel id="broadcast-mode-label">Когда отправить</FieldLabel>
              <ToggleGroup :model-value="form.mode" type="single" variant="outline" :spacing="2" aria-labelledby="broadcast-mode-label" :disabled="previewing || creating" @update:model-value="updateMode"><ToggleGroupItem value="immediate">Сразу</ToggleGroupItem><ToggleGroupItem value="scheduled">По расписанию</ToggleGroupItem></ToggleGroup>
            </Field>
            <Field v-if="form.mode === 'scheduled'" :data-invalid="Boolean(scheduleError)">
              <FieldLabel for="broadcast-schedule">Дата и время (Москва, UTC+3)</FieldLabel>
              <Input id="broadcast-schedule" v-model="form.scheduledFor" type="datetime-local" :aria-invalid="Boolean(scheduleError)" :disabled="previewing || creating" />
              <FieldDescription>Сервер сохранит московское wall time и однозначный UTC instant.</FieldDescription>
              <FieldError v-if="scheduleError">{{ scheduleError }}</FieldError>
            </Field>
          </FieldGroup>

          <p v-if="requestError" class="mt-4 text-sm text-destructive" role="alert">{{ requestError }}</p>
        </CardContent>
        <CardFooter class="justify-end"><Button type="submit" variant="outline" :disabled="!canPreview"><Spinner v-if="previewing" data-icon="inline-start" /><Eye v-else data-icon="inline-start" />{{ previewing ? 'Расчёт…' : 'Предпросмотр аудитории' }}</Button></CardFooter>
      </Card>
    </form>

    <Card v-if="previewIsCurrent && preview">
      <CardHeader><CardTitle class="flex items-center gap-2"><Megaphone />Предпросмотр готов</CardTitle><CardDescription>Результат предварительный: при создании сервер заново зафиксирует актуальную аудиторию.</CardDescription></CardHeader>
      <CardContent class="grid gap-4 md:grid-cols-3">
        <div><p class="text-sm text-muted-foreground">Получателей</p><p class="text-2xl font-semibold">{{ preview.audienceCount }}</p></div>
        <div><p class="text-sm text-muted-foreground">Москва</p><p>{{ preview.normalized.scheduledFor ?? 'Сразу' }}</p></div>
        <div><p class="text-sm text-muted-foreground">UTC instant</p><p>{{ formatUtc(preview.normalized.scheduledAt) }}</p></div>
      </CardContent>
      <CardFooter class="justify-end"><Button :disabled="creating || !canCreate" @click="confirmOpen = true"><Send data-icon="inline-start" />Создать рассылку</Button></CardFooter>
    </Card>

    <AlertDialog v-model:open="confirmOpen">
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Создать рассылку?</AlertDialogTitle><AlertDialogDescription>Сервер повторно рассчитает и атомарно зафиксирует аудиторию. После начала отправки отмена станет недоступна.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel :disabled="creating">Вернуться</AlertDialogCancel><AlertDialogAction :disabled="creating || !canCreate" @click="createBroadcast"><Spinner v-if="creating" data-icon="inline-start" />Подтвердить</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>
</template>
