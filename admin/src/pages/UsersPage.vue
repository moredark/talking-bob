<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ArrowUpDown, Eye, RefreshCw, Users } from "@lucide/vue";
import { adminApi } from "../api/admin.api";
import type { UserListItem } from "../types";
import StatePanel from "../components/StatePanel.vue";
import { Badge } from "@/components/ui/badge"; import { Button } from "@/components/ui/button"; import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"; import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationNext, PaginationPrevious } from "@/components/ui/pagination"; import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";  import { Skeleton } from "@/components/ui/skeleton"; import { Spinner } from "@/components/ui/spinner"; import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
const router = useRouter(); const users = ref<UserListItem[]>([]); const loading = ref(true); const error = ref(false); const pagination = reactive({ page: 1, limit: 20, total: 0 }); const dailyFilter = ref("all"); const sort = ref<{ key: keyof UserListItem; direction: 1 | -1 }>({ key: "createdAt", direction: -1 });
const date = (value: string | null) => value ? new Date(value).toLocaleDateString("ru-RU") : "Нет";
const shownUsers = computed(() => users.value.filter((u) => dailyFilter.value === "all" || u.dailyPromptEnabled === (dailyFilter.value === "enabled")).sort((a, b) => String(a[sort.value.key] ?? "").localeCompare(String(b[sort.value.key] ?? ""), "ru", { numeric: true }) * sort.value.direction));
function changeSort(key: keyof UserListItem) { sort.value = { key, direction: sort.value.key === key && sort.value.direction === 1 ? -1 : 1 }; }
let requestSequence = 0;
async function load(page = pagination.page) {
  const requestId = ++requestSequence;
  loading.value = true;
  error.value = false;
  try {
    const result = await adminApi.getUsers(page, pagination.limit);
    if (requestId !== requestSequence) return;
    users.value = result.data;
    Object.assign(pagination, { page: result.page, limit: result.limit, total: result.total });
  } catch {
    if (requestId === requestSequence) error.value = true;
  } finally {
    if (requestId === requestSequence) loading.value = false;
  }
}
onMounted(() => load(1));
</script>
<template><section class="flex flex-col gap-6">
  <header class="page-header"><div><p class="eyebrow">Аудитория</p><h1>Пользователи</h1><p>Активность, прогресс и настройки рассылки.</p></div><div class="header-actions"><Select v-model="dailyFilter"><SelectTrigger aria-label="Фильтр рассылки"><SelectValue placeholder="Рассылка" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">Любая рассылка</SelectItem><SelectItem value="enabled">Включена</SelectItem><SelectItem value="disabled">Выключена</SelectItem></SelectGroup></SelectContent></Select><Button variant="outline" :disabled="loading" @click="load()"><Spinner v-if="loading" data-icon="inline-start" /><RefreshCw v-else data-icon="inline-start" />Обновить</Button></div></header>
  <StatePanel v-if="error && !loading" title="Не удалось загрузить пользователей" description="Данные не были изменены." retry-label="Повторить" @retry="load()" />
  <div v-else class="overflow-hidden rounded-xl border bg-card text-card-foreground"><div class="overflow-x-auto">
    <Table><TableHeader><TableRow><TableHead>Имя</TableHead><TableHead>Telegram ID</TableHead><TableHead v-for="column in [{key:'promptsReceived',label:'Промптов'},{key:'responsesCount',label:'Ответов'},{key:'averageScore',label:'Ср. оценка'}]" :key="column.key"><Button variant="ghost" size="sm" @click="changeSort(column.key as keyof UserListItem)">{{ column.label }}<ArrowUpDown data-icon="inline-end" /></Button></TableHead><TableHead>Рассылка</TableHead><TableHead><Button variant="ghost" size="sm" @click="changeSort('lastActivityAt')">Активность<ArrowUpDown data-icon="inline-end" /></Button></TableHead><TableHead><Button variant="ghost" size="sm" @click="changeSort('createdAt')">Регистрация<ArrowUpDown data-icon="inline-end" /></Button></TableHead><TableHead><span class="sr-only">Действия</span></TableHead></TableRow></TableHeader>
      <TableBody v-if="loading"><TableRow v-for="i in 6" :key="i"><TableCell v-for="j in 9" :key="j"><Skeleton class="h-5 w-full" /></TableCell></TableRow></TableBody>
      <TableBody v-else><TableRow v-for="row in shownUsers" :key="row.id" class="cursor-pointer" @click="router.push(`/users/${row.id}`)"><TableCell class="font-medium">{{ row.username || "Без username" }}</TableCell><TableCell>{{ row.telegramId }}</TableCell><TableCell>{{ row.promptsReceived }}</TableCell><TableCell>{{ row.responsesCount }}</TableCell><TableCell>{{ row.averageScore !== null ? `${row.averageScore}/10` : "—" }}</TableCell><TableCell><Badge :variant="row.dailyPromptEnabled ? 'default' : 'secondary'">{{ row.dailyPromptEnabled ? "Включена" : "Выключена" }}</Badge></TableCell><TableCell>{{ date(row.lastActivityAt) }}</TableCell><TableCell>{{ date(row.createdAt) }}</TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label="Открыть пользователя" @click.stop="router.push(`/users/${row.id}`)"><Eye /></Button></TableCell></TableRow></TableBody>
    </Table><Empty v-if="!loading && !shownUsers.length"><EmptyHeader><EmptyMedia variant="icon"><Users /></EmptyMedia><EmptyTitle>Пользователей нет</EmptyTitle><EmptyDescription>По выбранному фильтру ничего не найдено.</EmptyDescription></EmptyHeader></Empty>
  </div><Pagination v-if="pagination.total>pagination.limit" :page="pagination.page" :total="pagination.total" :items-per-page="pagination.limit" :sibling-count="1" class="border-t p-4" @update:page="load"><PaginationContent v-slot="{items}"><PaginationPrevious/><template v-for="(item,itemIndex) in items" :key="item.type==='page'?item.value:'ellipsis-'+itemIndex"><PaginationItem v-if="item.type==='page'" :value="item.value" :is-active="item.value===pagination.page">{{item.value}}</PaginationItem><PaginationEllipsis v-if="item.type==='ellipsis'" :index="itemIndex"/></template><PaginationNext/></PaginationContent></Pagination></div>
</section></template>
