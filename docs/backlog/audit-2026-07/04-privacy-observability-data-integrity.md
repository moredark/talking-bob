# Приватность, наблюдаемость и целостность данных

- Priority: `P1`
- Status: `done`
- Scope: logging, errors, user creation, rate limiting
- Admin: out of scope
- Depends on: `01`, `02`, `03`
- Blocks: `08`

## Проблема

Transcript попадает в обычные application logs, а структурированный `ErrorLogService` не используется в bot/AI/scheduler flows. Создание пользователя и часть rate-limit путей состоят из раздельных read/write операций и допускают race conditions. Атомарное расходование 20 `dialog_start` за локальный календарный день уже подготовлено, но не зафиксированы семантика смены timezone, состав учитываемых диалогов и lifecycle таблицы `user_requests`.

## Связанные файлы

- `src/modules/telegram/handlers/voice.handler.ts`
- `src/modules/ai/services/whisper.service.ts`
- `src/modules/ai/services/llm.service.ts`
- `src/modules/error-log/error-log.service.ts`
- `src/modules/user/user.service.ts`
- `src/modules/rate-limit/rate-limit.service.ts`
- `prisma/schema.prisma`

## План реализации

1. Удалить transcript и provider response body из обычных логов.
2. Ввести единый sanitized error context: service, operation, user ID, request/update ID, latency, status code, retryability.
3. Подключить `ErrorLogService` к Telegram, Whisper, LLM и scheduler failure paths.
4. Не записывать токены, voice file URL, transcript и полный prompt в error metadata.
5. Сделать user find-or-create атомарным через `upsert` или обработку unique conflict.
6. Сохранить уже реализованное serializable `count + insert` расходование `dialog_start`; после задачи `02` подключить общий effective-timezone resolver. Остальные используемые пути `check + record` сделать атомарными.
7. Зафиксировать семантику лимита 20 диалогов: слот расходует только успешно начатый пользователем `/start`-диалог; scheduled delivery и её `pending/failed` состояния лимит не расходуют, а ошибка до сохранения диалога освобождает слот.
8. Добавить persisted identity quota window, snapshot timezone и неизменяемые `start/end`, устанавливаемые при первом успешном расходовании окна; requests связываются с этим окном. Смена timezone не переучитывает прошлые запросы и применяется только при создании следующего окна.
9. Определить cleanup/retention для `user_requests`, error logs, transcripts и analysis.
10. Проверить индексы под фактические запросы, включая latest prompt и cleanup.
11. Добавить correlation ID для одного Telegram update/voice-flow.

## Acceptance criteria

- В success/error logs отсутствует содержимое речи и секреты.
- Ошибки внешних сервисов находятся по correlation ID и имеют понятную классификацию.
- Параллельные `/start` создают одного пользователя без пользовательской ошибки.
- Параллельные действия не превышают лимит.
- Лимит 20 учитывает только успешно начатые пользователем `/start`-диалоги и сбрасывается по зафиксированной локальной границе quota window.
- Смена timezone внутри активного quota window не создаёт второй лимит и не переучитывает ранее записанные действия.
- Старые rate-limit записи удаляются по документированной политике.
- Отказ ErrorLog storage не скрывает исходную ошибку и не вызывает рекурсию.

## Проверки

- Тест sanitizer на токенах, transcript и provider body.
- Тест concurrent user upsert.
- Тест concurrent rate-limit consumption на границе лимита.
- Тесты local midnight, 23- и 25-часового quota window, смены timezone и конкурентного расходования в момент reset.
- Тест, что scheduled `pending/sent/failed` не расходует `dialog_start`, а ошибка до сохранения ручного диалога освобождает слот.
- Тест cleanup с фиксированным временем.
- Проверка логов полного voice-flow с mock providers.
- `npm test`

## Риски и решения

- Rate limit через count+insert плохо масштабируется; выбрать atomic counter/window либо транзакционный DB-подход.
- Текущие calendar-day helper и DST-тесты не переписывать без причины; общий resolver относится к задаче `02`, а эта задача добавляет persisted identity и snapshot активного quota window.
- Privacy retention — продуктовое и юридическое решение; срок нельзя выбирать случайно в коде.
- Error metadata должна быть небольшой и версионируемой.

## Реализовано 2026-08-08

- Ошибки Telegram, Whisper, LLM, scheduler и retention записываются через
  allowlist-only контекст версии 1. Сырые `message`, `stack`, произвольная
  metadata, transcript, prompt, provider body, токены, voice file ID/URL в
  structured log не попадают. Отказ error-log storage даёт только фиксированное
  безопасное сообщение и не заменяет исходную ошибку.
- Один Telegram update проходит через `AsyncLocalStorage` correlation context;
  каждая scheduled/manual delivery получает изолированный дочерний context.
  `correlationId`, operation, status, retryability и latency вынесены в
  индексируемые поля `error_logs` и доступны через существующий admin endpoint.
- User find-or-create переведён на атомарный Prisma upsert. Rolling limits и
  calendar-day limit расходуются одной Serializable-транзакцией с полным retry.
- Добавлены immutable `quota_windows` с snapshot effective timezone и точными
  UTC start/end. Legacy `dialog_start` backfill связан с окнами; timezone меняет
  только следующее окно. Неуспех до сохранения manual dialog удаляет request и
  пустое окно, scheduled delivery лимит не расходует.
- Политика MVP: 30 дней по умолчанию, настраиваемые отдельно для sanitized
  error logs, rate-limit audit и содержимого закрытых разговоров. Daily cleanup
  удаляет delivery chunks/messages, очищает voice ID/transcript/analysis и
  сохраняет lifecycle/provenance. Активные quota windows, включая 25-часовые
  DST-дни, от очистки защищены. После purge `/report` сообщает об истечении
  срока хранения явно.

## Проверено 2026-08-08

- `npm test`: 142/142 успешно.
- `npx prisma validate`, `npx prisma generate`, `git diff --check`: успешно.
- Покрыты sanitizer, storage failure, provider и полный voice-flow без утечек,
  correlation isolation, atomic admission, 23/25-часовые окна, timezone change,
  reset/release, fixed-time cleanup и retention cron failure.
- Live PostgreSQL migration/backfill, реальные row locks, SSI contention и
  concurrent upsert в этом окружении не запускались: PostgreSQL/Docker
  недоступны. Unit-тесты конкурентности используют детерминированный fake и не
  заменяют этот integration gate.
