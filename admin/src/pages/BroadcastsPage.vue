<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { Eye, Megaphone, Plus, RotateCcw, Search } from "@lucide/vue";
import { useRouter } from "vue-router";
import { adminApi } from "../api/admin.api";
import StatePanel from "../components/StatePanel.vue";
import type { BroadcastListFilters, BroadcastListItem, BroadcastStatus } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface FilterForm {
  status: "all" | BroadcastStatus;
  from: string;
  to: string;
}

const router = useRouter();
const broadcasts = ref<BroadcastListItem[]>([]);
const loading = ref(true);
const error = ref(false);
const filters = reactive<FilterForm>({ status: "all", from: "", to: "" });
const appliedFilters = ref<BroadcastListFilters>({});
const pagination = reactive({ page: 1, limit: 20, total: 0 });
let requestSequence = 0;

function asIso(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

function buildFilters(): BroadcastListFilters {
  return {
    status: filters.status === "all" ? undefined : filters.status,
    from: asIso(filters.from),
    to: asIso(filters.to),
  };
}

async function load(page = pagination.page) {
  const requestId = ++requestSequence;
  loading.value = true;
  error.value = false;
  try {
    const result = await adminApi.getBroadcasts(page, pagination.limit, appliedFilters.value);
    if (requestId !== requestSequence) return;
    broadcasts.value = result.data;
    Object.assign(pagination, { page: result.page, limit: result.limit, total: result.total });
  } catch {
    if (requestId === requestSequence) error.value = true;
  } finally {
    if (requestId === requestSequence) loading.value = false;
  }
}

function applyFilters() {
  appliedFilters.value = buildFilters();
  void load(1);
}

function resetFilters() {
  Object.assign(filters, { status: "all", from: "", to: "" });
  appliedFilters.value = {};
  void load(1);
}

function statusLabel(status: BroadcastStatus) {
  return {
    queued: "В очереди",
    processing: "Отправляется",
    completed: "Завершена",
    completed_with_errors: "Завершена с ошибками",
    cancelled: "Отменена",
  }[status];
}

function statusVariant(status: BroadcastStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "completed_with_errors") return "destructive";
  if (status === "processing") return "secondary";
  return "outline";
}

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow" }).format(new Date(value)) : "—";
}

onMounted(() => load(1));
</script>

<template>
  <section class="flex flex-col gap-6">
    <header class="page-header">
      <div>
        <p class="eyebrow">Коммуникации</p>
        <h1>Рассылки</h1>
        <p>Анонсы пользователям с отдельным согласием и контролем доставки.</p>
      </div>
      <Button @click="router.push({ name: 'broadcast-create' })"><Plus data-icon="inline-start" />Новая рассылка</Button>
    </header>

    <form @submit.prevent="applyFilters" @reset.prevent="resetFilters">
      <Card>
        <CardHeader><CardTitle>Фильтры</CardTitle><CardDescription>Список фильтруется на сервере по статусу и времени создания.</CardDescription></CardHeader>
        <CardContent>
          <FieldGroup class="md:grid md:grid-cols-3">
            <Field>
              <FieldLabel for="broadcast-status">Статус</FieldLabel>
              <Select v-model="filters.status">
                <SelectTrigger id="broadcast-status"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="all">Любой статус</SelectItem>
                  <SelectItem value="queued">В очереди</SelectItem>
                  <SelectItem value="processing">Отправляется</SelectItem>
                  <SelectItem value="completed">Завершена</SelectItem>
                  <SelectItem value="completed_with_errors">С ошибками</SelectItem>
                  <SelectItem value="cancelled">Отменена</SelectItem>
                </SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field><FieldLabel for="broadcast-from">С даты</FieldLabel><Input id="broadcast-from" v-model="filters.from" type="datetime-local" /></Field>
            <Field><FieldLabel for="broadcast-to">До даты</FieldLabel><Input id="broadcast-to" v-model="filters.to" type="datetime-local" /></Field>
          </FieldGroup>
        </CardContent>
        <CardFooter class="justify-end gap-2">
          <Button type="reset" variant="outline" :disabled="loading"><RotateCcw data-icon="inline-start" />Сбросить</Button>
          <Button type="submit" :disabled="loading"><Search data-icon="inline-start" />Применить</Button>
        </CardFooter>
      </Card>
    </form>

    <StatePanel v-if="error && !loading" title="Не удалось загрузить рассылки" description="Проверьте соединение и повторите запрос." retry-label="Повторить" @retry="load()" />

    <Card v-else>
      <CardHeader><CardTitle>История</CardTitle><CardDescription>{{ pagination.total }} рассылок с учётом фильтров.</CardDescription></CardHeader>
      <CardContent>
        <div class="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Статус</TableHead><TableHead>Расписание (МСК)</TableHead><TableHead>Аудитория</TableHead><TableHead>Отправлено</TableHead><TableHead>Ошибки</TableHead><TableHead>Создана</TableHead><TableHead class="w-12"><span class="sr-only">Открыть</span></TableHead></TableRow></TableHeader>
            <TableBody>
              <template v-if="loading"><TableRow v-for="row in 5" :key="row"><TableCell v-for="cell in 7" :key="cell"><Skeleton class="h-5 w-full" /></TableCell></TableRow></template>
              <TableRow v-for="row in broadcasts" v-else :key="row.id">
                <TableCell><Badge :variant="statusVariant(row.status)">{{ statusLabel(row.status) }}</Badge></TableCell>
                <TableCell>{{ row.mode === 'immediate' ? 'Сразу' : row.scheduledFor }}<p class="text-xs text-muted-foreground">{{ formatDate(row.scheduledAt) }}</p></TableCell>
                <TableCell>{{ row.counts.total }}</TableCell>
                <TableCell>{{ row.counts.sent }}</TableCell>
                <TableCell>{{ row.counts.failed + row.counts.ambiguous }}</TableCell>
                <TableCell>{{ formatDate(row.createdAt) }}</TableCell>
                <TableCell><Button variant="ghost" size="icon-sm" aria-label="Открыть рассылку" @click="router.push({ name: 'broadcast-detail', params: { id: row.id } })"><Eye /></Button></TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Empty v-if="!loading && !broadcasts.length"><EmptyHeader><EmptyMedia variant="icon"><Megaphone /></EmptyMedia><EmptyTitle>Рассылок нет</EmptyTitle><EmptyDescription>По выбранным фильтрам ничего не найдено.</EmptyDescription></EmptyHeader></Empty>
        </div>
      </CardContent>
      <CardFooter v-if="pagination.total > pagination.limit" class="border-t p-4">
        <Pagination :page="pagination.page" :total="pagination.total" :items-per-page="pagination.limit" :sibling-count="1" @update:page="load">
          <PaginationContent v-slot="{ items }"><PaginationPrevious /><template v-for="(item, itemIndex) in items" :key="item.type === 'page' ? item.value : 'ellipsis-' + itemIndex"><PaginationItem v-if="item.type === 'page'" :value="item.value" :is-active="item.value === pagination.page">{{ item.value }}</PaginationItem><PaginationEllipsis v-if="item.type === 'ellipsis'" :index="itemIndex" /></template><PaginationNext /></PaginationContent>
        </Pagination>
      </CardFooter>
    </Card>
  </section>
</template>
