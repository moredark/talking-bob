# Результаты реализации и review

Проверено 2026-11-16 на Node.js **24.18.0**.

## Реализованное поведение

- `TextHandler` принимает новые текстовые ответы с trim и пределом 4096 UTF-16 units, исключая slash-команды, caption и edited updates.
- Общий `PracticeReplyWorkflowService` обслуживает голос и текст: admission, personality, readiness, приём turn, follow-up/TTS и report claim. Аудиоадаптер и Whisper остались в `VoiceHandler`.
- Общие квота, история, ручной/автоматический отчёт и стрик работают для текстовых и смешанных диалогов. Voice id отчёта — первый ненулевой в истории либо null.
- Nullable `lastVoiceMessageAt` и backfill сохраняют голосовую семантику `noVoiceForDays`; общий activity-факт учитывает текст. Сброс и retention покрыты PostgreSQL-проверками.
- При отсутствии истории после retention generation service возвращает сохранённый generated owner: `/report` сообщает об очищенном отчёте без повторного анализа или новой доставки.
- Основные спецификации синхронизированы: новая `text-practice-replies` (7 требований), два изменённых требования `schedule-reengagement`. Изменение завершено и архивировано 2026-11-16.

## Фактически выполненные проверки

| Команда | Результат |
| --- | --- |
| `npx prisma validate` | Успешно |
| `npx prisma generate` | Успешно |
| `npm run test:ci` | 502 passed, 0 failed, 0 skipped; Prisma schema valid |
| `npm run test:admin` | 32 passed, 0 failed; Vue typecheck и Vite production build успешны |
| `npm run test:smoke` | 6 passed, 0 failed, 0 skipped |
| `npm run test:postgres` | Успешно: analytics 1, admin 6, critical invariants 18, practice 5, reply usage 2; backup/restore и legacy timezone matrix passed |
| `openspec validate add-text-practice-replies --strict --no-interactive` | Успешно |
| `openspec validate --specs --strict --no-interactive` | 5 спецификаций passed, 0 failed |
| `git diff --check`, whitespace новых файлов, локальные ссылки изменённых Markdown | Успешно |

До подключения текста отдельно прошли `test/voice-handler-runtime.test.js` и
`test/report-workflow-seam.test.js` после выделения workflow. Последующие полные
прогоны включают эти регрессии и новые handler, middleware, journey и DB tests.

Первые sandbox-прогоны блокировали Docker и дочерние Node-процессы с `EPERM`;
окончательные gates выполнены с разрешённым выходом из песочницы. Также
устранена зависимость старой analytics-фикстуры от даты запуска: тест задаёт
coverage-время для своих фиксированных дат и восстанавливает его в cleanup.

## Review по сценариям

Проверены границы 4096/4097 и emoji, literal text, неизвестный пользователь,
pending/closed prompt, приоритет команд/времени с ошибкой и истечением, voice
во время настройки времени, FIFO разных форматов и drain. Проверены общая
квота, duplicate, snapshot fencing, устаревший follow-up и неизменность AI/TTS
правил. Journeys проходят текстовый и смешанный автоматический отчёт,
`/report`/callback после одного ответа, повтор готового отчёта и новый вопрос.

Реальная БД подтверждает rollback всей транзакции, монотонные timestamps,
единственного generation owner и streak day в гонке с ручным отчётом,
text-only null voice id, сохранение первого голоса, backfill исторического
времени/null и reset. Snapshot и pre-send predicates различают text activity
и voice absence, сохраняют cutoff и snapshot membership.

При review выявлен и исправлен прежний ранний `no_messages` после retention.
Регрессия проверяется через реальные application-сервисы и PostgreSQL;
mock-only handler test для этого случая дополнен проверкой полного пути.
Содержимое текста не появляется в operational error logs. Нерешённых замечаний
в согласованном scope не осталось.

## Внедрение

Реальный deploy не выполнялся. Миграция проверена в изолированных тестовых БД.
Порядок остановки/drain старых writers, backfill до включения текста и откат
с сохранением voice-specific predicates описаны в
[operations runbook](../../../../docs/operations.md#text-reply-rollout-and-rollback).

## Дополнение: использование форматов

Добавлен dashboard-раздел «Использование текста и голоса» с текущим выбором
7/30/90 дней, уникальными пользователями текста/голоса/обоих форматов,
долей пользователей текста, количеством принятых ответов и дневным графиком
с доступной таблицей. Группы пересекаются; пустая доля отображается как «—».
Дата начала сбора и неполный период показаны явно. Более ранняя неизвестная
история не входит в измеренную разбивку.

`GET /admin/analytics` version 1 расширен совместимым `replyUsage`; прежние
поля сохранены. Форматные counters обновляются в том же atomic upsert, что
и общая активность. Использованы существующие `UserActivityDay` и singleton
coverage; новые таблицы, библиотеки и внешняя телеметрия не добавлялись.

PostgreSQL-проверки подтвердили уникальность пользователей за несколько дней,
пересечение форматов в разные дни, московскую нижнюю границу суток, отсутствие
будущих дней и записей, нулевые дни/доли, полное/частичное/недоступное coverage,
SQL CHECK и сохранение неизвестного исторического формата. Дополнительно
сравнены одинаковые результаты при `Pacific/Honolulu` и `Asia/Tokyo` в сессии БД.
Mixed/duplicate/rollback/retention/reset tests дополнены проверками counters.
Backend unit-тесты подтверждают постоянное число queries и отсутствие чтения
чувствительного содержимого; admin contract tests и production build проходят.

Миграция `20261116130000_reply_usage_metrics` добавлена отдельным файлом;
предыдущие миграции не переписывались. Deployment guidance дополнен требованием
сохранить запись format counters в rollback build и запустить новую версию
после остановки старых writers. Реального deploy по-прежнему не было.
