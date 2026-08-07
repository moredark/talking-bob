# Статус выполнения backlog

Обновлено: 2026-08-07

Этот файл — точка продолжения долгой работы. Перед началом и после завершения
каждой задачи обновляются таблица, текущий фокус и журнал проверок. Подробные
acceptance criteria остаются в task-файлах.

## Сводка

| Задача | Статус | Прогресс | Последняя проверка |
|---|---|---|---|
| 01 Runtime Telegram-бота | `done` | Official runner, finite AI backlog и bounded lifecycle; повторный review закрыт | `npm test`: 84/84; Prisma valid |
| 02 Расписание и доставка | `done` | Все acceptance criteria реализованы; live PostgreSQL validation отмечена отдельно | `npm test`: 77/77; Prisma valid |
| 03 Report lifecycle/output | `in-progress` | Discovery/plan готовы; production implementation — следующая точка продолжения | Prisma valid |
| 04 Privacy/observability/integrity | `todo` | Read-only аудит: foundations частично есть, основные AC не закрыты | 2026-08-07 audit |
| 05 Prompts/TTS contract | `todo` | TTS boundary частично закрыта; anti-repeat/onboarding не реализованы | 2026-08-07 audit |
| 06 Регрессионное покрытие | `in-progress` | Сильное покрытие 01/02; отсутствуют journey/report/04/05/PG integration | 2026-08-07 audit |
| 07 Документация/config | `todo` | README/env частично актуальны; app/database/time contract устарели | 2026-08-07 audit |
| 08 Backend operations | `todo` | Почти все AC не закрыты; есть только часть locking/network foundations | 2026-08-07 audit |

## Текущий фокус

Task `01` завершена после повторного архитектурного аудита и hardening.
Следующая точка — production implementation task `03`; работа остановлена после
текущего пункта по просьбе пользователя.

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

## Следующая точка продолжения

Вернуться к task `03` и реализовать согласованные report state machine,
persisted resend и plain-text chunking schema/migration. Перед финализацией
backlog отдельно разобрать production dependency advisories без `audit fix`.
