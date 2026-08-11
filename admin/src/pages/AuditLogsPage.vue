<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { Eye, RotateCcw, Search, ScrollText } from "@lucide/vue";
import { useRouter } from "vue-router";
import { adminApi } from "../api/admin.api";
import StatePanel from "../components/StatePanel.vue";
import type {
  AdminAuditListItem,
  AdminAuditOutcome,
  AuditLogFilters,
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
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  outcome: "all" | AdminAuditOutcome;
  from: string;
  to: string;
}

const emptyFilters: FilterForm = {
  actorId: "",
  action: "",
  entityType: "",
  entityId: "",
  outcome: "all",
  from: "",
  to: "",
};

const router = useRouter();
const logs = ref<AdminAuditListItem[]>([]);
const loading = ref(true);
const error = ref(false);
const filters = reactive<FilterForm>({ ...emptyFilters });
const appliedFilters = ref<AuditLogFilters>({});
const pagination = reactive({ page: 1, limit: 50, total: 0 });
let requestSequence = 0;

const formatDate = (value: string) =>
  new Date(value).toLocaleString("ru-RU");

function normalized(value: string) {
  const result = value.trim();
  return result || undefined;
}

function asIso(value: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildFilters(): AuditLogFilters {
  return {
    actorId: normalized(filters.actorId),
    action: normalized(filters.action),
    entityType: normalized(filters.entityType),
    entityId: normalized(filters.entityId),
    outcome: filters.outcome === "all" ? undefined : filters.outcome,
    from: asIso(filters.from),
    to: asIso(filters.to),
  };
}

async function load(page = pagination.page) {
  const requestId = ++requestSequence;
  loading.value = true;
  error.value = false;

  try {
    const result = await adminApi.getAuditLogs(
      page,
      pagination.limit,
      appliedFilters.value,
    );
    if (requestId !== requestSequence) return;
    logs.value = result.data;
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
  void load(1);
}

function resetFilters() {
  Object.assign(filters, emptyFilters);
  appliedFilters.value = {};
  void load(1);
}

function showDetail(id: string) {
  void router.push({ name: "audit-log-detail", params: { id } });
}

onMounted(() => load(1));
</script>

<template>
  <section class="flex flex-col gap-6">
    <header class="page-header">
      <div>
        <p class="eyebrow">Безопасность</p>
        <h1>Журнал аудита</h1>
        <p>История административных действий и их результатов.</p>
      </div>
    </header>

    <form @submit.prevent="applyFilters" @reset.prevent="resetFilters">
      <Card>
      <CardHeader>
        <CardTitle>Фильтры</CardTitle>
        <CardDescription>
          Фильтры применяются на сервере ко всему журналу.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup class="md:grid md:grid-cols-2 xl:grid-cols-4">
          <Field>
            <FieldLabel for="audit-actor">Actor ID</FieldLabel>
            <Input id="audit-actor" v-model="filters.actorId" placeholder="UUID администратора" />
          </Field>
          <Field>
            <FieldLabel for="audit-action">Действие</FieldLabel>
            <Input id="audit-action" v-model="filters.action" placeholder="Например, user.update" />
          </Field>
          <Field>
            <FieldLabel for="audit-entity-type">Тип сущности</FieldLabel>
            <Input id="audit-entity-type" v-model="filters.entityType" placeholder="Например, user" />
          </Field>
          <Field>
            <FieldLabel for="audit-entity-id">Entity ID</FieldLabel>
            <Input id="audit-entity-id" v-model="filters.entityId" placeholder="UUID сущности" />
          </Field>
          <Field>
            <FieldLabel for="audit-outcome">Результат</FieldLabel>
            <Select v-model="filters.outcome">
              <SelectTrigger id="audit-outcome">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">Любой результат</SelectItem>
                  <SelectItem value="success">Успешно</SelectItem>
                  <SelectItem value="failure">Ошибка</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel for="audit-from">С даты</FieldLabel>
            <Input id="audit-from" v-model="filters.from" type="datetime-local" />
          </Field>
          <Field>
            <FieldLabel for="audit-to">По дату</FieldLabel>
            <Input id="audit-to" v-model="filters.to" type="datetime-local" />
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
      title="Не удалось загрузить журнал аудита"
      description="Проверьте соединение и повторите запрос."
      retry-label="Повторить"
      @retry="load()"
    />

    <Card v-else>
      <CardHeader>
        <CardTitle>События</CardTitle>
        <CardDescription>Найдено записей: {{ pagination.total }}</CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Дата</TableHead>
                <TableHead>Администратор</TableHead>
                <TableHead>Действие</TableHead>
                <TableHead>Сущность</TableHead>
                <TableHead>Результат</TableHead>
                <TableHead>Correlation ID</TableHead>
                <TableHead><span class="sr-only">Детали</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody v-if="loading">
              <TableRow v-for="row in 6" :key="row">
                <TableCell v-for="cell in 7" :key="cell">
                  <Skeleton class="h-5 w-full" />
                </TableCell>
              </TableRow>
            </TableBody>
            <TableBody v-else>
              <TableRow v-for="row in logs" :key="row.id">
                <TableCell class="whitespace-nowrap">{{ formatDate(row.createdAt) }}</TableCell>
                <TableCell>
                  {{ row.actorUsername }}
                  <div><code>{{ row.actorId }}</code></div>
                </TableCell>
                <TableCell><code>{{ row.action }}</code></TableCell>
                <TableCell>
                  {{ row.entityType }}
                  <div v-if="row.entityId"><code>{{ row.entityId }}</code></div>
                </TableCell>
                <TableCell>
                  <Badge :variant="row.outcome === 'success' ? 'default' : 'destructive'">
                    {{ row.outcome === "success" ? "Успешно" : "Ошибка" }}
                  </Badge>
                  <div v-if="row.failureCode"><code>{{ row.failureCode }}</code></div>
                </TableCell>
                <TableCell><code>{{ row.correlationId || "—" }}</code></TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Открыть событие аудита"
                    @click="showDetail(row.id)"
                  >
                    <Eye />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Empty v-if="!loading && !logs.length">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ScrollText /></EmptyMedia>
              <EmptyTitle>Событий нет</EmptyTitle>
              <EmptyDescription>
                По выбранным фильтрам записи аудита отсутствуют.
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
