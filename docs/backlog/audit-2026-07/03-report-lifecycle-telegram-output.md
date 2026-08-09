# Жизненный цикл отчёта и безопасный Telegram output

- Priority: `P0`
- Status: `done`
- Scope: conversation, report generation, Telegram formatting
- Admin: out of scope
- Depends on: `01`
- Blocks: `04`, `05`, `07`

## Проблема

После трёх user messages любое следующее voice-сообщение снова запускает report generation, хотя `UserResponse.userPromptId` уникален. Report сохраняется до Telegram reply. Transcript и LLM output вставляются в HTML без escaping и разбиения по лимиту сообщения, поэтому ошибка доставки может навсегда заблокировать повтор.

## Связанные файлы

- `prisma/schema.prisma`
- `src/modules/telegram/handlers/voice.handler.ts`
- `src/modules/telegram/handlers/report.handler.ts`
- `src/modules/conversation/conversation.service.ts`
- `src/modules/response/response.service.ts`
- `src/modules/ai/services/llm.service.ts`

## План реализации

1. Подтвердить инвариант: один итоговый report на один `UserPrompt`.
2. Описать состояния разговора: `open`, `generating`, `generated`, `delivered`, `failed/closed`.
3. Сделать начало генерации атомарным и идемпотентным.
4. После закрытия разговора не принимать новые voice-сообщения в старый `UserPrompt`; предложить новый вопрос.
5. При повторном `/report` переотправлять сохранённый результат, а не повторно вызывать LLM.
6. Отличать реальный LLM feedback от fallback и разрешать осмысленный retry, если UI его обещает.
7. Экранировать весь user/model content для Telegram HTML либо использовать entities/plain text.
8. Разбивать длинный отчёт по Telegram limit, не ломая HTML entities и смысловые блоки.
9. Не терять generated result при ошибке Telegram; хранить delivery state и последнюю sanitized error.

## Acceptance criteria

- Четвёртое voice-сообщение не вызывает второй LLM report для того же `UserPrompt`.
- Двойной callback и повторно доставленный Telegram update не создают дубликаты.
- Повторный `/report` безопасно доставляет уже созданный отчёт.
- Строки с `<`, `>`, `&`, кавычками и emoji доставляются корректно.
- Отчёт длиннее лимита доставляется несколькими сообщениями.
- Ошибка Telegram после генерации не делает отчёт недоступным.
- Fallback не маскируется под полноценный анализ и не обещает невозможный retry.

## Проверки

- Тесты третьего и четвёртого voice-сообщения.
- Тест параллельных manual/auto report requests.
- Тест повторной доставки одного update.
- Тест HTML escaping и chunking на границе лимита.
- Тест `generated → delivery failed → resend success`.
- `npm test`

## Риски и решения

- Если нужны несколько отчётов на разговор, потребуется отдельная модель report attempt; это не следует смешивать с минимальным исправлением.
- Сохранение report до send полезно для retry, но требует отдельного delivery state.
- Формат JSON в `analysis` должен получить версию либо стабильный typed contract.

## Принятые решения реализации

- `UserResponse` остаётся агрегатом единственного итогового report для
  `UserPrompt`. Закрытие разговора хранится на `UserPrompt`, поэтому legacy
  разговор с тремя voice messages можно закрыть даже при отсутствии report
  row; manual `/report` всё ещё может создать для него отчёт.
- Generation и delivery имеют раздельные persisted states и claim tokens.
  Короткие transactions блокируют `UserPrompt`/`UserResponse`; LLM и Telegram
  I/O всегда выполняются после commit.
- Третье user voice message и auto-generation claim создаются атомарно в одной
  transaction. `ConversationMessage.telegramUpdateId` защищает повторно
  доставленный voice update; nullable unique key не ограничивает legacy и
  assistant messages.
- Ручной и автоматический запрос используют один `ResponseService` lifecycle.
  Активный generation lease не дублирует LLM call; `failed` или просроченный
  generation можно осмысленно reclaim. Уже generated report никогда не
  генерируется повторно, а только доставляется из сохранённого payload.
- `ILLMService.analyzeSpeech` возвращает feedback вместе с provenance
  `model/fallback`. Persisted JSON сохраняет совместимые top-level поля
  feedback и добавляет version/kind metadata. Fallback является честно
  помеченным базовым отчётом и не обещает повторный анализ.
- Telegram output отправляется как plain text без `parse_mode`. Это исключает
  HTML injection для `<`, `>`, `&`, кавычек и model/user content. Semantic
  chunker ограничивает каждый message максимум 4096 UTF-16 code units, не
  разрывает surrogate pair и по возможности сохраняет абзацы/строки.
- Delivery request key строится из callback source message id, command/voice
  message id или fallback update id. Повтор одного update/double-click того же
  callback не создаёт вторую delivery; новый `/report` получает новый key и
  осознанно переотправляет сохранённый report.
- Каждый resend представлен отдельным `ReportDeliveryRequest` с уникальным
  request key, сохранённым массивом chunks, cursor, lease, timestamps и
  sanitized error code. Это не перезаписывает историю предыдущей доставки и
  делает double-click идемпотентным. `GrammyError` означает однозначный отказ;
  `HttpError` и неизвестная transport ошибка остаются неоднозначными и не
  повторяются автоматически. Новый `/report` создаёт новый resend request.
- Legacy complete `UserResponse` backfill становится generated с kind/version
  `legacy/0`, чтобы результат был доступен для resend; migration не фабрикует
  delivery request и не утверждает прежнюю доставку. Неполная legacy строка
  становится generation `failed` с sanitized `legacy_incomplete`. Legacy
  prompts с тремя user messages закрываются на timestamp третьего сообщения,
  без LLM/Telegram вызовов из migration.
- Кнопка `new_question` прикрепляется к последнему report chunk, чтобы delivery
  отчёта не зависела от отдельного завершающего Telegram message.

## Фактическая реализация

- `UserPrompt` хранит persisted `open/closed` conversation state, а
  `ConversationMessage.telegramUpdateId` дедуплицирует повторные updates.
- Третий voice message, закрытие разговора и generation claim выполняются в
  одной короткой transaction под `UserPrompt FOR UPDATE`. Четвёртый voice
  отклоняется до download/Whisper; delayed assistant follow-up вставляется
  только если разговор всё ещё открыт и user turn остаётся последним.
- Manual и automatic report используют единый fenced lifecycle в
  `ResponseService`: active lease не дублирует LLM, failed/expired claim можно
  reclaim только новым request key, generated result никогда не генерируется
  повторно.
- Generation completion атомарно сохраняет versioned payload и создаёт первую
  persisted delivery request. Каждый intentional resend имеет отдельный
  request key, chunks, cursor, lease и sanitized outcome.
- Telegram send выполняется после persisted attempt marker. `GrammyError`
  сохраняется как definite failure; `HttpError`, unknown transport и ошибка
  durable completion после успешного send остаются terminal ambiguous и не
  ретраятся автоматически.
- Output отправляется plain text без `parse_mode`, делится по semantic
  boundaries максимум на 4096 UTF-16 code units и не разрывает surrogate pair.
  Кнопка нового вопроса прикреплена только к последнему chunk.
- `model/fallback/legacy` provenance сохраняется и восстанавливается при resend;
  fallback явно обозначается пользователю как базовый автоматический отчёт.

## Фактические проверки

- `npm test` — успешно, 124/124.
- `npx prisma validate` и `npx prisma generate` — успешно.
- `git diff --check` — успешно.
- Добавлены tests lifecycle claims/fencing/rollback, third/fourth voice,
  duplicate update, manual/auto ownership, generation → delivery failure →
  intentional resend, plain-text special characters, 4096 boundary, surrogate
  safety, fallback provenance и post-send persistence ambiguity.
- Final reviewer: blocking findings отсутствуют.
- Live PostgreSQL migration и реальное contention между отдельными DB
  connections не запускались: PostgreSQL/Docker недоступны в окружении.
- Commit/PR: не создавались.
