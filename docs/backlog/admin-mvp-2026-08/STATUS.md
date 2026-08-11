# Статус выполнения Admin MVP backlog

Обновлено: 2026-08-10

Этот файл — точка продолжения реализации. Перед началом и после завершения каждой задачи обновляются таблица, текущий фокус и журнал проверок. Подробные acceptance criteria остаются в task-файлах.

## Сводка

| Задача | Статус | Прогресс | Последняя проверка |
|---|---|---|---|
| 01 Admin-контракты и тестовый baseline | `done` | Контракты, validation, stable ordering и baseline-тесты | 2026-08-10: все проверки успешны |
| 02 Admin audit log | `done` | Atomic audit, strict inspection API и 365-day retention | 2026-08-10: backend и PostgreSQL gates успешны |
| 03 Просмотр сессий в admin | `done` | AI retention uses independent short atomic batches | 2026-08-10: build and 33 affected tests successful |
| 04 Runtime-настройки в admin | `done` | Closed registry, strict bootstrap, CAS/audit API and hot consumers | 2026-08-10: all backend, PostgreSQL and admin gates successful |
| 05 Admin-рассылки | `done` | Backend, schema, Telegram worker, SPA, retention и review завершены | 2026-08-10: scoped build/tests/PostgreSQL/admin gates успешны |
| 06 Admin-аналитика и графики | `in-progress` | API/SPA реализованы; закрывается upgrade coverage contract | 2026-08-10: backend/admin focused gates успешны |
| 07 Интеграция и rollout Admin MVP | `in-progress` | Local rollout gate, Admin image verifier и runbooks реализованы; staging pending | 2026-08-10: build + focused 6/6 + diff check успешны |

## Текущий фокус

Задачи `01`–`05` завершены; текущий фокус — финализация `06` и local/staging gate `07`.

## Принятые рабочие решения

- Migration merge order: `01` → `02` → `03` → `04` → `05` → `06` (`20260810160000_admin_analytics_facts`).
- `06` использует retention-safe facts и явную границу полноты исторических данных; UI строит графики через Unovis Vue и shadcn-vue.
- `07` остаётся `in-progress` до live migration/restart/delivery/monitoring evidence.
- Только extracted raw AI response content и allowlisted metadata хранятся 30 дней; request/system prompt, headers и полный JSON не сохраняются.
- Runtime settings hybrid: hot product overrides применяются на следующем admission, infrastructure overrides требуют restart, readonly не изменяются, secrets показывают только `configured`; `process.env` не мутируется.
- Broadcasts используют отдельный opt-out, точные filters и queued/processing lifecycle; immediate/scheduled время вводится по Москве, хранится как UTC instant.
- Retention: AI calls 30 дней; session content — effective closed-conversation срок (default 30); audit 365; terminal broadcast content/recipients 90 и aggregate rows 365 дней.
- Существующие незакоммиченные изменения других участников сохраняются.

## Журнал проверок

- 2026-08-10, задача `01`: `npm run build` — успешно.
- 2026-08-10, задача `01`: `npm run test:ci` — успешно, 201 тест.
- 2026-08-10, задача `01`: `npm --prefix admin test` — успешно, 17 тестов.
- 2026-08-10, задача `01`: `npm --prefix admin run build` — успешно.
- 2026-08-10, задача `01`: `git diff --check` — успешно.
- 2026-08-10, review fixes задачи `01`: `npm run build` и `node --test test/admin-contracts.test.js` — успешно, 10 contract-тестов.
- 2026-08-10, review fixes задачи `01`: `npm --prefix admin test` — успешно, 17 тестов; `git diff --check` — успешно.
- 2026-08-10, задача `02`: `npx prisma validate`, `npm run build` и focused admin/auth/audit tests — успешно, 21 тест.
- 2026-08-10, задача `02`: `npm run test:ci` — успешно, 215 тестов.
- 2026-08-10, задача `02`: `npm run test:postgres` — успешно: 8 critical PostgreSQL tests, fresh migrations, backup/restore и legacy timezone matrix.
- 2026-08-10, задача `02`: `git diff --check` — успешно.
- 2026-08-10, задача `03`: focused session/trace/retention suite — успешно (9 тестов после test review).
- 2026-08-10, задача `03`: `npm run test:ci` — успешно, 226 тестов; admin tests — 21 тест.
- 2026-08-10, задача `03`: `npm run test:postgres` — успешно: 9 critical PostgreSQL tests, 15 fresh migrations, backup/restore и legacy timezone matrix.
- 2026-08-10, задача `03`: admin build и `git diff --check` — успешно.
- 2026-08-10, review fixes задачи `03`: build и focused auth/admin/trace/retention/workflow tests — успешно, 50 тестов.
- 2026-08-10, review fixes задачи `03`: `npm run test:ci` — успешно, 227 тестов; admin tests — 20 тестов; admin build успешен.
- 2026-08-10, review fixes задачи `03`: `npm run test:postgres` — успешно, 9 critical tests; `git diff --check` — успешно.
- 2026-08-10, задача `04`: focused settings/audit/consumer suite — успешно, 25 тестов.
- 2026-08-10, задача `04`: `npm run test:ci` — успешно, 245 тестов; Prisma schema valid.
- 2026-08-10, задача `04`: `npm run test:postgres` — успешно, 10 tests, 16 migrations, backup/restore и timezone matrix.
- 2026-08-10, задача `04`: admin tests — 21 тест; backend/admin builds и `git diff --check` успешны.
- 2026-08-10, review fix задачи `04`: product hot snapshot сделан монотонным по version; out-of-order regression test, focused 25/25 и `npm run test:ci` 245/245 успешны.
- 2026-08-10, final review задачи `03`: AI trace batches вынесены из общей cleanup transaction; build и 33 affected tests успешны.
- 2026-08-10, задача `05`: Prisma generate/validate и backend build успешны; focused broadcast/retention/audit/Telegram проверки успешны.
- 2026-08-10, задача `05`: PostgreSQL gate успешен — 11 tests, 17 migrations, audience/consent/audit/CAS invariants, backup/restore и legacy backfill matrix.
- 2026-08-10, review fixes задачи `05`: coordinated broadcast shutdown, strict UTC validation и atomic terminal counters; build + combined focused 63 assertions успешны; `git diff --check` успешен.
- 2026-08-10, задача `05`: финальный re-review и combined gates ожидаются перед переводом в `done`.

## Следующая точка продолжения

Закрыть upgrade coverage contract задачи `06`, выполнить coordinated local gates задачи `07`, затем записать staging evidence; без него `07` не переводить в `done`.
