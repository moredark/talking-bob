<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { isAxiosError } from "axios";
import {
  ArrowLeft,
  Copy,
  Eye,
  EyeOff,
  LockKeyhole,
  MessagesSquare,
} from "@lucide/vue";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { adminApi } from "../api/admin.api";
import StatePanel from "../components/StatePanel.vue";
import type {
  AdminGenerationStatus,
  AdminSessionAnalysis,
  AdminSessionDetail,
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type LoadError =
  | "not-found"
  | "unauthorized"
  | "server"
  | "network"
  | "generic";

const route = useRoute();
const router = useRouter();
const id = computed(() => String(route.params.id));
const session = ref<AdminSessionDetail | null>(null);
const loading = ref(true);
const loadError = ref<LoadError | null>(null);
const sensitiveRevealed = ref(false);
let requestSequence = 0;

const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleString("ru-RU") : "—";

const hasSensitiveContent = computed(() => {
  const value = session.value;
  if (!value) return false;
  return (
    value.messages.some(
      (message) => message.content !== null || message.voiceFileId !== null,
    ) ||
    (value.response !== null &&
      (value.response.transcript !== null ||
        value.response.analysis !== null)) ||
    value.providerCalls.some((call) => call.responseContent !== null)
  );
});

const availabilityLabel = computed(() => {
  if (!session.value) return "Недоступно";
  if (session.value.contentPurged && session.value.aiTracePurgedAt !== null) {
    return "Контент очищен";
  }
  if (session.value.contentPurged || session.value.aiTracePurgedAt !== null) {
    return "Доступно частично";
  }
  return hasSensitiveContent.value ? "Доступно" : "Пусто";
});

const errorTitle = computed(() => {
  switch (loadError.value) {
    case "not-found":
      return "Сессия не найдена";
    case "unauthorized":
      return "Требуется авторизация";
    case "server":
      return "Ошибка сервера";
    case "network":
      return "Нет соединения с сервером";
    default:
      return "Не удалось загрузить сессию";
  }
});

const errorDescription = computed(() => {
  switch (loadError.value) {
    case "not-found":
      return "Сессия отсутствует или указан неверный идентификатор.";
    case "unauthorized":
      return "Сессия администратора истекла. Войдите снова.";
    case "server":
      return "Сервер не смог обработать запрос. Повторите попытку позже.";
    case "network":
      return "Проверьте подключение к сети и доступность сервера.";
    default:
      return "Не удалось получить детали сессии. Повторите запрос.";
  }
});

function generationLabel(value: AdminGenerationStatus | null) {
  if (value === null) return "Нет ответа";
  return {
    generating: "Генерация",
    generated: "Готово",
    failed: "Ошибка",
  }[value];
}

function analysisText(analysis: AdminSessionAnalysis) {
  return analysis.kind === "legacy"
    ? analysis.raw
    : JSON.stringify(analysis, null, 2);
}

function providerContentLabel(
  call: AdminSessionDetail["providerCalls"][number],
) {
  if (call.outcome === "empty") return "Пустой ответ";
  if (call.outcome === "failed") return "Ответ отсутствует";
  return "Недоступно";
}

async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} скопирован`);
  } catch {
    toast.error("Не удалось скопировать");
  }
}

async function load() {
  const requestId = ++requestSequence;
  loading.value = true;
  loadError.value = null;
  sensitiveRevealed.value = false;
  try {
    const result = await adminApi.getSessionById(id.value);
    if (requestId !== requestSequence) return;
    session.value = result;
  } catch (error) {
    if (requestId === requestSequence) {
      if (isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) loadError.value = "not-found";
        else if (status === 401) loadError.value = "unauthorized";
        else if (status !== undefined && status >= 500) {
          loadError.value = "server";
        } else if (!error.response) loadError.value = "network";
        else loadError.value = "generic";
      } else {
        loadError.value = "generic";
      }
      session.value = null;
    }
  } finally {
    if (requestId === requestSequence) loading.value = false;
  }
}

watch(id, load, { immediate: true });
</script>

<template>
  <section class="flex flex-col gap-6">
    <Button class="self-start" variant="ghost" @click="router.push('/sessions')">
      <ArrowLeft data-icon="inline-start" />
      К сессиям
    </Button>

    <div v-if="loading" class="flex flex-col gap-4">
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-72 w-full" />
      <Skeleton class="h-72 w-full" />
    </div>

    <StatePanel
      v-else-if="loadError || !session"
      :title="errorTitle"
      :description="errorDescription"
      retry-label="Повторить"
      @retry="load"
    />

    <template v-else>
      <header class="page-header">
        <div>
          <p class="eyebrow">Сессия</p>
          <h1 class="flex flex-wrap items-center gap-2">
            {{ session.prompt.topic }}
            <Badge variant="outline">{{ availabilityLabel }}</Badge>
          </h1>
          <p>
            {{ session.user.username || "Пользователь" }} ·
            {{ formatDate(session.createdAt) }}
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Жизненный цикл</CardTitle>
          <CardDescription>
            Доставка вопроса, состояние разговора и генерация отчёта.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl class="details-grid">
            <div><dt>Session ID</dt><dd><code>{{ session.id }}</code></dd></div>
            <div><dt>User ID</dt><dd><code>{{ session.user.id }}</code></dd></div>
            <div><dt>Telegram ID</dt><dd><code>{{ session.user.telegramId }}</code></dd></div>
            <div><dt>Prompt ID</dt><dd><code>{{ session.prompt.id }}</code></dd></div>
            <div><dt>Источник</dt><dd>{{ session.source }}</dd></div>
            <div>
              <dt>Доставка вопроса</dt>
              <dd>
                <Badge :variant="session.deliveryStatus === 'failed' ? 'destructive' : 'secondary'">
                  {{ session.deliveryStatus }}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Разговор</dt>
              <dd><Badge variant="outline">{{ session.conversationStatus }}</Badge></dd>
            </div>
            <div>
              <dt>Генерация</dt>
              <dd>
                <Badge :variant="session.generationStatus === 'failed' ? 'destructive' : 'secondary'">
                  {{ generationLabel(session.generationStatus) }}
                </Badge>
              </dd>
            </div>
            <div><dt>Ходов</dt><dd>{{ session.turnCount }}</dd></div>
            <div><dt>Отправлена</dt><dd>{{ formatDate(session.sentAt) }}</dd></div>
            <div><dt>Запланирована</dt><dd>{{ formatDate(session.delivery.scheduledFor) }}</dd></div>
            <div><dt>Попытка доставки</dt><dd>{{ formatDate(session.delivery.deliveryAttemptedAt) }}</dd></div>
            <div><dt>Разговор закрыт</dt><dd>{{ formatDate(session.conversationClosedAt) }}</dd></div>
            <div><dt>Отчёт создан</dt><dd>{{ formatDate(session.generatedAt) }}</dd></div>
            <div><dt>Ошибка доставки</dt><dd><code>{{ session.delivery.lastErrorCode || "—" }}</code></dd></div>
            <div><dt>Дата ошибки</dt><dd>{{ formatDate(session.delivery.lastErrorAt) }}</dd></div>
            <div><dt>Контент очищен</dt><dd>{{ formatDate(session.contentPurgedAt) }}</dd></div>
            <div><dt>AI-трассировка очищена</dt><dd>{{ formatDate(session.aiTracePurgedAt) }}</dd></div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Чувствительное содержимое</CardTitle>
          <CardDescription>
            Сообщения, transcript, analysis и ответы провайдера скрыты до явного подтверждения.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Empty v-if="!hasSensitiveContent">
            <EmptyHeader>
              <EmptyMedia variant="icon"><LockKeyhole /></EmptyMedia>
              <EmptyTitle>
                {{ session.contentPurged || session.aiTracePurgedAt ? "Содержимое очищено" : "Содержимого нет" }}
              </EmptyTitle>
              <EmptyDescription>
                {{
                  session.contentPurged || session.aiTracePurgedAt
                    ? "Retention очистил всё или часть чувствительных данных."
                    : "В сессии нет сохранённых чувствительных данных."
                }}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div v-else class="flex flex-wrap items-center gap-2">
            <Badge :variant="sensitiveRevealed ? 'destructive' : 'secondary'">
              {{ sensitiveRevealed ? "Содержимое показано" : "Содержимое скрыто" }}
            </Badge>
            <span v-if="session.contentPurged || session.aiTracePurgedAt">
              Часть данных уже очищена по сроку хранения.
            </span>
          </div>
        </CardContent>
        <CardFooter v-if="hasSensitiveContent">
          <Button
            :variant="sensitiveRevealed ? 'outline' : 'destructive'"
            @click="sensitiveRevealed = !sensitiveRevealed"
          >
            <EyeOff v-if="sensitiveRevealed" data-icon="inline-start" />
            <Eye v-else data-icon="inline-start" />
            {{ sensitiveRevealed ? "Скрыть содержимое" : "Показать чувствительное содержимое" }}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Сообщения <Badge variant="secondary">{{ session.messages.length }}</Badge></CardTitle>
          <CardDescription>Хронологическая история диалога.</CardDescription>
        </CardHeader>
        <CardContent class="p-0">
          <Empty v-if="!session.messages.length">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessagesSquare /></EmptyMedia>
              <EmptyTitle>Сообщений нет</EmptyTitle>
              <EmptyDescription>В сессии не сохранены сообщения.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div v-else class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Дата</TableHead>
                  <TableHead>Роль</TableHead>
                  <TableHead>Содержимое</TableHead>
                  <TableHead><span class="sr-only">Копировать</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="message in session.messages" :key="message.id">
                  <TableCell class="whitespace-nowrap">{{ formatDate(message.createdAt) }}</TableCell>
                  <TableCell><Badge variant="outline">{{ message.role }}</Badge></TableCell>
                  <TableCell class="max-w-3xl whitespace-normal break-words">
                    <Badge v-if="!sensitiveRevealed" variant="secondary">Скрыто</Badge>
                    <template v-else-if="message.content !== null">
                      <pre class="code-block">{{ message.content }}</pre>
                    </template>
                    <Badge v-else variant="outline">
                      {{ session.contentPurged ? "Очищено" : "Нет содержимого" }}
                    </Badge>
                    <p v-if="sensitiveRevealed && message.voiceFileId">
                      Voice file: <code>{{ message.voiceFileId }}</code>
                    </p>
                  </TableCell>
                  <TableCell>
                    <Button
                      v-if="sensitiveRevealed && message.content !== null"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Копировать сообщение"
                      @click="copyText(message.content, 'Сообщение')"
                    >
                      <Copy />
                    </Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ответ и анализ</CardTitle>
          <CardDescription>Состояние генерации и сохранённый отчёт.</CardDescription>
        </CardHeader>
        <CardContent>
          <Empty v-if="!session.response">
            <EmptyHeader>
              <EmptyTitle>Ответа нет</EmptyTitle>
              <EmptyDescription>Пользовательский ответ ещё не создан.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div v-else class="flex flex-col gap-5">
            <dl class="details-grid">
              <div><dt>Response ID</dt><dd><code>{{ session.response.id }}</code></dd></div>
              <div><dt>Статус</dt><dd><Badge variant="secondary">{{ generationLabel(session.response.generationStatus) }}</Badge></dd></div>
              <div><dt>Попытка генерации</dt><dd>{{ formatDate(session.response.generationAttemptedAt) }}</dd></div>
              <div><dt>Сгенерирован</dt><dd>{{ formatDate(session.response.generatedAt) }}</dd></div>
              <div><dt>Ошибка</dt><dd><code>{{ session.response.lastErrorCode || "—" }}</code></dd></div>
              <div><dt>Дата ошибки</dt><dd>{{ formatDate(session.response.lastErrorAt) }}</dd></div>
              <div><dt>Чувствительные данные очищены</dt><dd>{{ formatDate(session.response.sensitiveDataPurgedAt) }}</dd></div>
            </dl>
            <Separator />
            <section class="flex flex-col gap-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <strong>Transcript</strong>
                <Button
                  v-if="sensitiveRevealed && session.response.transcript !== null"
                  variant="outline"
                  size="sm"
                  @click="copyText(session.response.transcript, 'Transcript')"
                >
                  <Copy data-icon="inline-start" />
                  Копировать
                </Button>
              </div>
              <Badge v-if="!sensitiveRevealed" variant="secondary">Скрыто</Badge>
              <pre v-else-if="session.response.transcript !== null" class="code-block">{{ session.response.transcript }}</pre>
              <Badge v-else variant="outline">
                {{ session.response.sensitiveDataPurgedAt ? "Очищено" : "Нет данных" }}
              </Badge>
            </section>
            <Separator />
            <section class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <strong>Analysis</strong>
                <Button
                  v-if="sensitiveRevealed && session.response.analysis !== null"
                  variant="outline"
                  size="sm"
                  @click="copyText(analysisText(session.response.analysis), 'Analysis')"
                >
                  <Copy data-icon="inline-start" />
                  Копировать
                </Button>
              </div>
              <Badge v-if="!sensitiveRevealed" variant="secondary">Скрыто</Badge>
              <template v-else-if="session.response.analysis">
                <Badge variant="outline">{{ session.response.analysis.kind }}</Badge>
                <pre v-if="session.response.analysis.kind === 'legacy'" class="code-block">{{ session.response.analysis.raw }}</pre>
                <template v-else>
                  <dl class="details-grid">
                    <div><dt>Версия</dt><dd>{{ session.response.analysis.version }}</dd></div>
                    <div><dt>Оценка</dt><dd>{{ session.response.analysis.overallScore }}/10</dd></div>
                  </dl>
                  <pre class="code-block">{{ session.response.analysis.summary }}</pre>
                  <ul v-if="session.response.analysis.improvementPoints.length" class="flex list-disc flex-col gap-2 pl-5">
                    <li v-for="point in session.response.analysis.improvementPoints" :key="point">{{ point }}</li>
                  </ul>
                  <Empty v-else>
                    <EmptyHeader><EmptyTitle>Рекомендаций нет</EmptyTitle></EmptyHeader>
                  </Empty>
                </template>
              </template>
              <Badge v-else variant="outline">
                {{ session.response.sensitiveDataPurgedAt ? "Очищено" : "Нет данных" }}
              </Badge>
            </section>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Доставка отчёта <Badge variant="secondary">{{ session.reportDeliveries.length }}</Badge></CardTitle>
          <CardDescription>Попытки доставки готового отчёта в Telegram.</CardDescription>
        </CardHeader>
        <CardContent class="p-0">
          <Empty v-if="!session.reportDeliveries.length">
            <EmptyHeader><EmptyTitle>Попыток доставки нет</EmptyTitle><EmptyDescription>Отчёт ещё не отправлялся.</EmptyDescription></EmptyHeader>
          </Empty>
          <div v-else class="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Создана</TableHead><TableHead>Статус</TableHead><TableHead>Следующий chunk</TableHead><TableHead>Попытка</TableHead><TableHead>Доставлено</TableHead><TableHead>Ошибка</TableHead></TableRow></TableHeader>
              <TableBody>
                <TableRow v-for="delivery in session.reportDeliveries" :key="delivery.id">
                  <TableCell>{{ formatDate(delivery.createdAt) }}</TableCell>
                  <TableCell><Badge :variant="delivery.status === 'failed' ? 'destructive' : 'secondary'">{{ delivery.status }}</Badge></TableCell>
                  <TableCell>{{ delivery.nextChunkIndex }}</TableCell>
                  <TableCell>{{ formatDate(delivery.deliveryAttemptedAt) }}</TableCell>
                  <TableCell>{{ formatDate(delivery.deliveredAt) }}</TableCell>
                  <TableCell><code>{{ delivery.lastErrorCode || "—" }}</code><div>{{ formatDate(delivery.lastErrorAt) }}</div></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Вызовы AI-провайдера <Badge variant="secondary">{{ session.providerCalls.length }}</Badge></CardTitle>
          <CardDescription>
            Хронология вызовов без request payload и секретов.
            <Badge v-if="session.aiTracePurgedAt" variant="outline">
              Raw response очищен {{ formatDate(session.aiTracePurgedAt) }}
            </Badge>
          </CardDescription>
        </CardHeader>
        <CardContent class="p-0">
          <Empty v-if="!session.providerCalls.length">
            <EmptyHeader>
              <EmptyTitle>{{ session.aiTracePurgedAt ? "Трассировка очищена" : "Вызовов нет" }}</EmptyTitle>
              <EmptyDescription>
                {{ session.aiTracePurgedAt ? "Provider calls удалены по сроку хранения." : "Связанные вызовы провайдера отсутствуют." }}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div v-else class="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Дата</TableHead><TableHead>Операция</TableHead><TableHead>Провайдер / модель</TableHead><TableHead>Результат</TableHead><TableHead>Метрики</TableHead><TableHead>Raw response</TableHead></TableRow></TableHeader>
              <TableBody>
                <TableRow v-for="call in session.providerCalls" :key="call.id">
                  <TableCell class="whitespace-nowrap">{{ formatDate(call.createdAt) }}</TableCell>
                  <TableCell><code>{{ call.operation }}</code><div>Попытка {{ call.attempt }}</div></TableCell>
                  <TableCell>{{ call.provider }}<div><code>{{ call.model }}</code></div></TableCell>
                  <TableCell>
                    <Badge :variant="call.outcome === 'failed' ? 'destructive' : 'secondary'">{{ call.outcome }}</Badge>
                    <div>HTTP {{ call.statusCode ?? "—" }}</div>
                    <code>{{ call.failureCode || "—" }}</code>
                  </TableCell>
                  <TableCell>
                    {{ call.latencyMs }} ms
                    <div>Tokens: {{ call.inputTokens ?? "—" }} / {{ call.outputTokens ?? "—" }} / {{ call.totalTokens ?? "—" }}</div>
                    <div v-if="call.correlationId">
                      Correlation:
                      <RouterLink
                        class="link"
                        :to="{ path: '/error-logs', query: { correlationId: call.correlationId } }"
                      >
                        <code>{{ call.correlationId }}</code>
                      </RouterLink>
                    </div>
                    <div v-else>Correlation: —</div>
                    <div>Request: <code>{{ call.requestId || "—" }}</code></div>
                  </TableCell>
                  <TableCell class="max-w-3xl whitespace-normal break-words">
                    <Badge v-if="!sensitiveRevealed" variant="secondary">Скрыто</Badge>
                    <template v-else-if="call.responseContent !== null">
                      <pre class="code-block">{{ call.responseContent }}</pre>
                      <Button variant="outline" size="sm" @click="copyText(call.responseContent, 'Ответ провайдера')">
                        <Copy data-icon="inline-start" />
                        Копировать
                      </Button>
                    </template>
                    <Badge v-else variant="outline">{{ providerContentLabel(call) }}</Badge>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </template>
  </section>
</template>
