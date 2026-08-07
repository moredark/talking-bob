# Качество выбора prompts и решение по TTS

- Priority: `P2`
- Status: `todo`
- Scope: product behavior, prompts, TTS contract
- Admin: out of scope
- Depends on: `02`, `03`
- Blocks: `07`

## Проблема

Prompt выбирается случайно из полного активного списка без учёта истории пользователя, поэтому вопросы могут повторяться подряд. Поля `difficulty`, `tags` и `sortOrder` почти не влияют на bot-flow. Built-in prompts сейчас отправляются текстом; nullable `audioFileId` поддерживает заранее загруженный Telegram voice, но генерации TTS в runtime нет.

## Связанные файлы

- `src/modules/prompt/prompt.service.ts`
- `src/modules/telegram/handlers/start.handler.ts`
- `src/modules/schedule/daily-prompt.dispatcher.ts`
- `prisma/schema.prisma`
- `prisma/seed-prompts.ts`
- `README.md`

## План реализации

1. Определить минимальную anti-repeat стратегию: исключать последние `N` prompts пользователя.
2. Описать fallback, если активных prompts меньше `N`.
3. Решить, используются ли difficulty/tags для уровня пользователя сейчас или остаются metadata.
4. Разделить onboarding `/start` и действие «Новый вопрос», чтобы повторный вопрос не показывал welcome заново.
5. Сохранить text fallback и поддержку заранее загруженного Telegram voice через nullable `audioFileId`; генерацию TTS, upload/cache policy и стоимость вынести в отдельную будущую задачу.

## Acceptance criteria

- При достаточном наборе prompt не повторяется среди последних `N` вопросов пользователя.
- При малом наборе есть детерминированный безопасный fallback.
- Новый вопрос не повторяет onboarding-текст.
- Роль `difficulty`, `tags`, `sortOrder` описана и совпадает с кодом.
- Документация и `.env.example` не объявляют TTS частью текущего runtime.
- Text и pre-uploaded voice flow не требуют TTS-конфигурации.

## Проверки

- Тест anti-repeat и fallback при 0/1/N prompts.
- Тест независимой истории двух пользователей.
- Тест callback «Новый вопрос» без welcome.
- `npm test`

## Риски и решения

- Случайный `ORDER BY random()` и загрузка всех prompts имеют разные ограничения; выбрать подход под ожидаемый размер каталога.
- Будущая TTS-задача должна отдельно определить стоимость, latency, формат Telegram voice и cache policy до возврата provider-кода в runtime.
- Не менять существующий seed без теста идемпотентности.
