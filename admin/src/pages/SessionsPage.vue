<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { Eye, MessagesSquare, RotateCcw, Search } from "@lucide/vue";
import { useRoute, useRouter } from "vue-router";
import { adminApi } from "../api/admin.api";
import StatePanel from "../components/StatePanel.vue";
import type {
  AdminConversationStatus,
  AdminGenerationStatus,
  AdminSessionDeliveryStatus,
  AdminSessionListItem,
  AdminSessionsFilters,
  AdminSessionSource,
} from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface FilterForm {
  userId: string;
  topic: string;
  source: "all" | AdminSessionSource;
  deliveryStatus: "all" | AdminSessionDeliveryStatus;
  conversationStatus: "all" | AdminConversationStatus;
  generationStatus: "all" | AdminGenerationStatus;
  from: string;
  to: string;
}

const route = useRoute();
const router = useRouter();
const queryUserId =
  typeof route.query.userId === "string" ? route.query.userId : "";
const emptyFilters: FilterForm = {
  userId: "",
  topic: "",
  source: "all",
  deliveryStatus: "all",
  conversationStatus: "all",
  generationStatus: "all",
  from: "",
  to: "",
};
const filters = reactive<FilterForm>({
  ...emptyFilters,
  userId: queryUserId,
});
const sessions = ref<AdminSessionListItem[]>([]);
const loading = ref(true);
const error = ref(false);
const pagination = reactive({ page: 1, limit: 50, total: 0 });
const appliedFilters = ref<AdminSessionsFilters>(buildFilters());
let requestSequence = 0;

const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleString("ru-RU") : "—";

function normalized(value: string) {
  const result = value.trim();
  return result || undefined;
}

function asIso(value: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildFilters(): AdminSessionsFilters {
  return {
    userId: normalized(filters.userId),
    topic: normalized(filters.topic),
    source: filters.source === "all" ? undefined : filters.source,
    deliveryStatus:
      filters.deliveryStatus === "all" ? undefined : filters.deliveryStatus,
    conversationStatus:
      filters.conversationStatus === "all"
        ? undefined
        : filters.conversationStatus,
    generationStatus:
      filters.generationStatus === "all"
        ? undefined
        : filters.generationStatus,
    from: asIso(filters.from),
    to: asIso(filters.to),
  };
}

async function load(page = pagination.page) {
  const requestId = ++requestSequence;
  loading.value = true;
  error.value = false;
  try {
    const result = await adminApi.getSessions(
      page,
      pagination.limit,
      appliedFilters.value,
    );
    if (requestId !== requestSequence) return;
    sessions.value = result.data;
    Object.assign(pagination, {
      page: result.page,
      limit: result.limit,
      total: result.total,
    });
  } catch {
    if (requestId === requestSequence) error.value = true;
  } finally {
    if (requestId === requestSequence) loading.value = false;
  }
}

function applyFilters() {
  appliedFilters.value = buildFilters();
  void router.replace({
    query: appliedFilters.value.userId
      ? { userId: appliedFilters.value.userId }
      : {},
  });
  void load(1);
}

function resetFilters() {
  Object.assign(filters, emptyFilters);
  appliedFilters.value = {};
  void router.replace({ query: {} });
  void load(1);
}

function showDetail(id: string) {
  void router.push({ name: "session-detail", params: { id } });
}

function sourceLabel(value: AdminSessionSource) {
  return { manual: "Вручную", scheduled: "По расписанию", legacy: "Legacy" }[
    value
  ];
}

function deliveryLabel(value: AdminSessionDeliveryStatus) {
  return { pending: "Ожидает", sent: "Отправлено", failed: "Ошибка" }[value];
}

function conversationLabel(value: AdminConversationStatus) {
  return value === "open" ? "Открыта" : "Закрыта";
}

function generationLabel(value: AdminGenerationStatus | null) {
  if (value === null) return "Нет ответа";
  return {
    generating: "Генерация",
    generated: "Готово",
    failed: "Ошибка",
  }[value];
}

watch(
  () => route.query.userId,
  (value) => {
    const userId = typeof value === "string" ? value : "";
    if (userId === filters.userId) return;
    filters.userId = userId;
    appliedFilters.value = buildFilters();
    void load(1);
  },
);

onMounted(() => load(1));
</script>

<template>
  <section class="flex flex-col gap-6">
    <header class="page-header">
      <div>
        <p class="eyebrow">Диалоги</p>
        <h1>Сессии</h1>
        <p>Жизненный цикл вопросов, разговоров и отчётов.</p>
      </div>
    </header>

    <form @submit.prevent="applyFilters" @reset.prevent="resetFilters">
      <Card>
        <CardHeader>
          <CardTitle>Фильтры</CardTitle>
          <CardDescription>
            Фильтры выполняются на сервере без загрузки содержимого диалогов.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup class="md:grid md:grid-cols-2 xl:grid-cols-4">
            <Field>
              <FieldLabel for="session-user">User ID</FieldLabel>
              <Input id="session-user" v-model="filters.userId" placeholder="UUID пользователя" />
            </Field>
            <Field>
              <FieldLabel for="session-topic">Тема</FieldLabel>
              <Input id="session-topic" v-model="filters.topic" placeholder="Часть названия темы" />
            </Field>
            <Field>
              <FieldLabel for="session-source">Источник</FieldLabel>
              <Select v-model="filters.source">
                <SelectTrigger id="session-source"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">Любой источник</SelectItem>
                    <SelectItem value="manual">Вручную</SelectItem>
                    <SelectItem value="scheduled">По расписанию</SelectItem>
                    <SelectItem value="legacy">Legacy</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="session-delivery">Доставка вопроса</FieldLabel>
              <Select v-model="filters.deliveryStatus">
                <SelectTrigger id="session-delivery"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">Любой статус</SelectItem>
                    <SelectItem value="pending">Ожидает</SelectItem>
                    <SelectItem value="sent">Отправлено</SelectItem>
                    <SelectItem value="failed">Ошибка</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="session-conversation">Разговор</FieldLabel>
              <Select v-model="filters.conversationStatus">
                <SelectTrigger id="session-conversation"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">Любой статус</SelectItem>
                    <SelectItem value="open">Открыт</SelectItem>
                    <SelectItem value="closed">Закрыт</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="session-generation">Генерация отчёта</FieldLabel>
              <Select v-model="filters.generationStatus">
                <SelectTrigger id="session-generation"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">Любой статус</SelectItem>
                    <SelectItem value="generating">Генерация</SelectItem>
                    <SelectItem value="generated">Готово</SelectItem>
                    <SelectItem value="failed">Ошибка</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="session-from">С даты</FieldLabel>
              <Input id="session-from" v-model="filters.from" type="datetime-local" />
            </Field>
            <Field>
              <FieldLabel for="session-to">По дату</FieldLabel>
              <Input id="session-to" v-model="filters.to" type="datetime-local" />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter class="flex flex-wrap justify-end gap-2">
          <Button type="reset" variant="outline" :disabled="loading">
            <RotateCcw data-icon="inline-start" />
            Сбросить
          </Button>
          <Button type="submit" :disabled="loading">
            <Search data-icon="inline-start" />
            Применить
          </Button>
        </CardFooter>
      </Card>
    </form>

    <StatePanel
      v-if="error && !loading"
      title="Не удалось загрузить сессии"
      description="Проверьте соединение и повторите запрос."
      retry-label="Повторить"
      @retry="load()"
    />

    <Card v-else>
      <CardHeader>
        <CardTitle>Сессии</CardTitle>
        <CardDescription>Найдено: {{ pagination.total }}</CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Создана</TableHead>
                <TableHead>Пользователь</TableHead>
                <TableHead>Тема</TableHead>
                <TableHead>Источник</TableHead>
                <TableHead>Доставка</TableHead>
                <TableHead>Разговор</TableHead>
                <TableHead>Отчёт</TableHead>
                <TableHead>Ходы</TableHead>
                <TableHead><span class="sr-only">Детали</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody v-if="loading">
              <TableRow v-for="row in 6" :key="row">
                <TableCell v-for="cell in 9" :key="cell">
                  <Skeleton class="h-5 w-full" />
                </TableCell>
              </TableRow>
            </TableBody>
            <TableBody v-else>
              <TableRow v-for="row in sessions" :key="row.id">
                <TableCell class="whitespace-nowrap">{{ formatDate(row.createdAt) }}</TableCell>
                <TableCell>
                  {{ row.user.username || "Без username" }}
                  <div><code>{{ row.user.telegramId }}</code></div>
                </TableCell>
                <TableCell>{{ row.prompt.topic }}</TableCell>
                <TableCell><Badge variant="outline">{{ sourceLabel(row.source) }}</Badge></TableCell>
                <TableCell>
                  <Badge :variant="row.deliveryStatus === 'failed' ? 'destructive' : 'secondary'">
                    {{ deliveryLabel(row.deliveryStatus) }}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge :variant="row.conversationStatus === 'open' ? 'default' : 'outline'">
                    {{ conversationLabel(row.conversationStatus) }}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div class="flex flex-col items-start gap-1">
                    <Badge :variant="row.generationStatus === 'failed' ? 'destructive' : 'secondary'">
                      {{ generationLabel(row.generationStatus) }}
                    </Badge>
                    <Badge v-if="row.contentPurged" variant="outline">Контент очищен</Badge>
                  </div>
                </TableCell>
                <TableCell>{{ row.turnCount }}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Открыть сессию"
                    @click="showDetail(row.id)"
                  >
                    <Eye />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Empty v-if="!loading && !sessions.length">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessagesSquare /></EmptyMedia>
              <EmptyTitle>Сессий нет</EmptyTitle>
              <EmptyDescription>
                По выбранным фильтрам сессии отсутствуют.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </CardContent>
      <CardFooter v-if="pagination.total > pagination.limit" class="border-t p-4">
        <Pagination
          :page="pagination.page"
          :total="pagination.total"
          :items-per-page="pagination.limit"
          :sibling-count="1"
          @update:page="load"
        >
          <PaginationContent v-slot="{ items }">
            <PaginationPrevious />
            <template
              v-for="(item, itemIndex) in items"
              :key="item.type === 'page' ? item.value : 'ellipsis-' + itemIndex"
            >
              <PaginationItem
                v-if="item.type === 'page'"
                :value="item.value"
                :is-active="item.value === pagination.page"
              >
                {{ item.value }}
              </PaginationItem>
              <PaginationEllipsis
                v-if="item.type === 'ellipsis'"
                :index="itemIndex"
              />
            </template>
            <PaginationNext />
          </PaginationContent>
        </Pagination>
      </CardFooter>
    </Card>
  </section>
</template>
