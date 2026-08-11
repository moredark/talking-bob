# Admin-рассылки

- Priority: `P1`
- Status: `done`
- Scope: announcement authoring, audience filters, scheduling and delivery
- Admin: in scope
- Depends on: `02`
- Blocks: `06`, `07`

## Проблема

Admin не умеет отправлять сервисные или продуктовые объявления пользователям. Переиспользование учебного scheduler или флага `dailyPromptEnabled` смешало бы разные согласия, lifecycle и метрики, а массовая отправка без persisted snapshot/attempts дала бы дубли и недоказуемый результат.

## Связанные файлы

- `prisma/schema.prisma`
- `prisma/migrations/`
- `src/modules/admin/`
- `src/modules/telegram/telegram.service.ts`
- `src/modules/schedule/`
- `src/modules/user/`
- `admin/src/api/admin.api.ts`
- `admin/src/router/index.ts`
- `admin/src/components/adminNavigation.ts`
- `admin/src/pages/`

## План реализации

1. Добавить модели `Broadcast` и `BroadcastRecipient`; не переиспользовать `UserPrompt`. Реализацию можно вести после `02`, но migration `05` мержится после `04`. `Broadcast` хранит content, filters snapshot, mode, Moscow input/UTC `scheduledAt`, status и aggregate counts; recipient хранит user snapshot/link, status, attempt/claim, `nextAttemptAt`, `deliveryAttemptedAt` и safe error metadata.
2. Lifecycle broadcast: `queued|processing|completed|completed_with_errors|cancelled`. Lifecycle recipient: `pending|sent|failed|ambiguous|skipped`. Scheduled broadcast остаётся `queued` до due instant; отдельные draft/scheduled/sending статусы не вводятся.
3. Поддержать одно plain-text Telegram message без `parse_mode`; content обязателен и не превышает существующий `TELEGRAM_TEXT_MESSAGE_LIMIT=4096` UTF-16 code units. Oversize отклоняется при preview/create, chunking в MVP нет.
4. Audience всегда ограничена `User.status=active`, отсутствием ban и `announcementEnabled=true`. Дополнительные фильтры строго: `languageLevels[]`, `activity=any|7d|30d|90d|never`, `dailyPromptEnabled=true|false|any`. Activity означает хотя бы одно `ConversationMessage.role=user` в соответствующем окне; `never` — отсутствие пользовательских сообщений за всё время.
5. Отдельный `announcementEnabled` по умолчанию `true` для существующих пользователей; bot даёт opt-out/opt-in отдельно от `dailyPromptEnabled`. Admin не может изменить этот consent или обойти его.
6. Зафиксировать API: `POST /admin/broadcasts/preview` принимает `{ content, filters, mode, scheduledFor? }` и возвращает normalized input с audience count; `POST /admin/broadcasts` с тем же DTO атомарно создаёт broadcast/snapshot и возвращает detail; `GET /admin/broadcasts?page&limit&status&from&to` возвращает paginated list; `GET /admin/broadcasts/:id?recipientPage&recipientLimit&recipientStatus` — detail/counts и paginated recipients; `POST /admin/broadcasts/:id/cancel` возвращает обновлённый detail или `409`.
7. Preview ничего не сохраняет. Authoritative snapshot создаётся только вместе с broadcast. Worker claim-ит recipient, затем непосредственно перед Telegram API I/O повторно проверяет status/ban/opt-out; несоответствие становится `skipped`. Opt-out между проверкой и началом I/O остаётся неизбежным узким race и фиксируется как ограничение.
8. Immediate create ставит `scheduledAt=now`; scheduled принимает Moscow wall time (`Europe/Moscow`), валидирует future instant и сохраняет UTC. UI показывает исходную Moscow semantics и точный UTC instant.
9. Bounded dispatcher использует claims/lease. Retryable definite-no-delivery outcome, включая `429`, остаётся `pending` с `nextAttemptAt` и ретраится максимум 5 раз; `429` не раньше `retry_after`. После пятой неуспешной попытки recipient становится `failed`. Перед I/O атомарно записывается `deliveryAttemptedAt`; истёкший claim с начатым I/O и без подтверждённого результата reclaim переводит в `ambiguous` без повторной отправки.
10. Cancel разрешён только пока broadcast `queued`; после перехода в `processing` endpoint отвечает `409`. Отмена processing/отзыв уже sent messages в MVP отсутствуют.
11. При cancel все `pending` recipients становятся `skipped` с code `broadcast_cancelled`, а broadcast остаётся `cancelled`. Для неотменённого broadcast terminal status становится `completed`, если recipients только `sent/skipped`, и `completed_with_errors`, если есть `failed/ambiguous`; status выставляется только когда pending rows не осталось.
12. После terminal timestamp хранить content и recipient rows 90 дней, затем очистить content и удалить recipients, сохранив aggregate counts/status. Aggregate broadcast row удалять через 365 дней; queued/processing broadcasts retention не затрагивает.
13. Все create/cancel действия пишутся через audit log задачи `02`; полный content в audit/error metadata не включается. UI реализует preview, create, list, detail и cancel с loading/empty/error/disabled states.

## Acceptance criteria

- Существуют ровно модели `Broadcast`/`BroadcastRecipient`, пять broadcast statuses и пять recipient statuses из плана.
- Plain text отправляется одним Telegram message без `parse_mode`; oversize rejected до persistence, chunking отсутствует.
- Preview и snapshot применяют точные filters `languageLevels`, `activity`, `dailyPromptEnabled` поверх active/not-banned/opted-in ограничения.
- `dailyPromptEnabled` и `announcementEnabled` независимы; пользовательский opt-out нельзя обойти через admin filter/API.
- Реализованы точные preview/create/list/detail/cancel endpoints; preview не пишет БД, create атомарно материализует snapshot.
- Immediate и scheduled Moscow send сохраняют однозначный UTC instant; duplicate ticks/restart не создают второго recipient/send claim.
- После claim и непосредственно перед Telegram I/O повторно проверяются status/ban/opt-out; выбывший recipient становится `skipped`.
- Telegram `429` уважает `retry_after`; retries остаются pending и исчерпываются после 5 попыток; ambiguous outcome не ретраится.
- Terminal broadcast status и cancel transitions выводятся из recipient rows по правилам плана; totals detail согласованы со status rows.
- Terminal content/recipients очищаются через 90 дней, aggregate row — через 365; активные broadcasts не очищаются.
- Cancel работает только для `queued`; для `processing` и terminal status возвращается `409`.

## Проверки

- Migration/backfill test отдельного `announcementEnabled` с default subscribed semantics.
- API contract tests точных methods/paths, preview no-write, atomic create, pagination/detail и cancel `409`.
- Audience tests active/banned/opt-out, `languageLevels`, все activity values, `dailyPromptEnabled` и комбинации.
- Fixed-time tests Moscow→UTC, past/invalid schedule, immediate now и duplicate scheduler ticks.
- Delivery tests opt-out after claim/before I/O, success, `429 retry_after`, attempt exhaustion, permanent/ambiguous failure, crash after I/O start, restart/reclaim и bounded concurrency.
- State tests terminal derivation и cancel pending-to-skipped; fixed-time retention tests 90/365-day boundaries.
- Validation tests 4096/4097 UTF-16 boundaries, surrogate pair, empty content, отсутствие chunking/`parse_mode`.
- Audit tests create/cancel без полного content.
- Bot tests opt-out/opt-in и независимость daily prompts.
- Admin tests preview/create/list/detail/cancel и loading/empty/error/disabled states.
- `npm run test:ci`
- `npm run test:postgres`
- `npm --prefix admin test`
- `npm --prefix admin run build`

## Риски и решения

- Telegram массовая отправка выполняется background dispatcher, а не HTTP request; concurrency ограничена.
- Preview может устареть; authoritative snapshot создаётся атомарно при `POST /admin/broadcasts`.
- Opt-out/status могут измениться после snapshot; обязательный post-claim/pre-I/O recheck минимизирует race и не позволяет worker сознательно отправлять уже отписавшемуся пользователю.
- Ambiguous Telegram outcome не ретраится автоматически, чтобы не создать дубликат.
- Cancel после начала processing сознательно запрещён `409`, чтобы не обещать невозможный отзыв.
- Broadcast не расходует учебный `dialog_start` quota и не участвует в prompt/report lifecycle.

## Реализовано

- Migration `20260810150000_admin_broadcasts`: отдельный consent `announcementEnabled` с subscribed backfill, `Broadcast`/`BroadcastRecipient`, lifecycle/claim/count/content CHECK constraints и audit allowlist.
- Ровно пять защищённых admin API: preview, atomic create/snapshot, paginated list/detail и queued-only cancel. Audience snapshot выполняется одним параметризованным `INSERT ... SELECT` в транзакции с success audit; content в audit/error metadata не сохраняется.
- Строгие filters active/not-banned/opted-in + language/activity/daily, UTF-16 лимит 4096, Moscow wall-time → UTC, strict calendar-valid UTC instants и half-open activity/date semantics. Activity опирается на retention-safe `User.lastUserMessageAt`: migration backfill-ит максимум user-role message, а accepted turn обновляет marker монотонно в той же транзакции.
- Durable dispatcher: due transition, `SKIP LOCKED` claims по 20, concurrency 5, lease 180 секунд, обязательный pre-I/O consent/status recheck, attempt marker, max 5, Telegram `429 retry_after`, permanent/ambiguous divergence и terminal derivation. Recipient terminal transition и соответствующий aggregate increment, включая expired post-I/O → ambiguous, фиксируются атомарно; finalizer меняет только status/terminalAt без stale overwrite.
- Telegram `/settings` управляет анонсами независимо от daily schedule; broadcast отправляет одно plain-text message без `parse_mode` и chunking. Telegram shutdown сначала закрывает admission dispatcher, включает активные broadcast sends в общий absolute drain deadline, передаёт AbortSignal в Grammy, fence-ит только локально owned exact id/token claims на deadline, ожидает DB fence до завершения shutdown и дожидается всех sibling workers через allSettled; гарантированно pre-I/O runtime-closed вызов до fence безопасно requeue-ится.
- Terminal content/recipients очищаются строго после 90 суток independent batches по 500, aggregate rows — строго после 365; queued/processing и exact-boundary rows сохраняются.
- Admin SPA реализует create/preview/list/detail/cancel, server pagination, confirmation, purged/empty/loading/error/conflict states.

## Проверено

- `npx prisma generate` и `npx prisma validate` — успешно.
- `npm run build` — успешно.
- Focused broadcast/retention/audit/Telegram suites — успешно; включая UTF-16/surrogate, Moscow, невозможные UTC dates, large DB snapshot, cancel race, Grammy `429`, opt-out, expired lease, pre-I/O shutdown requeue, bounded shared drain deadline, atomic terminal counters, consent independence и 90/365 boundaries/batches. Последний exact P1/P2 focused прогон на общем merged tree: 40 assertions, 0 failures; Prisma validation, backend build и `git diff --check` успешны.
- `npm run test:postgres` — успешно: 11 tests, 17 migrations, atomic audience/consent/audit/CAS invariant, backup/restore и legacy timezone/backfill matrix.
- Финальный review закрыт; cross-feature combined gates выполняются отдельно в задаче `07`.
