# Регрессионное покрытие основного bot-flow

- Priority: `P0`
- Status: `done`
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

## Реализовано 2026-08-08

- Default suite дополнен единым deterministic user journey через реальные
  `UserService`, `PromptService`, `ScheduleService`, dispatcher, Telegram
  handlers, `ConversationService` и `ResponseService`. Внешние Telegram,
  Whisper, LLM и quota boundaries заменены только локальными fakes.
- Journey проходит регистрацию, `/start`, первый prompt, три voice turns, два
  follow-up, автоматическую генерацию и доставку отчёта, затем новый вопрос без
  повторного welcome и без повтора recent prompt.
- Добавлен отдельный `npm run test:postgres`. Runner игнорирует ambient
  `DATABASE_URL`, поднимает уникальный PostgreSQL 16 container без volume на
  случайном loopback port, применяет все миграции и всегда удаляет только свой
  container. Docker calls, child processes и signal shutdown имеют deadline.
- Реальная PostgreSQL lane проверяет fresh migrations, session `TimeZone`,
  concurrent user creation, quota reset/concurrency, prompt row locks,
  generation/delivery fencing, unique occurrence и `SKIP LOCKED` progress.
  Найденная реальным прогоном гонка Prisma upsert закрыта P2002 winner fallback.
- `npm run test:ci` объединяет build, offline tests и Prisma validation.

## Матрица покрытия 01–05

| Область | Автоматическая проверка | Внешний smoke |
|---|---|---|
| 01 Telegram runtime/AI bounds | runner, FIFO/concurrency, shutdown, limiter, HTTP bounds и voice failures | SIGTERM работающего staging bot |
| 02 Schedule/delivery/timezone | slot/DST/process-TZ matrix, recovery/failures и real PostgreSQL occurrence/locks/session TZ | одна due delivery в staging timezone |
| 03 Conversation/report | duplicate/closure/fencing/chunks/resend, полный journey и real PostgreSQL ownership | реальная Telegram chunk delivery |
| 04 Privacy/quota/retention | sanitizer/correlation/full mocked voice, quota/DST/cleanup и real PostgreSQL concurrency | проверка sanitized staging logs |
| 05 Prompt/TTS boundary | 0/1/N anti-repeat, independent histories, journey и real PostgreSQL locks | text и pre-uploaded voice prompt |

Все автоматические tests используют fake Telegram/Cloud.ru boundaries и не
делают внешних provider calls. Внешний smoke выполняется только в изолированном
staging с тестовым Telegram bot: `/start` → три voice answers → report → новый
вопрос; отдельно проверяются text/pre-uploaded voice и graceful SIGTERM.
Legacy backfill проверяется на одноразовой копии production-like schema/data:
сделать backup, применить `prisma migrate deploy`, сверить lifecycle/quota/report
backfill и отсутствие самопроизвольной Telegram delivery, затем удалить копию.

## Проверено 2026-08-08

- `npm run test:ci`: 154/154 успешно; Prisma schema valid.
- `npm run test:postgres`: 7/7 успешно, все 13 migrations применены к fresh DB.
- Journey отдельно и в трёх повторах: успешно.
- `git diff --check`: успешно; test containers после gate отсутствуют.
- Финальный review: blocking findings отсутствуют.
