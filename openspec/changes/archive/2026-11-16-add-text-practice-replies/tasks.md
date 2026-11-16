## 1. Данные и совместимость активности

- [x] 1.1 Добавить nullable `User.lastVoiceMessageAt` и новую additive migration с backfill из `lastUserMessageAt`; проверить `npx prisma validate`, `npx prisma generate` и PostgreSQL-сценарием сохранение null/исторического времени, включая очищенные разговоры. Старые миграции не менять.
- [x] 1.2 Обобщить типы и методы приёма user-реплики в `ConversationService`, разрешить отсутствие voice id и обновлять общую/голосовую активность в той же транзакции по design; проверить mixed acceptance, duplicate, rollback, snapshot fencing и монотонность timestamps в lifecycle tests и `integration/postgres-critical-invariants.integration.js`.
- [x] 1.3 Дополнить существующий reset progress очисткой обоих activity timestamps; проверить административным reset-тестом атомарное очищение истории и признаков активности.

## 2. Общий сценарий ответа и текстовый вход

- [x] 2.1 Вынести preflight и post-transcription orchestration из `VoiceHandler` в общий workflow внутри `TelegramModule`, сохранив voice bounds, typing cleanup, personality, AI tokens, retry/error behavior и TTS seam; проверить `test/voice-handler-runtime.test.js` и `test/report-workflow-seam.test.js` после сборки до подключения текстового входа.
- [x] 2.2 Добавить `TextHandler` и зарегистрировать его после команд и `handleTimeText`; проверить настоящей middleware chain в `test/telegram-runtime-concurrency.test.js` и `test/telegram-schedule-controls.test.js` приоритет времени, ошибки/expiry/cancel, slash-команды, voice во время time input, возвращение handler promise и same-chat FIFO.
- [x] 2.3 Реализовать trim, предел 4096 UTF-16 units, отказы для пустого/слишком длинного текста, неизвестного пользователя, отсутствия sent prompt и закрытого разговора; новым `test/text-handler-runtime.test.js` проверить границы 4096/4097, emoji/переносы/разметку, отсутствие Whisper/download и исключение caption/edited updates.
- [x] 2.4 Подключить обе формы к прежнему action `voice_response` с прежними runtime settings и обновить welcome, limit и report no_messages подсказки; handler-тестами проверить общий исчерпанный allowance, отсутствие списания при раннем отказе/принятом duplicate и отсутствие второго follow-up.

## 3. Отчёт, стрик и ошибки

- [x] 3.1 Подключить текстовый и смешанный turn к общей readiness, guarded follow-up и автоматическому generation claim; расширить ближайшие handler/readiness/streak tests сценариями достаточного третьего ответа и недостаточного содержания, подтвердив один owner и одну квалификацию дня.
- [x] 3.2 Обеспечить `/report` и callback после текстового ответа, общий ordered transcript и согласованный выбор первого voice id либо null для обеих веток generation; проверить `test/report-handler-lifecycle.test.js`, `test/report-lifecycle.test.js` и `test/streak-lifecycle.test.js`, включая гонку manual report с приёмом turn и повтор готового отчёта без LLM.
- [x] 3.3 Обеспечить сохранение ответа при exhausted readiness, `/report` recovery после ошибок анализа, отсутствие повторной вставки и очистку typing; проверить fault-injection handler tests и `test/error-observability-retention.test.js`, включая sanitization операции `text.process`, отсутствие сырого текста в error logs, retention и запрос очищенного отчёта.

## 4. Рассылки и сценарии пользователя

- [x] 4.1 Перевести `noVoiceForDays` в snapshot и pre-send eligibility на `lastVoiceMessageAt`, сохранив общие activity-фильтры и публичные поля; проверить `test/broadcast-options.test.js`, `test/broadcast-recheck.test.js` и `integration/practice-schedule.integration.js`: text-only activity, cutoff, voice exclusion, text перед отложенной отправкой, неизменность snapshot и сохранённые кампании.
- [x] 4.2 Дополнить `test/user-journey.test.js` текстовым и смешанным journeys: первый ответ, follow-up, автоматический отчёт, ручной отчёт после одной достаточной реплики, стрик и следующий вопрос; проверить `npm run test:smoke` с детерминированными AI/Telegram adapters.

## 5. Документация, gates и review

- [x] 5.1 Обновить затронутые команды/квоты/допуск отчёта/квалификацию текстом в `docs/app.md`, схему и broadcast activity в `docs/database.md`, Telegram/data architecture и карту источников истины; сверить ссылки на `text-practice-replies`, удалить только перенесённые нормативные дубли и проверить `git diff --check`.
- [x] 5.2 Дополнить deployment guidance процедурой остановки/drain, миграции/backfill до включения текста и отката с сохранёнными voice predicates; review документа должен подтвердить отсутствие окна потери голосовой активности и отсутствие удаления пользовательских данных при rollback. Реальный deploy не выполнять в рамках реализации.
- [x] 5.3 Выполнить `npm run test:ci`, `npm run test:smoke`, `npm run test:postgres`, `openspec validate add-text-practice-replies --strict --no-interactive` и `git diff --check`; записать фактические команды, результаты и ограничения окружения. Пропущенные gates оставить явно незавершёнными.
- [x] 5.4 Провести review diff по сценариям обеих delta specs: команды/время, mixed turns, квота, гонки/fencing, восстановление, nullable voice id, retention, backfill/reset и voice-only фильтр; зафиксировать выводы и устранить замечания до отметки задачи выполненной.

Результаты выполнения, gates и review: [verification.md](verification.md).

## 6. Метрики использования форматов

- [x] 6.1 Добавить additive migration для per-format counters и coverage marker, увеличивать counters в atomic acceptance upsert; проверить Prisma validate/generate, mixed/duplicate/rollback/reset/retention и SQL CHECK через PostgreSQL.
- [x] 6.2 Добавить совместимый `replyUsage` в analytics API: уникальные за период, пересечение, доля, количества, дневные нули и отдельное coverage; проверить backend unit и PostgreSQL для нескольких дней, Moscow boundaries и отсутствия чтения содержимого.
- [x] 6.3 Показать summary, coverage и динамику форматов в существующем dashboard с текущим периодом; проверить `npm run test:admin`, пустые значения и доступную таблицу, сохранив прежние KPI.
- [x] 6.4 Синхронизировать реализованный контракт, обновить data/analytics/deployment docs и verification, провести review и выполнить `test:ci`, `test:smoke`, `test:postgres`, `test:admin`, strict OpenSpec validate и diff check; записать фактические результаты.
