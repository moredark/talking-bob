# Регрессионное покрытие основного bot-flow

- Priority: `P0`
- Status: `in-progress`
- Scope: unit and integration tests
- Admin: out of scope
- Depends on: реализуется вместе с `01`–`05`
- Blocks: completion of `01`–`05`

## Проблема

Текущие тесты покрывают seed и часть daily dispatcher, но не `/start`, settings, voice pipeline, report lifecycle, schedule calculation, concurrency и provider failures. Зелёный `npm test` не защищает основной пользовательский сценарий.

## Связанные файлы

- `test/daily-prompt-dispatcher.test.js`
- `test/seed-prompts.test.js`
- `test/seed.test.js`
- `package.json`
- `src/modules/telegram/handlers/*`
- `src/modules/schedule/*`
- `src/modules/ai/services/*`

## План реализации

1. Сохранить текущий `node:test` подход; не менять framework без необходимости.
2. Добавить reusable mocks для Prisma, Telegram context/API, clock и external providers.
3. Покрыть user journey:
   - регистрация;
   - первый prompt;
   - два follow-up;
   - автоматический report;
   - новый вопрос.
4. Добавить failure matrix: Telegram, Whisper, LLM, DB и timeout.
5. Добавить race/idempotency tests из задач `01`–`04`.
6. Использовать fake clock для schedule и rate limit. Timezone-матрица включает:
   - до, после и точно в целевую минуту;
   - локальную полночь, 23- и 25-часовые сутки;
   - DST gap и DST overlap;
   - canonical timezone, alias normalization и legacy-invalid fallback;
   - минимум два значения `process.env.TZ`;
   - PostgreSQL session `TimeZone` в integration tests;
   - смену времени/timezone рядом с due/claim и reset rate limit;
   - многодневный простой без replay burst;
   - отдельные schedule repair, downtime catch-up и legacy migration без случайной доставки;
   - независимость scheduled occurrence от ручных `/start`;
   - отображение effective timezone в settings.
7. Отделить быстрые unit tests от integration tests, требующих PostgreSQL.
8. Добавить минимальную CI-команду `build + tests + prisma validate`.

## Acceptance criteria

- Каждая acceptance criterion из задач `01`–`05` имеет автоматическую проверку либо явно описанный manual smoke test.
- Тесты детерминированы и не обращаются к реальным Telegram/Cloud.ru.
- Есть интеграционный сценарий основного диалога.
- Есть тесты duplicate update, concurrent report и failed delivery.
- Schedule и calendar-day rate limit детерминированы на всей timezone-матрице из плана.
- Команда тестов завершается с ненулевым кодом при любой регрессии.

## Проверки

- `npm test`
- Отдельный запуск каждого нового test-файла через `node --test`.
- Повторный запуск suite несколько раз для поиска flaky tests.
- `npx prisma validate`

## Риски и решения

- Tests against `dist` требуют build до запуска; сохранить это явно в script либо перейти на TS runner отдельной задачей.
- Слишком подробные Prisma mocks могут расходиться с реальной БД; критичные транзакции проверять integration tests.
- Покрытие строк не является Definition of Done; приоритет — сценарии и инварианты.
