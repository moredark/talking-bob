<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { isAxiosError } from "axios";
import { ArrowLeft, Ban, Megaphone, RefreshCw, UserRound } from "@lucide/vue";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { adminApi } from "../api/admin.api";
import StatePanel from "../components/StatePanel.vue";
import type { BroadcastDetail, BroadcastRecipientStatus, BroadcastStatus } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type ErrorKind = "not-found" | "unauthorized" | "network" | "server" | "unknown";
const route = useRoute();
const router = useRouter();
const id = computed(() => String(route.params.id));
const broadcast = ref<BroadcastDetail | null>(null);
const loading = ref(true);
const errorKind = ref<ErrorKind | null>(null);
const recipientStatus = ref<"all" | BroadcastRecipientStatus>("all");
const cancelling = ref(false);
const cancelOpen = ref(false);
let requestSequence = 0;

const errorTitle = computed(() => ({
  "not-found": "Рассылка не найдена",
  unauthorized: "Сессия администратора истекла",
  network: "Сервер недоступен",
  server: "Ошибка сервера",
  unknown: "Не удалось загрузить рассылку",
}[errorKind.value ?? "unknown"]));
const errorDescription = computed(() => errorKind.value === "not-found" ? "Возможно, рассылка была удалена по retention-политике." : "Повторите запрос или вернитесь к списку.");

function classifyError(error: unknown): ErrorKind {
  if (!isAxiosError(error)) return "unknown";
  if (!error.response) return "network";
  if (error.response.status === 404) return "not-found";
  if (error.response.status === 401 || error.response.status === 403) return "unauthorized";
  if (error.response.status >= 500) return "server";
  return "unknown";
}

async function load(recipientPage = broadcast.value?.recipients.page ?? 1) {
  const requestId = ++requestSequence;
  loading.value = true;
  errorKind.value = null;
  try {
    const result = await adminApi.getBroadcastById(
      id.value,
      recipientPage,
      broadcast.value?.recipients.limit ?? 50,
      { recipientStatus: recipientStatus.value === "all" ? undefined : recipientStatus.value },
    );
    if (requestId === requestSequence) broadcast.value = result;
  } catch (error) {
    if (requestId === requestSequence) errorKind.value = classifyError(error);
  } finally {
    if (requestId === requestSequence) loading.value = false;
  }
}

async function applyRecipientFilter() {
  await load(1);
}

async function cancelBroadcast() {
  if (!broadcast.value || broadcast.value.status !== "queued") return;
  cancelling.value = true;
  try {
    await adminApi.cancelBroadcast(id.value);
    await load(1);
    toast.success("Рассылка отменена");
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 409) {
      await load(1);
      toast.error("Отправка уже началась — отмена больше недоступна");
    } else {
      toast.error("Не удалось отменить рассылку");
    }
  } finally {
    cancelling.value = false;
    cancelOpen.value = false;
  }
}

function statusLabel(status: BroadcastStatus | BroadcastRecipientStatus) {
  return {
    queued: "В очереди", processing: "Отправляется", completed: "Завершена", completed_with_errors: "С ошибками", cancelled: "Отменена",
    pending: "Ожидает", sent: "Отправлено", failed: "Ошибка", ambiguous: "Неоднозначно", skipped: "Пропущено",
  }[status];
}

function statusVariant(status: BroadcastStatus | BroadcastRecipientStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed" || status === "sent") return "default";
  if (status === "failed" || status === "ambiguous" || status === "completed_with_errors") return "destructive";
  if (status === "processing" || status === "pending") return "secondary";
  return "outline";
}

function formatDate(value: string | null, timeZone = "Europe/Moscow") {
  return value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "medium", timeZone }).format(new Date(value)) : "—";
}

function filterDescription() {
  if (!broadcast.value) return "";
  const levels = broadcast.value.filters.languageLevels.length ? broadcast.value.filters.languageLevels.join(", ") : "все уровни";
  return `${levels} · активность: ${broadcast.value.filters.activity} · daily: ${String(broadcast.value.filters.dailyPromptEnabled)}`;
}

onMounted(() => load(1));
watch(id, () => {
  recipientStatus.value = "all";
  broadcast.value = null;
  void load(1);
});
</script>

<template>
  <section class="flex flex-col gap-6">
    <header class="page-header">
      <div><p class="eyebrow">Рассылка</p><h1>Детали доставки</h1><p class="font-mono text-xs">{{ id }}</p></div>
      <div class="flex flex-wrap gap-2"><Button variant="outline" @click="router.push({ name: 'broadcasts' })"><ArrowLeft data-icon="inline-start" />К списку</Button><Button variant="outline" :disabled="loading || cancelling" @click="load()"><RefreshCw data-icon="inline-start" />Обновить</Button></div>
    </header>

    <StatePanel v-if="errorKind && !loading" :title="errorTitle" :description="errorDescription" :retry-label="errorKind === 'not-found' ? undefined : 'Повторить'" @retry="load()" />

    <template v-else-if="loading && !broadcast"><Card v-for="card in 3" :key="card"><CardHeader><Skeleton class="h-6 w-48" /><Skeleton class="h-4 w-72 max-w-full" /></CardHeader><CardContent><Skeleton class="h-28 w-full" /></CardContent></Card></template>

    <template v-else-if="broadcast">
      <Card>
        <CardHeader>
          <div class="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Сводка</CardTitle><CardDescription>Создал {{ broadcast.createdBy.username }} · {{ formatDate(broadcast.createdAt) }}</CardDescription></div><Badge :variant="statusVariant(broadcast.status)">{{ statusLabel(broadcast.status) }}</Badge></div>
        </CardHeader>
        <CardContent class="flex flex-col gap-5">
          <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <div v-for="item in [
              ['Всего', broadcast.counts.total], ['Ожидают', broadcast.counts.pending], ['Отправлено', broadcast.counts.sent],
              ['Ошибки', broadcast.counts.failed], ['Неоднозначно', broadcast.counts.ambiguous], ['Пропущено', broadcast.counts.skipped],
            ]" :key="String(item[0])"><p class="text-sm text-muted-foreground">{{ item[0] }}</p><p class="text-2xl font-semibold">{{ item[1] }}</p></div>
          </div>
          <div class="grid gap-4 md:grid-cols-2"><div><p class="text-sm text-muted-foreground">Москва</p><p>{{ broadcast.mode === 'immediate' ? 'Сразу' : broadcast.scheduledFor }}</p></div><div><p class="text-sm text-muted-foreground">UTC instant</p><p>{{ formatDate(broadcast.scheduledAt, 'UTC') }}</p></div></div>
          <div><p class="text-sm text-muted-foreground">Фильтры снимка</p><p>{{ filterDescription() }}</p></div>
        </CardContent>
        <CardFooter v-if="broadcast.status === 'queued'" class="justify-end"><Button variant="destructive" :disabled="cancelling" @click="cancelOpen = true"><Ban data-icon="inline-start" />Отменить рассылку</Button></CardFooter>
      </Card>

      <Card>
        <CardHeader><CardTitle>Сообщение</CardTitle><CardDescription>Plain text, сохранённый вместе со снимком аудитории.</CardDescription></CardHeader>
        <CardContent>
          <Empty v-if="broadcast.contentPurged || broadcast.content === null"><EmptyHeader><EmptyMedia variant="icon"><Megaphone /></EmptyMedia><EmptyTitle>Содержимое очищено</EmptyTitle><EmptyDescription>90-дневная retention-политика удалила текст и детальные строки получателей; агрегаты сохранены.</EmptyDescription></EmptyHeader></Empty>
          <pre v-else class="whitespace-pre-wrap break-words rounded-lg border p-4 font-sans text-sm">{{ broadcast.content }}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div class="flex flex-wrap items-end justify-between gap-4"><div><CardTitle>Получатели</CardTitle><CardDescription>{{ broadcast.recipients.total }} строк в сохранённом снимке.</CardDescription></div><Field class="w-full sm:w-56"><FieldLabel for="recipient-status">Статус</FieldLabel><Select v-model="recipientStatus" :disabled="loading" @update:model-value="applyRecipientFilter"><SelectTrigger id="recipient-status"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">Любой</SelectItem><SelectItem value="pending">Ожидает</SelectItem><SelectItem value="sent">Отправлено</SelectItem><SelectItem value="failed">Ошибка</SelectItem><SelectItem value="ambiguous">Неоднозначно</SelectItem><SelectItem value="skipped">Пропущено</SelectItem></SelectGroup></SelectContent></Select></Field></div>
        </CardHeader>
        <CardContent>
          <div class="overflow-x-auto">
            <Table><TableHeader><TableRow><TableHead>Пользователь</TableHead><TableHead>Статус</TableHead><TableHead>Попытки</TableHead><TableHead>Последняя ошибка</TableHead><TableHead>Доставка</TableHead></TableRow></TableHeader><TableBody>
              <template v-if="loading"><TableRow v-for="row in 5" :key="row"><TableCell v-for="cell in 5" :key="cell"><Skeleton class="h-5 w-full" /></TableCell></TableRow></template>
              <TableRow v-for="recipient in broadcast.recipients.data" v-else :key="recipient.id">
                <TableCell><Button variant="link" class="h-auto p-0" @click="router.push({ name: 'user-detail', params: { id: recipient.user.id } })">{{ recipient.user.username ? '@' + recipient.user.username : recipient.user.telegramId }}</Button><p class="text-xs text-muted-foreground">{{ recipient.user.languageLevel ?? 'Уровень не указан' }}</p></TableCell>
                <TableCell><Badge :variant="statusVariant(recipient.status)">{{ statusLabel(recipient.status) }}</Badge></TableCell>
                <TableCell>{{ recipient.attemptCount }}</TableCell>
                <TableCell><code v-if="recipient.lastErrorCode" class="text-xs">{{ recipient.lastErrorCode }}</code><span v-else>—</span></TableCell>
                <TableCell>{{ formatDate(recipient.sentAt ?? recipient.deliveryAttemptedAt) }}</TableCell>
              </TableRow>
            </TableBody></Table>
            <Empty v-if="!loading && !broadcast.recipients.data.length"><EmptyHeader><EmptyMedia variant="icon"><UserRound /></EmptyMedia><EmptyTitle>Получателей нет</EmptyTitle><EmptyDescription>{{ broadcast.contentPurged ? 'Детальные строки очищены retention-политикой.' : 'Нет получателей с выбранным статусом.' }}</EmptyDescription></EmptyHeader></Empty>
          </div>
        </CardContent>
        <CardFooter v-if="broadcast.recipients.total > broadcast.recipients.limit" class="border-t p-4"><Pagination :page="broadcast.recipients.page" :total="broadcast.recipients.total" :items-per-page="broadcast.recipients.limit" :sibling-count="1" @update:page="load"><PaginationContent v-slot="{ items }"><PaginationPrevious /><template v-for="(item, itemIndex) in items" :key="item.type === 'page' ? item.value : 'ellipsis-' + itemIndex"><PaginationItem v-if="item.type === 'page'" :value="item.value" :is-active="item.value === broadcast.recipients.page">{{ item.value }}</PaginationItem><PaginationEllipsis v-if="item.type === 'ellipsis'" :index="itemIndex" /></template><PaginationNext /></PaginationContent></Pagination></CardFooter>
      </Card>
    </template>

    <AlertDialog v-model:open="cancelOpen"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Отменить рассылку?</AlertDialogTitle><AlertDialogDescription>Все ожидающие получатели станут пропущенными. Уже начатую обработку или отправленные сообщения отозвать нельзя.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel :disabled="cancelling">Не отменять</AlertDialogCancel><AlertDialogAction :disabled="cancelling" @click="cancelBroadcast"><Spinner v-if="cancelling" data-icon="inline-start" />Подтвердить отмену</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>
</template>
