<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { isAxiosError } from "axios";
import { ArrowLeft } from "@lucide/vue";
import { useRoute, useRouter } from "vue-router";
import { adminApi } from "../api/admin.api";
import StatePanel from "../components/StatePanel.vue";
import type { AdminAuditDetail } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const route = useRoute();
const router = useRouter();
const id = computed(() => String(route.params.id));
const log = ref<AdminAuditDetail | null>(null);
const loading = ref(true);
type LoadError = "not-found" | "unauthorized" | "server" | "network" | "generic";
const loadError = ref<LoadError | null>(null);
let requestSequence = 0;

const formatDate = (value: string) =>
  new Date(value).toLocaleString("ru-RU");

const formatMetadata = (value: Record<string, unknown> | null) =>
  JSON.stringify(value, null, 2);

const errorTitle = computed(() => {
  switch (loadError.value) {
    case "not-found":
      return "Событие аудита не найдено";
    case "unauthorized":
      return "Требуется авторизация";
    case "server":
      return "Ошибка сервера";
    case "network":
      return "Нет соединения с сервером";
    default:
      return "Не удалось загрузить событие аудита";
  }
});

const errorDescription = computed(() => {
  switch (loadError.value) {
    case "not-found":
      return "Запись могла быть удалена по сроку хранения или указан неверный идентификатор.";
    case "unauthorized":
      return "Сессия администратора истекла. Войдите снова и повторите запрос.";
    case "server":
      return "Сервер не смог обработать запрос. Повторите попытку позже.";
    case "network":
      return "Проверьте подключение к сети и доступность сервера.";
    default:
      return "Не удалось получить детали события. Повторите запрос.";
  }
});

async function load() {
  const requestId = ++requestSequence;
  loading.value = true;
  loadError.value = null;

  try {
    const result = await adminApi.getAuditLogById(id.value);
    if (requestId !== requestSequence) return;
    log.value = result;
  } catch (error) {
    if (requestId === requestSequence) {
      if (isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) loadError.value = "not-found";
        else if (status === 401) loadError.value = "unauthorized";
        else if (status !== undefined && status >= 500) loadError.value = "server";
        else if (!error.response) loadError.value = "network";
        else loadError.value = "generic";
      } else {
        loadError.value = "generic";
      }
      log.value = null;
    }
  } finally {
    if (requestId === requestSequence) loading.value = false;
  }
}

watch(id, load, { immediate: true });
</script>

<template>
  <section class="flex flex-col gap-6">
    <Button class="self-start" variant="ghost" @click="router.push('/audit-logs')">
      <ArrowLeft data-icon="inline-start" />
      К журналу аудита
    </Button>

    <div v-if="loading" class="flex flex-col gap-4">
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-72 w-full" />
      <Skeleton class="h-72 w-full" />
    </div>

    <StatePanel
      v-else-if="loadError || !log"
      :title="errorTitle"
      :description="errorDescription"
      retry-label="Повторить"
      @retry="load"
    />

    <template v-else>
      <header class="page-header">
        <div>
          <p class="eyebrow">Событие аудита</p>
          <h1 class="flex flex-wrap items-center gap-2">
            {{ log.action }}
            <Badge :variant="log.outcome === 'success' ? 'default' : 'destructive'">
              {{ log.outcome === "success" ? "Успешно" : "Ошибка" }}
            </Badge>
          </h1>
          <p>{{ formatDate(log.createdAt) }}</p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Основные сведения</CardTitle>
          <CardDescription>
            Идентификаторы административного действия и его результата.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl class="details-grid">
            <div>
              <dt>Администратор</dt>
              <dd>{{ log.actorUsername }}</dd>
            </div>
            <div>
              <dt>Actor ID</dt>
              <dd><code>{{ log.actorId }}</code></dd>
            </div>
            <div>
              <dt>Действие</dt>
              <dd><code>{{ log.action }}</code></dd>
            </div>
            <div>
              <dt>Тип сущности</dt>
              <dd>{{ log.entityType }}</dd>
            </div>
            <div>
              <dt>Entity ID</dt>
              <dd><code>{{ log.entityId || "—" }}</code></dd>
            </div>
            <div>
              <dt>Failure code</dt>
              <dd><code>{{ log.failureCode || "—" }}</code></dd>
            </div>
            <div>
              <dt>Request ID</dt>
              <dd><code>{{ log.requestId || "—" }}</code></dd>
            </div>
            <div>
              <dt>Correlation ID</dt>
              <dd><code>{{ log.correlationId || "—" }}</code></dd>
            </div>
            <div>
              <dt>Audit ID</dt>
              <dd><code>{{ log.id }}</code></dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div class="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>До изменения</CardTitle>
            <CardDescription>
              Безопасные поля сущности до административного действия.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre class="code-block">{{ formatMetadata(log.before) }}</pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>После изменения</CardTitle>
            <CardDescription>
              Безопасные поля сущности после административного действия.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre class="code-block">{{ formatMetadata(log.after) }}</pre>
          </CardContent>
        </Card>
      </div>
    </template>
  </section>
</template>
