# Просмотр сессий в admin

- Priority: `P1`
- Status: `done`
- Scope: conversation/session list and sensitive AI detail
- Admin: in scope
- Depends on: `01`
- Blocks: `06`, `07`

## Проблема

Admin показывает агрегированные responses, но не позволяет восстановить ход конкретного учебного диалога, увидеть lifecycle доставки/генерации и диагностировать качество AI-ответа. При этом transcript, сообщения, analysis и provider metadata чувствительны и требуют явного доступа и ограниченного срока хранения.

## Связанные файлы

- `prisma/schema.prisma`
- `prisma/migrations/`
- `src/modules/admin/admin.controller.ts`
- `src/modules/admin/admin.service.ts`
- `src/modules/conversation/`
- `src/modules/response/`
- `src/modules/ai/`
- `src/modules/error-log/data-retention.service.ts`
- `admin/src/api/admin.api.ts`
- `admin/src/router/index.ts`
- `admin/src/components/adminNavigation.ts`
- `admin/src/pages/UserDetailPage.vue`

## План реализации

1. Определить session как один `UserPrompt` с conversation messages, optional `UserResponse`, delivery/generation status и timestamps; не создавать параллельную копию разговора.
2. Добавить `GET /admin/sessions?page&limit&userId&topic&source&deliveryStatus&conversationStatus&generationStatus&from&to` с `PaginatedResult<SessionListItem>`, stable `createdAt desc,id desc`; list item содержит IDs, user/topic, statuses, turn count и timestamps, но не raw content.
3. Добавить `GET /admin/sessions/:id`; detail возвращает prompt/user/source, delivery/conversation lifecycle, ordered messages, transcript, discriminated analysis, report delivery attempts, связанные `AiProviderCall`, safe error codes, timestamps и `contentPurged` flags. Purged поля равны `null`, а не пустой строке.
4. Добавить модель `AiProviderCall`, связанную с session/response. Feature-разработка зависит только от `01`, но migration `03` мержится после migration `02` по общему migration order. Модель хранит только extracted raw response content и metadata: `operation` (`follow_up|analysis`), model, attempt, outcome (`succeeded|empty|failed`), provider status, latency, optional token usage и ссылки на связанные user/session/response/correlation IDs.
5. Не сохранять в `AiProviderCall` request/system prompt, HTTP headers, credentials, signed URLs или полный provider JSON/body. Extraction выполняется до записи; для error/empty сохраняются только безопасные status/metadata.
6. Невалидный JSON успешного analysis-вызова считается успешным provider call (`outcome=succeeded`), а итоговый `UserResponse.analysisKind` становится `fallback`; transport/provider failure остаётся `failed`.
7. Trace write — best effort: failure записи `AiProviderCall` проходит через sanitized error logging, но не ломает follow-up/report flow и не заменяет provider result.
8. Существующий raw session content очищать только для закрытых conversations через effective `RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS` (default 30) от `conversationClosedAt`. `AiProviderCall` удалять независимо через фиксированные 30 дней от собственного `createdAt`, включая calls открытых sessions. После purge detail явно показывает `contentPurged`/partial trace coverage.
9. Не продлевать retention при admin-просмотре и не копировать raw content в audit/error/application logs.
10. Добавить SPA list/detail, явный sensitive-content affordance, copy только по осознанному действию и состояния loading/empty/error/purged.
11. Из карточки пользователя добавить переход к его отфильтрованным сессиям без загрузки всех responses в основной user payload.

## Acceptance criteria

- Admin находит сессию по пользователю/периоду/status и видит корректную хронологию без N+1 запросов на строку списка.
- Detail различает model/fallback/legacy analysis, pending/failed lifecycle и отсутствующий либо purged content.
- Transcript, messages, raw analysis и extracted raw provider response доступны только под `AuthGuard` и не входят в list payload.
- `AiProviderCall` содержит только утверждённые поля; request/system prompt, headers и полный JSON отсутствуют в БД и API.
- Invalid analysis JSON отражён как `AiProviderCall.outcome=succeeded` плюс `analysisKind=fallback`.
- Ошибка trace write не меняет пользовательский результат и не прерывает conversation/report flow.
- Raw session content очищается по effective closed-conversation retention от `conversationClosedAt`, а каждый `AiProviderCall` — через фиксированные 30 дней от собственного `createdAt`; обе очистки идемпотентны и не ломают list/detail/analytics.
- Admin-view не создаёт копий чувствительных данных и не меняет retention deadline.

## Проверки

- API tests auth, filters, stable pagination, chronological ordering и not-found.
- Tests model/fallback/legacy/pending/failed/purged detail variants.
- Tests `succeeded|empty|failed`, attempts/usage, invalid JSON fallback и trace-storage failure.
- Fixed-time retention tests на границе 30 дней и повторный cleanup.
- Query-count или integration test против N+1 для session list.
- Admin tests sensitive/purged/loading/empty/error states и user deep link.
- `npm run test:ci`
- `npm run test:postgres`
- `npm --prefix admin test`
- `npm --prefix admin run build`

## Риски и решения

- Admin inspection не продлевает хранение: session content живёт effective configured срок после close, а AI call — фиксированные 30 дней после собственного creation.
- Существующий `analysis` может быть legacy JSON; backend возвращает discriminated/versioned представление, а invalid новый JSON использует существующий fallback report без ложной provider failure.
- Список не должен возвращать raw content: это снижает payload и область случайной утечки.
- Если текущая retention очищает поле раньше/позже, одна политика становится source of truth и документируется в `docs/database.md`.

## Реализовано

- Добавлены migration/schema для `AiProviderCall`, `contentPurgedAt` и durable `aiTracePurgedAt` с DB checks, FK и индексами.
- LLM trace записывается один раз на каждый фактический HTTP attempt на extracted-content boundary; prompts, headers и полный provider JSON writer не принимает.
- Voice follow-up и report analysis передают user/session/response context; trace persistence и fallback logging остаются best effort.
- Добавлены strict list/detail API с half-open filters, stable ordering, list без raw content и detail с model/fallback/legacy и purge markers.
- Retention независимо удаляет AI calls старше 30 дней, помечает затронутые sessions и очищает content только у старых закрытых conversations; reset удаляет AI calls первым.
- `JWT_SECRET` обязателен в validated runtime config, retired public fallback отклоняется при bootstrap, AuthService получает secret только через DI.
- Active observability correlation связывает Telegram update с follow-up и report provider calls.
- UserDetail возвращает только profile/aggregates без raw response history; детальная история принадлежит session inspection.
- AI trace retention обрабатывает deterministic batches по 500 calls без unbounded ID materialization.

## Проверено

- Review-focused build/tests — успешно: 50/50.
- `npm run test:ci` — успешно: 227/227.
- `npm run test:postgres` — успешно: 9/9, fresh 15 migrations, backup/restore и legacy timezone matrix.
- `npm --prefix admin test` — успешно: 20/20.
- `npm --prefix admin run build` — успешно.
- `git diff --check` — успешно.
