# Database contract

Актуально на **2026-08-10**. Документ сверён с `prisma/schema.prisma` и
миграциями по `20260810160000_admin_analytics_facts` включительно.

Здесь описана база bot/backend. `AdminUser` намеренно не включён: это отдельный
контур аутентификации. Append-only `AdminAuditLog` включён, поскольку его
атомарность, sanitization и retention являются backend-инвариантами.

## Общие соглашения

- PostgreSQL используется с обычными внешними ключами; `relationMode =
  "prisma"` не задан.
- Имена таблиц — `snake_case`, поля Prisma — `camelCase`.
- Почти все идентификаторы имеют PostgreSQL-тип `TEXT`; исключение —
  `report_delivery_requests.id` (`UUID`). `@default(uuid())` является
  Prisma-level default: SQL-миграции не задают серверный `DEFAULT` для id.
- Бизнес-моменты хранятся как `TIMESTAMPTZ(3)` (UTC instants), локальная дата
  scheduled occurrence — как `DATE`. Исключение из старого admin-профиля:
  `users.bannedAt` остаётся `TIMESTAMP(3)` без timezone.
- `createdAt DEFAULT now()` означает Prisma/SQL `CURRENT_TIMESTAMP`;
  `updatedAt @updatedAt` обновляется Prisma-клиентом, SQL-default отсутствует.
- Все внешние ключи ниже используют `ON DELETE RESTRICT ON UPDATE CASCADE`.

## Enum-типы PostgreSQL

- `UserPromptSource`: `manual`, `scheduled`, `legacy`.
- `UserPromptDeliveryStatus`: `pending`, `sent`, `failed`.
- `ConversationStatus`: `open`, `closed`.
- `ReportGenerationStatus`: `generating`, `generated`, `failed`.
- `ReportAnalysisKind`: `model`, `fallback`, `legacy`.
- `ReportDeliveryStatus`: `pending`, `delivered`, `failed`.

## Таблицы

### `users` (`User`)

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `telegramId` | `BIGINT` | нет | Telegram user id; unique |
| `username` | `TEXT` | да | Telegram username |
| `dailyPromptEnabled` | `BOOLEAN` | нет | `true` |
| `announcementEnabled` | `BOOLEAN` | нет | `true`; отдельное согласие на анонсы |
| `lastUserMessageAt` | `TIMESTAMPTZ(3)` | да | Последняя принятая user-реплика; несекретный activity fact |
| `dailyPromptHour` | `INTEGER` | нет | `13` |
| `dailyPromptMinute` | `INTEGER` | нет | `0` |
| `timezone` | `TEXT` | нет | `Europe/Moscow` |
| `agentTone` | `TEXT` | нет | `friendly` |
| `lastPromptSentAt` | `TIMESTAMPTZ(3)` | да | Последняя подтверждённая отправка |
| `nextPromptAt` | `TIMESTAMPTZ(3)` | да | Следующий рассчитанный слот |
| `languageLevel` | `TEXT` | да | Профиль пользователя |
| `status` | `TEXT` | нет | `active` |
| `bannedAt` | `TIMESTAMP(3)` | да | Legacy admin timestamp |
| `bannedReason` | `TEXT` | да | Причина блокировки |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |
| `updatedAt` | `TIMESTAMPTZ(3)` | нет | Prisma `@updatedAt` |

Ключи и индексы: PK `id`; unique `telegramId`; indexes `nextPromptAt` и `lastUserMessageAt`.

Связи: один пользователь имеет много `UserPrompt`, `UserResponse`,
`UserRequest` и `QuotaWindow`.

### `prompts` (`Prompt`)

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `topic` | `TEXT` | нет | Текст вопроса, который доставляется пользователю |
| `textContent` | `TEXT` | да | Дополнительные метаданные |
| `audioFileId` | `TEXT` | да | Необязательный заранее загруженный Telegram voice |
| `difficulty` | `TEXT` | нет | `medium` |
| `tags` | `TEXT[]` | Prisma: нет; SQL: да | `[]` |
| `isActive` | `BOOLEAN` | нет | `true` |
| `sortOrder` | `INTEGER` | нет | `0`; admin ordering |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |

Ключи: PK `id`. Отдельных индексов нет. Связь: prompt имеет много
`UserPrompt`.

Примечание по миграциям: `tags` объявлен обязательным в Prisma, но историческая
SQL-миграция добавила колонку с default без `NOT NULL`. Приложение должно
считать `tags` обязательным; перед будущим ужесточением SQL constraint нужно
проверить legacy-данные.

### `user_prompts` (`UserPrompt`)

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `userId` | `TEXT` | нет | FK → `users.id` |
| `promptId` | `TEXT` | нет | FK → `prompts.id` |
| `source` | `UserPromptSource` | нет | `manual` |
| `deliveryStatus` | `UserPromptDeliveryStatus` | нет | `pending` |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |
| `sentAt` | `TIMESTAMPTZ(3)` | да | Подтверждённая доставка |
| `scheduledFor` | `TIMESTAMPTZ(3)` | да | UTC instant локального scheduled slot |
| `scheduledOccurrenceKey` | `VARCHAR(64)` | да | `scheduled:<userId>:YYYY-MM-DD` |
| `scheduledLocalDate` | `DATE` | да | Локальная дата occurrence |
| `timezoneSnapshot` | `VARCHAR(128)` | да | Canonical IANA timezone при claim |
| `claimToken` | `UUID` | да | Delivery lease token |
| `claimExpiresAt` | `TIMESTAMPTZ(3)` | да | Delivery lease deadline |
| `deliveryAttemptedAt` | `TIMESTAMPTZ(3)` | да | Время начала Telegram attempt |
| `lastDeliveryErrorCode` | `VARCHAR(64)` | да | Санитизированный код результата/ошибки |
| `lastDeliveryErrorAt` | `TIMESTAMPTZ(3)` | да | Время кода ошибки |
| `conversationStatus` | `ConversationStatus` | нет | `open` |
| `conversationClosedAt` | `TIMESTAMPTZ(3)` | да | Время атомарного закрытия диалога |
| `firstUserMessageAt` | `TIMESTAMPTZ(3)` | да | Первая принятая user-реплика; сохраняется после content purge |

Ключи и Prisma-индексы:

- PK `id`;
- `userId`;
- `userId, createdAt DESC, id DESC` (`user_prompts_user_created_id_idx`);
- `promptId`;
- `userId, deliveryStatus, sentAt`;
- `deliveryStatus, deliveryAttemptedAt, claimExpiresAt`
  (`user_prompts_delivery_retry_idx`);
- `conversationStatus, conversationClosedAt`;
- `scheduledOccurrenceKey`;
- `sentAt`;
- `firstUserMessageAt`.

SQL-only partial unique index
`user_prompts_scheduledOccurrenceKey_unique` обеспечивает уникальность
`scheduledOccurrenceKey` только для non-null значений. Поэтому scheduled
occurrence идемпотентен, а ручные prompt instances не ограничены этим ключом.

Связи: принадлежит `User` и `Prompt`; имеет много `ConversationMessage` и не
более одного `UserResponse` (unique на `user_responses.userPromptId`).

### `user_activity_days` (`UserActivityDay`)

Несекретный Moscow-calendar activity fact: composite PK `userId, localDate`,
`firstActivityAt`, `lastActivityAt` и положительный `messageCount`. CHECK
гарантирует, что оба instant принадлежат `localDate` в `Europe/Moscow`. Index
`localDate, userId` обслуживает bounded daily/retention analytics. Строка
upsert-ится в той же транзакции, где принимается user message, не содержит
текст, voice id или Telegram update id и удаляется cascade при удалении user.

### `conversation_messages` (`ConversationMessage`)

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `userPromptId` | `TEXT` | нет | FK → `user_prompts.id` |
| `role` | `TEXT` | нет | Роль сообщения |
| `content` | `TEXT` | нет | Текст сообщения |
| `voiceFileId` | `TEXT` | да | Telegram voice file id пользователя |
| `telegramUpdateId` | `BIGINT` | да | Unique id входящего Telegram update |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |

Ключи и индексы: PK `id`; unique nullable `telegramUpdateId`; index
`userPromptId`. Nullable unique позволяет legacy/assistant rows без update id,
а повтор одного входящего update не создаёт второе пользовательское сообщение.

### `user_responses` (`UserResponse`)

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `userId` | `TEXT` | нет | FK → `users.id` |
| `userPromptId` | `TEXT` | нет | FK → `user_prompts.id`; unique |
| `voiceFileId` | `TEXT` | да | Voice id первого принятого user turn; очищается retention |
| `transcript` | `TEXT` | да | Транскрипт; очищается retention |
| `analysis` | `TEXT` | да | Persisted report payload; очищается retention |
| `generationStatus` | `ReportGenerationStatus` | нет | `generating` |
| `generationRequestKey` | `VARCHAR(160)` | нет | Идемпотентный ключ запроса генерации |
| `generationClaimToken` | `UUID` | да | Generation lease token |
| `generationClaimExpiresAt` | `TIMESTAMPTZ(3)` | да | Generation lease deadline |
| `generationAttemptedAt` | `TIMESTAMPTZ(3)` | нет | Время последнего claim/attempt |
| `generatedAt` | `TIMESTAMPTZ(3)` | да | Время успешной генерации |
| `lastGenerationErrorCode` | `VARCHAR(64)` | да | Санитизированный код ошибки |
| `lastGenerationErrorAt` | `TIMESTAMPTZ(3)` | да | Время ошибки |
| `analysisVersion` | `INTEGER` | да | Версия persisted report contract |
| `analysisKind` | `ReportAnalysisKind` | да | `model`, `fallback` или `legacy` |
| `overallScore` | `DOUBLE PRECISION` | да | Валидная top-level оценка 1..10 для model/legacy; сохраняется после content purge |
| `reportDeliveredAt` | `TIMESTAMPTZ(3)` | да | Последняя подтверждённая полная доставка отчёта |
| `sensitiveDataPurgedAt` | `TIMESTAMPTZ(3)` | да | Маркер необратимой очистки content |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |

Ключи и индексы: PK `id`; unique `userPromptId`; index `userId`; reclaim index
`generationStatus, generationAttemptedAt, generationClaimExpiresAt`; index
`sensitiveDataPurgedAt`.

Связи: принадлежит `User` и `UserPrompt`; имеет много
`ReportDeliveryRequest`.

### `report_delivery_requests` (`ReportDeliveryRequest`)

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `UUID` | нет | Prisma `uuid()`; PK |
| `userResponseId` | `TEXT` | нет | FK → `user_responses.id` |
| `requestKey` | `VARCHAR(160)` | нет | Идемпотентный ключ доставки |
| `chunks` | `JSONB` | нет | Непустой массив готовых Telegram chunks |
| `nextChunkIndex` | `INTEGER` | нет | `0`; первый ещё не подтверждённый chunk |
| `status` | `ReportDeliveryStatus` | нет | `pending` |
| `claimToken` | `UUID` | да | Delivery lease token |
| `claimExpiresAt` | `TIMESTAMPTZ(3)` | да | Delivery lease deadline |
| `deliveryAttemptedAt` | `TIMESTAMPTZ(3)` | да | Время delivery attempt |
| `deliveredAt` | `TIMESTAMPTZ(3)` | да | Время полной доставки |
| `lastDeliveryErrorCode` | `VARCHAR(64)` | да | Санитизированный код ошибки |
| `lastDeliveryErrorAt` | `TIMESTAMPTZ(3)` | да | Время ошибки |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |
| `updatedAt` | `TIMESTAMPTZ(3)` | нет | Prisma `@updatedAt` |

Ключи и индексы: PK `id`; composite unique `userResponseId, requestKey`;
reclaim index `status, deliveryAttemptedAt, claimExpiresAt`.

### `user_requests` (`UserRequest`)

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `userId` | `TEXT` | нет | FK → `users.id` |
| `quotaWindowId` | `TEXT` | да | FK → `quota_windows.id` для calendar quota |
| `action` | `TEXT` | нет | Rate-limit action |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |

Ключи и индексы: PK `id`; indexes `userId, createdAt`, `userId, action,
createdAt`, `quotaWindowId, createdAt` и `createdAt`.

### `quota_windows` (`QuotaWindow`)

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `userId` | `TEXT` | нет | FK → `users.id` |
| `action` | `TEXT` | нет | Calendar rate-limit action |
| `timezoneSnapshot` | `VARCHAR(128)` | нет | Runtime: canonical IANA timezone окна; legacy backfill может сохранить PostgreSQL-valid alias до истечения окна |
| `windowStart` | `TIMESTAMPTZ(3)` | нет | Inclusive UTC instant |
| `windowEnd` | `TIMESTAMPTZ(3)` | нет | Exclusive UTC instant |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |

Ключи и индексы: PK `id`; composite unique `userId, action, windowStart,
windowEnd`; indexes `userId, action, windowEnd` и `windowEnd`.

### `error_logs` (`ErrorLog`)

`userId` здесь — диагностический атрибут, не внешний ключ.

| Поле | PostgreSQL | Null | Default / назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `type` | `TEXT` | нет | Категория события |
| `service` | `TEXT` | нет | Компонент-источник |
| `operation` | `VARCHAR(80)` | нет | `unknown`; bounded operation name |
| `correlationId` | `VARCHAR(160)` | да | Корреляция одного flow |
| `statusCode` | `INTEGER` | да | HTTP-подобный status |
| `retryable` | `BOOLEAN` | да | Признак повторяемости |
| `latencyMs` | `INTEGER` | да | Неотрицательная latency |
| `errorKind` | `VARCHAR(80)` | нет | `LegacyError` |
| `message` | `TEXT` | нет | Санитизированное сообщение |
| `stack` | `TEXT` | да | Санитизированный stack |
| `metadata` | `JSONB` | да | Совместимые дополнительные поля |
| `userId` | `TEXT` | да | Диагностический user id, без FK |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |

Ключи и индексы: PK `id`; indexes `type`, `service`, `createdAt`,
`correlationId, createdAt` и `service, operation, createdAt`.

### `admin_audit_logs` (`AdminAuditLog`)

| Поле | PostgreSQL | Null | Назначение |
|---|---|---:|---|
| `id` | `TEXT` | нет | Prisma `uuid()`; PK |
| `actorId` | `VARCHAR(160)` | нет | Safe admin actor id snapshot |
| `actorUsername` | `TEXT` | нет | Username snapshot |
| `action` | `VARCHAR(80)` | нет | Шесть allowlisted mutation actions |
| `entityType` | `VARCHAR(80)` | нет | `user`, `prompt`, `error_log` |
| `entityId` | `VARCHAR(160)` | да | Target identifier; обязателен для success |
| `outcome` | `VARCHAR(16)` | нет | `success` или `failure` |
| `requestId` | `VARCHAR(160)` | нет | Safe request identifier |
| `correlationId` | `VARCHAR(160)` | нет | Safe correlation identifier |
| `before` / `after` | `JSONB` | да | Только action-specific allowlisted metadata |
| `failureCode` | `VARCHAR(80)` | да | Обязательный allowlisted code для failure |
| `createdAt` | `TIMESTAMPTZ(3)` | нет | `CURRENT_TIMESTAMP` |

Таблица append-only на уровне Admin API. Индексы имеют стабильный suffix
`createdAt DESC, id DESC`: общий, по actor, entity, action и outcome. SQL CHECK
ограничивает identifiers, action/entity compatibility, outcomes/failure codes
и форму success/failure row. Actor id намеренно не FK: запись сохраняет snapshot
даже после изменения auth-контура.

## SQL-инварианты, которых нет в Prisma DSL

`prisma migrate deploy` обязателен: следующие гарантии находятся в SQL, а не
полностью выражены в `schema.prisma`.

### Scheduled delivery и conversation

- Scheduled metadata либо заполнена целиком (`source=scheduled`,
  `scheduledFor`, key, local date, timezone snapshot), либо полностью пуста для
  не-scheduled row.
- `claimToken` и `claimExpiresAt` всегда оба null или оба non-null.
- Delivery error code соответствует `^[a-z0-9_]{1,64}$`.
- `sent` требует `sentAt` и attempt без ошибки; `failed` требует attempt и
  error pair без `sentAt`; `pending` бывает pristine либо хранит ambiguous
  attempted outcome, но не `sentAt`.
- Триггер `user_prompts_scheduled_identity_immutable` запрещает менять у уже
  scheduled row `source`, `userId`, `scheduledFor`, occurrence key, local date
  и timezone snapshot.
- Conversation `open` требует null `conversationClosedAt`, `closed` — non-null.

### Report generation и delivery

- Generation claim lease и generation error представлены полными парами.
- Generation error code соответствует `^[a-z0-9_]{1,64}$`.
- `generated` требует generation metadata и content, кроме уже purged row;
  `failed` требует error pair; `generating` требует полную lease-пару, включая
  истёкшую и доступную для reclaim. Успешное и failed состояния не сохраняют
  claim.
- Если `sensitiveDataPurgedAt` задан, `voiceFileId`, `transcript` и `analysis`
  обязаны быть null.
- Delivery claim lease и delivery error представлены полными парами; error code
  имеет тот же lowercase-safe формат.
- `chunks` — непустой JSON array, а `nextChunkIndex` находится между 0 и его
  длиной. `delivered` указывает конец массива и timestamp; `failed` остаётся до
  конца массива и хранит error; `pending` представляет claimed state (lease
  может истечь и быть reclaimed) либо
  terminal ambiguous attempt с сохранённой ошибкой, который автоматически не
  reclaim-ится.

### Quota и observability

- `quota_windows.windowEnd > windowStart`.
- Триггер `user_requests_quota_window_identity_check` проверяет, что указанный
  quota window принадлежит тому же `userId` и `action`.
- Триггер `quota_windows_identity_immutable` запрещает менять user, action,
  timezone snapshot и границы существующего окна.
- `error_logs.operation`, `correlationId` и `errorKind` ограничены безопасным
  алфавитом `[A-Za-z0-9_.:-]` и длиной своих колонок; `statusCode` — 100..599,
  `latencyMs >= 0`.

## Временной контракт

- Runtime-created `timezone` и snapshots используют canonical IANA timezone;
  aliases нормализуются, пустое или невалидное legacy-значение заменяется на
  `Europe/Moscow`. Quota backfill мог сохранить PostgreSQL-valid alias в уже
  существующем immutable окне до его истечения.
- Новый пользователь получает schedule 13:00 Europe/Moscow. Enabled schedule
  должен иметь `nextPromptAt`, disabled — null; startup normalization исправляет
  legacy-строки без отправки сообщения.
- Расчёты local date/DST не зависят от `TZ` Node.js/container или PostgreSQL
  session `TimeZone`. На spring-forward gap выбирается первая валидная минута
  после gap, при fall-back overlap — более раннее вхождение.
- Claim берёт только последний overdue slot и записывает следующий slot строго
  после `now`. Due users блокируются `FOR UPDATE SKIP LOCKED`.
- Occurrence key равен `scheduled:<userId>:<local-date>` и не включает timezone.
  После claim key, `scheduledLocalDate`, `scheduledFor` и snapshot неизменяемы;
  изменение настроек влияет только на ещё не claimed occurrence.
- Calendar quota использует полуоткрытое `[windowStart, windowEnd)` локальное
  календарное окно. Snapshot и границы сохраняются, поэтому смена timezone не
  открывает второй allowance; DST-день может длиться 23 или 25 часов.

## Retention

Три срока конфигурируются независимо, по умолчанию 30 дней (допустимо
1..3650): `RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS`,
`RETENTION_RATE_LIMIT_DAYS`, `RETENTION_ERROR_LOGS_DAYS`.

Cleanup запускается ежедневно в 03:30 по runtime clock и выполняется одной
транзакцией. Cutoff — точное число 24-часовых суток назад от `now`, не локальная
календарная дата.

- Для закрытых разговоров старше content cutoff удаляются delivery-request rows
  вместе с их chunks и conversation messages; в response обнуляются
  `voiceFileId`, `transcript`, `analysis` и ставится `sensitiveDataPurgedAt`.
  Conversation/report generation lifecycle и prompt-delivery provenance
  сохраняются, но lifecycle отдельных удалённых delivery requests — нет.
  Несекретные `firstUserMessageAt`, `user_activity_days`, `overallScore` и
  `reportDeliveredAt` сохраняются, поэтому аналитика не зависит от удалённого content.
- Старые `user_requests` удаляются только если они не связаны с calendar window
## Admin runtime settings

`runtime_settings` is a checked singleton (`id = 'singleton'`) with JSON object
columns for product and infrastructure overrides, independent non-negative CAS
versions, updater attribution, and timestamptz audit fields. Migration
`20260810140000_admin_runtime_settings` creates and seeds the row and extends
the admin-audit action/entity checks for the two settings mutations. Secret
values are never stored in this table; only closed-registry safe overrides are
accepted by the application. Mutation plus success audit share one database
transaction, so an audit failure rolls back the settings version and JSON.

  либо это окно уже закончилось. Так cleanup не ломает активное, в том числе
  25-часовое DST-окно.
- Пустые quota windows удаляются, когда `windowEnd` старше rate-limit cutoff.
- `error_logs` старше своего cutoff удаляются.
- `admin_audit_logs` удаляются только при `createdAt < now - 365 days`; cleanup
  идемпотентен и не смешивает audit retention с operational error logs.

## История миграций и backfill

- `20260728120000_optional_prompt_audio`: сделал prompt audio nullable и
  нормализовал пустые/пробельные file id в null.
- `20260806120000_delivery_lifecycle`: явно переинтерпретировал legacy
  `TIMESTAMP(3)` как UTC при переходе к `TIMESTAMPTZ(3)`; классифицировал legacy
  prompt instances по downstream evidence; ambiguous legacy delivery оставил
  terminal pending с `legacy_unknown`; сбросил ненадёжный legacy `nextPromptAt`
  для безопасной startup repair. Миграция ничего не отправляет.
- `20260808120000_report_lifecycle`: восстановил отсутствующие transcripts из
  user conversation messages, классифицировал валидные legacy JSON reports,
  отметил неполные как `failed/legacy_incomplete`, вычислил закрытие диалогов и
  добавил схему persisted report delivery state, не создавая delivery rows для
  legacy-ответов.
- `20260808140000_quota_windows`: создал calendar windows для legacy
  `dialog_start` по валидной timezone пользователя либо Europe/Moscow fallback
  и привязал requests к ним, предотвращая quota reset при deploy.
- `20260808160000_retention_and_error_correlation`: разрешил безопасную очистку
  speech/report content с сохранением lifecycle и вынес bounded observability
  dimensions в отдельные колонки.
- `20260808180000_prompt_selection_history`: добавил descending history index
  для атомарного исключения последних prompt reservations.
- `20260810160000_admin_analytics_facts`: backfill-ит и индексирует несекретные
  activity/funnel/score/delivery facts; временная PL/pgSQL-функция безопасно
  извлекает только валидный top-level `overallScore` и удаляется в той же миграции.

- `20260810120000_admin_audit_log`: добавил отдельный append-only audit storage
  с action/entity/outcome/failure CHECK constraints и stable inspection indexes.

Production deployment должен делать backup и выполнять
`npm run prisma:migrate:deploy` (или `npm run deploy:init`, который затем запускает
идемпотентный seed). Нельзя заменять цепочку миграций одним `prisma db push`:
иначе будут потеряны partial index, CHECK constraints, triggers и backfill.

## Связанная документация

- [Архитектурная карта данных и состояний](architecture/05-data-and-state.md)
- [Архитектурный индекс](architecture/README.md)
- [Application contract](app.md)
- [Operations runbook](operations.md)
