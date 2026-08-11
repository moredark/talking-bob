# Admin audit log

- Priority: `P0`
- Status: `done`
- Scope: admin mutations, append-only audit storage and inspection
- Admin: in scope
- Depends on: `01`
- Blocks: `04`, `05`, `07`

## Проблема

Изменения пользователей, prompts и будущих runtime settings/broadcasts выполняются без надёжного ответа на вопросы «кто, что и когда изменил». Существующий `error_logs` предназначен для операционных ошибок, имеет другую retention-семантику и не может служить журналом административных действий.

## Связанные файлы

- `prisma/schema.prisma`
- `prisma/migrations/`
- `src/modules/admin/admin.controller.ts`
- `src/modules/admin/admin.service.ts`
- `src/modules/auth/auth.guard.ts`
- `src/modules/auth/auth.service.ts`
- `admin/src/api/admin.api.ts`
- `admin/src/router/index.ts`
- `admin/src/components/adminNavigation.ts`
- `admin/src/pages/`

## План реализации

1. Добавить отдельную append-only модель `AdminAuditLog` после migration задачи `01`.
2. Хранить actor admin ID и username snapshot, action, entity type/ID, outcome, request/correlation ID, sanitized before/after metadata, createdAt и безопасный failure code.
3. Создавать success-запись в той же DB transaction, что и административная мутация; невозможность записать audit отменяет мутацию.
4. Для отклонённых/неуспешных попыток писать failure audit отдельным best-effort путём, не заменяя исходную ошибку.
5. Ввести централизованный audit writer и allowlist sanitizer; не размазывать ручную сборку audit payload по controllers.
6. Подключить все существующие mutations: update user, reset progress, create/update/delete prompt и `DELETE /admin/error-logs/old`; затем использовать тот же boundary в задачах `04` и `05`.
7. Добавить `GET /admin/audit-logs?page&limit&actorId&action&entityType&entityId&outcome&from&to` с `PaginatedResult<AdminAuditListItem>` и stable `createdAt desc,id desc`; `GET /admin/audit-logs/:id` возвращает detail с sanitized before/after. SPA реализует список, фильтры и detail.
8. Запретить update/delete audit rows через application API. Хранить audit 365 дней от `createdAt`, затем удалять daily retention job; queued export и UI-кнопка очистки в MVP отсутствуют.

## Acceptance criteria

- Каждая успешная admin mutation атомарно создаёт ровно одну audit-запись с actor и целевой сущностью.
- Очистка старых error logs также создаёт audit с cutoff и deleted count без содержимого удалённых logs.
- При rollback mutation success audit не остаётся; при failure исходный статус/ошибка сохраняются.
- Audit metadata не содержит JWT, password/hash, transcript, conversation content, analysis, prompt provider payload и произвольный stack.
- Audit list защищён auth, paginated, детерминирован и фильтруется на backend.
- Через Admin API нельзя изменить или удалить audit-запись.
- Audit и operational error logs остаются разными сущностями и страницами.
- Daily cleanup удаляет только audit rows с `createdAt < now - 365 days`; повторный запуск идемпотентен и не затрагивает более новые записи.

## Проверки

- Migration/backfill smoke на fresh и существующей БД.
- Transaction tests: mutation+audit commit и совместный rollback.
- Tests sanitizer и failure audit path.
- API tests auth, filters, UTC boundaries и pagination.
- Admin tests loading/empty/error/detail/filter states.
- `npm run test:ci`
- `npm run test:postgres`
- `npm --prefix admin test`
- `npm --prefix admin run build`

## Риски и решения

- Audit log не является event-sourcing источником состояния; бизнес-таблицы остаются source of truth.
- Полные before/after snapshots увеличивают объём и риск утечки; сохранять только allowlisted изменённые поля и безопасные идентификаторы.
- Success audit должен быть атомарным, а failure audit — best effort, иначе сбой audit storage может скрыть полезную исходную ошибку.
- Audit retention фиксирован в 365 дней и не смешивается с 30-дневным сроком AI raw content.

## Реализовано

- Добавлена append-only модель `AdminAuditLog`, migration с allowlist/check constraints и пятью stable-order индексами.
- Введён request-scoped audit context с JWT actor snapshot, нормализацией/generation request и correlation IDs и их возвратом в response headers.
- Все шесть существующих admin mutations выполняют business write и success audit в одной Prisma transaction; failure audit пишется один раз best effort и не заменяет исходную ошибку.
- Централизованный sanitizer сохраняет только утверждённые безопасные поля; raw prompt content, audio IDs, banned reason и operational error content в audit не попадают.
- Добавлены защищённые list/detail endpoints со строгими filters, UTC half-open interval `[from,to)`, pagination и stable `createdAt desc,id desc`; mutation API для audit отсутствует.
- Daily retention удаляет audit rows строго старше 365 дней.

## Проверено

- `npx prisma validate` — успешно.
- `npm run build` — успешно.
- `node --test test/admin-auth.test.js test/admin-contracts.test.js test/admin-audit.test.js` — успешно, 21 тест.
- `npm run test:ci` — успешно, 215 тестов.
- `npm run test:postgres` — успешно: 8 critical PostgreSQL tests, fresh migrations, backup/restore и legacy timezone matrix.
- `git diff --check` — успешно.
