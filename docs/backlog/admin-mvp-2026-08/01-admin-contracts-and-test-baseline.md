# Admin-контракты и тестовый baseline

- Priority: `P0`
- Status: `done`
- Scope: admin API/UI contracts, validation, pagination, contract tests
- Admin: in scope
- Depends on: —
- Blocks: `02`, `03`, `04`, `05`, `06`, `07`

## Проблема

Admin API смешивает interfaces и DTO в одном service-файле, принимает невалидированные строки query/body и не фиксирует единый контракт pagination, ошибок, timestamps и сортировки. Текущие frontend contract tests защищают существующий route set, но не дают безопасной основы для расширения Admin MVP.

## Связанные файлы

- `src/modules/admin/admin.controller.ts`
- `src/modules/admin/admin.service.ts`
- `src/modules/admin/admin.module.ts`
- `src/modules/auth/auth.guard.ts`
- `admin/src/api/admin.api.ts`
- `admin/src/types/index.ts`
- `admin/src/router/index.ts`
- `admin/test/vue-migration.contract.test.mjs`
- `test/`
- `prisma/schema.prisma`

## План реализации

1. Инвентаризировать существующие `/auth/*` и `/admin/*` routes, methods, payloads и frontend consumers; сохранить их совместимость.
2. Исправить фактические расхождения backend/frontend contract: `UserDetail` обязан возвращать `languageLevel`, `status`, `bannedAt`, `bannedReason`; `ErrorLogItem` — `operation`, `correlationId`, `statusCode`, `retryable`, `latencyMs`, `errorKind`, а `GET /admin/error-logs` — принимать и прокидывать фильтр `correlationId`.
3. Вынести новые request/response contracts в явные DTO/types по существующим NestJS-паттернам без переноса бизнес-логики в controller.
4. Ввести общий validated pagination contract: `page >= 1`, ограниченный `limit`, allowlist sort/filter values, стабильная сортировка с `id` как tie-breaker.
5. Зафиксировать timestamps новых endpoints как ISO 8601 UTC и единый sanitized error envelope; не возвращать Prisma errors и stack наружу.
6. Проверить, что каждый новый `/admin/*` endpoint защищён `AuthGuard`, а `401/403/404/409/422` различаются по смыслу.
7. Добавить backend contract tests для auth, validation, pagination, deterministic order и error responses.
8. Расширить admin contract tests: routes/navigation/API methods, type-check и сохранение login redirect/401 behavior.
9. Подготовить test builders/fixtures для admin actor, users, sessions и timestamps, переиспользуемые задачами `02`–`07`.
10. Если baseline требует schema migration, она должна быть первой в Admin MVP chain и не добавлять feature-поля последующих задач.

## Acceptance criteria

- Существующие admin pages и API consumers работают без изменения публичных route contracts.
- Карточка пользователя получает все четыре используемых moderation/profile поля, а error-log list/detail — все шесть operational полей и рабочий `correlationId` filter.
- Невалидные page/limit/filter/sort/body отклоняются до обращения к Prisma.
- Любой новый admin endpoint недоступен без валидного Bearer JWT.
- Списки имеют ограниченный page size и детерминированный порядок при одинаковом основном sort key.
- В ответах и ошибках нет password hash, JWT, provider secrets, stack и Prisma internals.
- Baseline tests локализуют регрессии backend contract и Admin SPA contract отдельно.

## Проверки

- Backend tests на `401`, validation bounds, allowlisted filters и tie-breaker pagination.
- Admin contract tests на routes, navigation, API methods и redirect после `401`.
- Contract regression tests для полей `UserDetail`, `ErrorLogItem` и фильтра `correlationId` от SPA до Prisma query.
- `npm run test:ci`
- `npm --prefix admin test`
- `npm --prefix admin run build`
- `git diff --check`

## Риски и решения

- Глобальное включение validation может сломать bot endpoints; применять его контролируемо к admin DTO либо доказать совместимость общими тестами.
- Массовое переименование текущих types/routes не относится к задаче; новые контракты добавляются рядом с существующими.
- Offset pagination допустима для MVP, но обязана иметь stable tie-breaker; cursor pagination вводится только при доказанной необходимости.
- Новые библиотеки не добавлять без отдельного одобрения.

## Реализовано

- Существующие routes и success payloads сохранены; request/response contracts вынесены в `admin.contracts.ts`.
- Добавлены admin-scoped pipes для pagination, UUID, filters и body validation с ответом `422` до вызова service.
- `AdminService` оставлен публичным фасадом над dashboard/topics, users, prompts и error-log services.
- Добавлены стабильные tie-breakers, недостающие поля `UserDetail`/`ErrorLogItem`, фильтр `correlationId` и field-specific sanitized exception/error-log mapping.
- Review hardening ограничивает `sortOrder` диапазоном PostgreSQL `Int`, сохраняет прямую нормализацию `audioFileId`, скрывает произвольные HTTP 500/P2025 details и валидирует значения allowlisted metadata.
- Добавлены compiled backend contract tests, reusable builders и SPA source-contract coverage.

## Проверено

- `npm run build` — успешно.
- `npm run test:ci` — успешно, 201 тест.
- `node --test test/admin-contracts.test.js` — успешно, 10 тестов.
- `npm --prefix admin test` — успешно, 17 тестов.
- `npm --prefix admin run build` — успешно.
- `git diff --check` — успешно.
