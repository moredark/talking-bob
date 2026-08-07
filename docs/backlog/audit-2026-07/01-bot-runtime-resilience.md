# Устойчивый runtime Telegram-бота

- Priority: `P0`
- Status: `done`
- Scope: Telegram runtime, внешние HTTP-вызовы
- Admin: out of scope
- Depends on: none
- Blocks: `03`, `04`, `08`

## Проблема

`bot.start()` обрабатывает updates последовательно, а voice-handler ждёт скачивание файла, Whisper и LLM. Один зависший или медленный запрос задерживает сообщения всех пользователей. Внешние запросы не применяют зафиксированные timeout и size limits.

## Связанные файлы

- `src/modules/telegram/telegram.service.ts`
- `src/modules/telegram/handlers/voice.handler.ts`
- `src/modules/ai/services/whisper.service.ts`
- `src/modules/ai/services/llm.service.ts`
- `src/main.ts`
- `.env.example`

## План реализации

1. Зафиксировать модель конкурентности:
   - bounded concurrency между чатами;
   - строгий порядок сообщений внутри одного чата/пользователя;
   - ограничение числа одновременно выполняемых AI-запросов.
2. Выбрать реализацию: grammY runner с `sequentialize` либо очередь фоновых jobs.
3. Не запускать неконтролируемые `void`-задачи без lifecycle, retry и error handling.
4. Вынести HTTP-политику в общий helper:
   - `AbortController`;
   - timeout и максимальный размер ответа из `src/config/limits.config.ts`;
   - ограниченный retry только для retryable ошибок;
   - максимальный размер ответа.
5. До скачивания проверять `voice.file_size` и `voice.duration` по централизованным лимитам: максимум 20 МиБ и 300 секунд.
6. Использовать стандартный Telegram Bot API и ограничивать фактически прочитанный поток, даже если `voice.file_size` отсутствует.
7. Добавить корректную остановку polling/runner при `SIGINT` и `SIGTERM`.
8. До начала polling валидировать обязательные env, числовые диапазоны timeout/limits и формат URL без вывода секретов.

## Acceptance criteria

- Долгий voice-flow одного пользователя не блокирует команды другого пользователя.
- Сообщения одного чата обрабатываются в исходном порядке.
- Одновременно выполняется не больше настроенного числа AI-задач.
- Все внешние запросы завершаются по timeout и освобождают typing indicator.
- Слишком большие или длинные voice-сообщения отклоняются до скачивания понятным ответом.
- Voice-flow работает через стандартный Telegram Bot API без custom API root.
- Shutdown не оставляет незавершённый polling lifecycle.
- При невалидной runtime-конфигурации процесс завершается до polling с понятным sanitized сообщением.

## Проверки

- Unit-тесты concurrency limiter и per-chat ordering.
- Unit-тесты timeout, abort, отсутствующего `file_size`, слишком большого и слишком длинного voice.
- Интеграционный тест с двумя чатами: медленный AI mock в первом не задерживает `/settings` во втором.
- `npm test`

## Риски и решения

- Конкурентность проявит скрытые race conditions в report, rate limit и user creation; задачи `03` и `04` должны учитывать это.
- In-process background jobs теряются при рестарте. Если допустима потеря работы, это нужно явно зафиксировать; иначе использовать durable queue.
- Новую библиотеку добавлять только после сравнения с небольшим локальным limiter/queue.

## Фактическая реализация

- Polling и конкурентная обработка построены на официальных примитивах
  `@grammyjs/runner@2.0.3`; `sequentialize` сохраняет FIFO внутри чата.
- Для runner 2.0.3 явно задаётся initial source pace до запуска. Это устраняет
  cold-start batch до 100 updates и применяет configured concurrency с первой
  выборки. Принятые middleware отдельно отслеживаются до завершения, потому что
  `RunnerHandle.stop()` этой версии может завершиться до опустошения sink.
- Аварийное завершение процесса сохраняет документированный in-process
  at-most-once риск. Нормальный shutdown прекращает admission, останавливает
  polling и выполняет bounded drain до teardown database dependencies. После
  deadline новые Telegram API-вызовы из незавершённых contexts блокируются.
- Callback query подтверждается немедленно и независимо от последовательного
  business handler; ошибка подтверждения не отменяет бизнес-действие.
- Все AI POST ограничены общей finite FIFO admission policy: отдельно заданы
  active concurrency и максимальный pending backlog. Shutdown закрывает
  admission, дренирует принятую работу и abort-ит её по общему deadline.
- Все внешние HTTP-вызовы ограничены timeout и размером ответа без retry для
  POST. Безопасный Telegram file GET допускает не более одного retry только для
  retryable результата.
- Значения env могут уменьшать hard limits, но не увеличивать максимум
  300 секунд/20 МиБ и зафиксированные provider boundaries.
- Runtime использует только стандартный Telegram Bot API.

## Фактические проверки

- `npm test` — успешно, 84/84.
- `npx prisma validate` — schema valid.
- `git diff --check` — успешно.
- Добавлены regression tests runtime config, bounded HTTP, finite AI limiter,
  voice limits/download, providers, cross-chat concurrency, same-chat FIFO,
  callback acknowledgement, real runner 2.0.3 contracts, initial batch cap и
  фактический drain принятых middleware.
- Commit/PR: не создавались.

## Повторный архитектурный аудит 2026-08-07

- Build/unit gate остаётся зелёным: `npm test` — 77/77, Prisma schema valid,
  `git diff --check` успешно.
- Текущие `BoundedKeyedQueue` и `AiRequestLimiterService` ограничивают число
  активных задач, но не размер ожидающего backlog. При длительной перегрузке
  admission остаётся неограниченным по памяти.
- Shutdown timeout ограничивает drain очереди, но не весь polling lifecycle:
  ожидание startup/polling promise происходит до bounded drain, а оставшиеся
  после timeout задачи могут продолжить работу во время teardown зависимостей.
- Основной кандидат на замену Telegram runtime — официальный
  `@grammyjs/runner` с `sequentialize`, конечной concurrency и сохранением
  раннего callback acknowledgement. Для AI limiter нужна отдельная конечная
  admission policy; один `p-limit` проблему backlog не решает.
- Gaps закрыты 2026-08-07: локальная Telegram queue удалена в пользу
  официального runner, AI pending backlog ограничен, весь outward shutdown
  использует один deadline, а реальные особенности runner зафиксированы
  compatibility и production regression tests.
- `Effect` не добавлен: для этого NestJS-приложения он создал бы второй runtime,
  DI/error model и существенную миграцию без локальной выгоды для решаемых
  queue/lifecycle задач. Точечный timezone engine заменён на
  `@js-temporal/polyfill@0.5.1` с сохранением DST-контрактов task 02.
