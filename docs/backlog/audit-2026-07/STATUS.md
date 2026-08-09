# Статус выполнения backlog

Обновлено: 2026-08-08

Этот файл — точка продолжения долгой работы. Перед началом и после завершения
каждой задачи обновляются таблица, текущий фокус и журнал проверок. Подробные
acceptance criteria остаются в task-файлах.

## Сводка

| Задача | Статус | Прогресс | Последняя проверка |
|---|---|---|---|
| 01 Runtime Telegram-бота | `done` | Official runner, finite AI backlog и bounded lifecycle; повторный review закрыт | `npm test`: 84/84; Prisma valid |
| 02 Расписание и доставка | `done` | Все acceptance criteria реализованы; live PostgreSQL validation отмечена отдельно | `npm test`: 77/77; Prisma valid |
| 03 Report lifecycle/output | `done` | Все acceptance criteria реализованы; live PostgreSQL validation отмечена отдельно | `npm test`: 124/124; Prisma valid |
| 04 Privacy/observability/integrity | `done` | Sanitized correlated errors, atomic quota windows и 30-day retention реализованы | `npm test`: 142/142; Prisma valid |
| 05 Prompts/TTS contract | `done` | Atomic N=5 anti-repeat, deterministic fallback, onboarding split и TTS boundary реализованы | `npm test`: 150/150; Prisma valid |
| 06 Регрессионное покрытие | `done` | Полный in-memory journey, offline CI gate и isolated real PostgreSQL invariants реализованы | `test:ci`: 154/154; PG: 7/7 |
| 07 Документация/config | `done` | README, runtime/env и DB/migration contracts сверены с реализацией | `test:ci`: 154/154; PG: 7/7; Compose valid |
| 08 Backend operations | `done` | Health/readiness, minimal images, immutable production Compose, recovery и operations gates реализованы | `test:ci`: 163/163; operations gate green |

## Текущий фокус

Все задачи `01`–`08` завершены. Текущий backlog не содержит активного пункта;
оставшиеся staging/security hardening notes перечислены ниже как отдельные
операционные продолжения, а не незакрытые acceptance criteria.

## Принятые рабочие решения

- Порядок: `01`, `02`, `03`, `04`, `05`, финализация `06/07`, затем `08`.
- Task `06` не является отдельной поздней фазой: тесты добавляются рядом с
  каждым изменением задач `01`–`05`.
- Первоначальная локальная Telegram queue task 01 заменена официальными
  примитивами `@grammyjs/runner`; initial source pace задаётся явно из-за
  особенностей runner 2.0.3, а принятые middleware дренируются отдельно.
  Durable queue остаётся вне MVP: потеря in-process работы при аварийном
  завершении принята и задокументирована.
- AI admission имеет отдельные finite active/pending границы. `Effect` сейчас
  не вводится; timezone calculations переведены на Temporal polyfill.
- Новые библиотеки не добавляются без отдельного обоснования и одобрения.
- Изменения `admin` не входят в scope.
- Существующие незакоммиченные пользовательские изменения сохраняются.

## Журнал проверок

- 2026-08-06 — исходный `npm test`: успешно, 17 тестов из 17.
- 2026-08-06 — task 01 primitives: `npm run build` и 15 точечных тестов
  успешно.
- 2026-08-06 — task 01 production wiring после review-поправок:
  `npm test` успешно, 32 теста из 32.
- 2026-08-06 — task 01 final gate: `npm test` успешно, 47 тестов из 47;
  `npx prisma validate` и `git diff --check` успешно. Task 01 завершена.
- 2026-08-06 — task 02 timezone core: canonical/fallback resolver, DST-safe
  wall-clock slots и calendar-day range; `npm run build`, 18 точечных тестов,
  полный `npm test` (59/59) и `git diff --check` успешно.
- 2026-08-06 — task 02 persistence: добавлены delivery lifecycle enums/fields,
  UTC-safe `timestamptz(3)` migration, legacy backfill, partial unique scheduled
  key и DB-инварианты; `npx prisma validate`, generate/build и diff-check
  успешно. Live PostgreSQL migration пока не запускалась: локальный сервер
  недоступен.
- 2026-08-06 — task 02 final gate после reviewer fix: startup normalization
  покрывает enabled/disabled legacy rows, delivery использует atomic claims и
  явные Telegram outcomes; `npm test` успешно, 77 тестов из 77;
  `npx prisma validate` и `git diff --check` успешно. Task 02 завершена.
- 2026-08-07 — task 03 discovery: доказаны 7 незакрытых acceptance criteria,
  проверены официальные Telegram limit/error contracts, зафиксированы report
  state machine, persisted resend и plain-text chunking решения. Отклонённый
  migration write не обходился; частичная schema-only правка удалена,
  `npx prisma validate` успешно.
- 2026-08-07 — выполнен read-only аудит задач 04–08 и их зависимостей.
  Подтверждён порядок `03` → `04` → `05`, непрерывное пополнение `06`, затем
  финализация `07` и `08`. Для 04–08 зафиксированы частично закрытые foundations,
  незакрытые acceptance criteria и PostgreSQL/operations gaps; production-код
  и миграции не изменялись.
- 2026-08-07 — повторная архитектурная валидация task 01: `npm test` успешно,
  77/77; Prisma schema valid; `git diff --check` успешно. Найдены unbounded
  admission в обеих in-memory queues и shutdown timeout, не охватывающий весь
  polling lifecycle. Task 01 возвращена в `in-progress`; production-код не
  изменялся. Официальный grammY runner выбран основным кандидатом для
  Telegram runtime. Effect сейчас не выбран: для текущего Nest runtime его
  интеграционная цена выше локальной пользы, а ветка Effect 4 остаётся beta.
- 2026-08-07 — hardening task 01 завершён: добавлены точные зависимости
  `@grammyjs/runner@2.0.3` и `@js-temporal/polyfill@0.5.1`; удалена локальная
  Telegram queue; initial batch runner ограничен с первой выборки; принятые
  middleware и callback ACK участвуют в bounded drain; AI pending backlog
  конечен и abort-aware. `npm test` успешно, 82/82; целевые реальные runner
  tests стабильны в трёх повторах; общий Telegram API boundary закрывается по
  абсолютному shutdown deadline; Prisma schema valid; `git diff --check`
  успешно.
- 2026-08-07 — read-only `npm audit --omit=dev` показал 13 существующих
  production advisories (1 low, 3 moderate, 9 high). Lock-tree не связывает их
  с двумя добавленными dependencies; автоматическое обновление зависимостей не
  выполнялось и требует отдельной security/dependency задачи.
- 2026-08-08 — task 03 завершена: добавлены conversation closure и update
  dedupe, fenced generation/delivery claims, persisted resend requests,
  versioned model/fallback/legacy payload, plain-text semantic chunking и
  honest fallback UI. `npm test` успешно, 124/124; `npx prisma validate`,
  `npx prisma generate` и `git diff --check` успешно; финальный review без
  blocking findings. Live PostgreSQL migration/concurrency validation не
  запускалась из-за отсутствия PostgreSQL/Docker в окружении.
- 2026-08-08 — task 04 завершена: добавлены allowlist-only structured errors,
  correlation context для Telegram/scheduler/provider flows, atomic user upsert
  и rolling/calendar admissions, immutable quota windows с timezone snapshot,
  query/cleanup индексы и конфигурируемая 30-дневная retention-политика.
  Review-поправки защитили активное 25-часовое DST-окно от cleanup, разделили
  delivery correlation contexts и исправили provider attribution. `npm test`
  успешно, 142/142; `npx prisma validate`, generate/build и `git diff --check`
  успешно. Live PostgreSQL migration/backfill/locking/SSI/upsert concurrency не
  проверялись из-за отсутствия PostgreSQL/Docker.
- 2026-08-08 — task 05 завершена: выбор manual/scheduled prompt объединён в
  транзакционный N=5 anti-repeat с pending reservations и одним batched history
  query; добавлены детерминированный small-catalog fallback, отдельный
  new-question flow без onboarding и документация metadata/TTS boundary.
  `npm test` успешно, 150/150; `npx prisma validate`, generate/build и
  `git diff --check` успешно. Live PostgreSQL locks/migration/query plan остаются
  частью integration/operations gate.
- 2026-08-08 — task 06 завершена: добавлен полный real-class in-memory journey,
  `test:ci` и изолированный ephemeral PostgreSQL 16 gate с fresh migrations,
  session timezone, quota, prompt/report locks/fencing и `SKIP LOCKED`.
  Реальный concurrency run обнаружил P2002 race у Prisma upsert; добавлен
  winner fallback и unit/PG regressions. `test:ci` успешно, 154/154;
  `test:postgres` успешно, 7/7; финальный review без blockers.
- 2026-08-08 — ранняя версия PostgreSQL test была подобрана default discovery
  по суффиксу `.test.js` и записала test fixtures в dev DB. Файл переименован в
  explicit-only `.integration.js`; адресно удалены 14 test users, 8 test
  prompts и 4 relations, повторная read-only проверка показала 0 остатков.
- 2026-08-08 — task 07 завершена: README разделяет Compose и host PostgreSQL
  setup, `docs/app.md` фиксирует фактические conversation/delivery/time/quota/
  retention contracts, `.env.example` содержит 31 уникальный ключ с code
  defaults/ranges, а `docs/database.md` описывает 9 bot/backend моделей и
  SQL-only constraints/triggers/backfills. Reviewer findings по welcome,
  anti-repeat window, persisted voice id, ambiguous delivery и retention rows
  исправлены. `test:ci` успешно, 154/154; fresh PostgreSQL 16 gate успешно,
  7/7 и все 13 миграций; `docker compose config --quiet`, env/link inventory,
  Prisma validation и `git diff --check` успешно. `DEPLOYMENT_PLAN.md` не
  изменялся. Остаток: Prisma считает `Prompt.tags` required, исторический SQL
  не добавил `NOT NULL`; это явно отражено в database contract.
- 2026-08-08 — task 08 завершена: добавлены раздельные liveness/readiness с
  актуальным Telegram lifecycle, multi-stage non-root runtime/init images на
  зафиксированном Node 24.18.0, immutable production Compose без host ports,
  log rotation и backend operations runbook. Recovery gate применяет все 13
  миграций, проверяет 7 реальных PostgreSQL invariants, custom-format
  backup/restore и legacy backfill при разных DB session timezones; container
  gate проверяет отсутствие build tools, рабочие Prisma/bcrypt/init CLI и
  одинаковый scheduling result при `TZ=UTC`/`Asia/Tokyo`. Review исправил
  readiness race, fail-open backup/restore примеры, rollback init-image risk и
  monitoring SQL. `test:ci` успешно, 163/163; `test:operations`, обе Compose
  config-проверки, env/link inventory и `git diff --check` успешно;
  временных Docker-ресурсов не осталось. `DEPLOYMENT_PLAN.md` не изменялся.

## Следующая точка продолжения

Backlog закрыт. Перед production rollout выполнить внешний staging smoke
выделенным Telegram bot/test user, проверить опубликованный init image на
throwaway DB и по возможности заменить blanket `env_file` явным allowlist.
Production dependency advisories разобрать отдельной security/dependency
задачей без автоматического `audit fix`.
