# Runtime-настройки в admin

- Priority: `P1`
- Status: `done`
- Scope: allowlisted persisted runtime overrides
- Admin: in scope
- Depends on: `02`
- Blocks: `07`

## Проблема

Все runtime-параметры сейчас управляются через environment и требуют redeploy, но перенос секретов и boot-critical конфигурации в БД создаст неработоспособный startup и новый риск утечки. Нужен ограниченный, аудируемый механизм изменения только безопасных параметров во время работы.

## Связанные файлы

- `src/config/`
- `.env.example`
- `prisma/schema.prisma`
- `prisma/migrations/`
- `src/modules/admin/admin.controller.ts`
- `src/modules/admin/admin.service.ts`
- `src/modules/schedule/`
- `src/modules/rate-limit/`
- `src/modules/error-log/data-retention.service.ts`
- `admin/src/api/admin.api.ts`
- `admin/src/router/index.ts`
- `admin/src/pages/`

## План реализации

1. Составить typed registry с key, group (`product|infrastructure|readonly|secret`), type, hard bounds, env/default resolver, apply mode и consumer; произвольных keys нет.
2. Hot product overrides: rolling rate counts/windows, dialogs/day, `LLM_ANALYSIS_MAX_TOKENS`, `LLM_FOLLOWUP_MAX_TOKENS`, voice duration/size в пределах compile-time hard caps и существующие retention days для error logs/rate-limit/closed-conversation content. Они применяются к следующему admission/request/cleanup cycle без переписывания уже созданных окон. Фиксированный 30-day срок `AiProviderCall` сюда не входит.
3. Restart-required infrastructure overrides: `LLM_MODEL`, Telegram/AI concurrency и max pending, Telegram/external request timeouts и response-size bounds, shutdown drain timeout. PATCH сохраняет override, возвращает `restartRequired=true`, но текущий process продолжает использовать boot effective value до restart.
4. Readonly: port, API/base URLs, database/deployment/image/CORS/seed параметры. API показывает только безопасные effective/source данные там, где это полезно, и никогда не разрешает PATCH.
5. Secrets (`TELEGRAM_BOT_TOKEN`, `CLOUD_RU_API_KEY`, `DATABASE_URL` credentials, `JWT_SECRET`, admin password) возвращаются только как `configured: boolean`; значение/env/override отсутствуют.
6. Добавить singleton `RuntimeSettings` в migration `04` с `productOverrides`, `infrastructureOverrides`, `productVersion`, `infrastructureVersion`, timestamps и updater. Реализацию можно вести после `02`; schema merge выполняется после migration `03` по отдельному merge order. `process.env` никогда не мутируется.
7. Реализовать `GET /admin/settings`, `PATCH /admin/settings/product` и `PATCH /admin/settings/infrastructure`. GET возвращает versioned mutable groups `product`/`infrastructure` и read-only collections `readonly`/`secret`; версии есть только у mutable groups. Строка mutable/readonly содержит разрешённые `envValue`, `overrideValue`, `effectiveValue`, `pendingValue`, `applyMode`, `restartRequired`; secret entry содержит только key/description и `configured`.
8. PATCH принимает `{ expectedVersion, values }` для одной группы; `values` — partial allowlisted object, `null` удаляет конкретный override. Успех атомарно увеличивает version группы и возвращает обновлённую группу. Cross-group key, неверный type/range и stale version дают validation/`409` без частичного применения.
9. Hot consumers читают единый settings service на следующем admission; infrastructure effective пересчитывается при следующем startup. Обеспечить атомарный audit задачи `02` для set/reset без секретов.
10. Если БД недоступна при bootstrap infrastructure overrides, startup/readiness не проходит: молчаливый env fallback запрещён. Невалидный persisted value игнорируется в пользу env/default с sanitized operational error. При временном runtime-сбое БД hot consumers продолжают last known valid snapshot, а PATCH отвечает `503`.
11. Добавить страницу с отдельными product/infrastructure/readonly/secrets секциями, source/apply badges, reset и подтверждением restart-required изменений.

## Acceptance criteria

- Реализованы ровно `GET /admin/settings`, `PATCH /admin/settings/product`, `PATCH /admin/settings/infrastructure`; group boundaries enforced backend-ом.
- GET однозначно различает current `effectiveValue` и restart-only `pendingValue`, возвращает group version/applyMode/restartRequired; secret entries содержат только `configured`.
- Readonly и secrets нельзя изменить; значения secrets нельзя прочитать ни в одном response/audit/error.
- `null` reset удаляет override и восстанавливает env/default без мутации `process.env`.
- Hot override применяется со следующего admission/request/cleanup cycle; infrastructure override — только после restart и до него помечен `restartRequired`.
- Product и infrastructure имеют независимые group versions; multi-key PATCH атомарен, stale version получает `409` и не применяет ни одного ключа.
- Create/update/reset атомарно записываются в audit log без раскрытия чувствительных значений.

## Проверки

- Registry tests на точные groups, hard caps, type/range и запрет PATCH readonly/secret keys.
- API contract tests трёх endpoints, response fields, group isolation и secret `configured` only.
- Service tests precedence `override > env > default`, null reset, отсутствие `process.env` mutation и invalid legacy fallback.
- Concurrency tests product/infrastructure group versions, multi-key conflict и mutation+audit transaction.
- Bootstrap tests DB unavailable, invalid persisted override, current-vs-pending values и effective-after-restart.
- Consumer tests: hot next admission, infrastructure unchanged before restart/effective after restart.
- Admin tests source/apply badges, validation, confirm, stale conflict и reset.
- `npm run test:ci`
- `npm run test:postgres`
- `npm --prefix admin test`
- `npm --prefix admin run build`

## Риски и решения

- Универсальный key/value store слишком легко превращается в удалённый env editor; registry закрыт по умолчанию и требует code change для нового ключа.
- Multi-process cache invalidation вне текущей single-app topology; hot settings читаются через один process-local service на admission boundary.
- Значения с влиянием на уже созданные quota windows/scheduled rows не переписывают прошлое; применяется только документированная forward semantics.
- Hard bounds 1000 for rolling request/dialog counts and 10080 minutes for
  rolling windows are deliberate registry safety caps; defaults remain voice
  10/60, command 30/60, and dialogs/day 20.
- Поле `env` для secret не возвращается даже masked; единственная информация — `configured`.

## Реализовано

- Closed typed registry, strict pre-Nest DB loader, singleton persistence and
  independent CAS versions are implemented without mutating `process.env`.
- Three guarded admin endpoints expose current/pending/source semantics while
  secrets remain `configured` booleans and unsafe deployment descriptors omit values.
- Hot rate/start/LLM/voice/retention consumers read the process-local snapshot
  at admission boundaries; restart-only infrastructure is immutable per boot.
- Both settings mutations use same-transaction key-only audit snapshots.

## Проверено
- `npm run test:ci` — successful, 245 tests; Prisma schema valid.
- `npm run test:postgres` — successful, 10 tests, 16 migrations, backup/restore
  and legacy timezone matrix.
- Focused Task04 plus audit suite — successful, 25 tests.
- Admin tests/build — successful, 21 tests and production build.
