# Backlog Admin MVP — август 2026

Этот backlog превращает согласованный scope Admin MVP Talking Bob в задачи, которые можно реализовывать по одной. Он охватывает защищённые admin API, Admin SPA, необходимые модели данных, тесты, документацию и rollout. Сами функции в этом каталоге не реализуются.

Текущий прогресс и точка продолжения: [STATUS.md](STATUS.md).

## Обозначения

- Приоритет: `P0` — обязательная основа или rollout gate; `P1` — основная возможность Admin MVP.
- Статус: `todo`, `in-progress`, `blocked`, `done`.
- Задача считается завершённой только после выполнения acceptance criteria и указанных проверок.

## Порядок реализации

| № | Задача | Приоритет | Зависит от |
|---|---|---:|---|
| 01 | [Admin-контракты и тестовый baseline](01-admin-contracts-and-test-baseline.md) | P0 | — |
| 02 | [Admin audit log](02-admin-audit-log.md) | P0 | 01 |
| 03 | [Просмотр сессий в admin](03-admin-session-inspection.md) | P1 | 01 |
| 04 | [Runtime-настройки в admin](04-admin-runtime-settings.md) | P1 | 02 |
| 05 | [Admin-рассылки](05-admin-announcements.md) | P1 | 02 |
| 06 | [Admin-аналитика и графики](06-admin-analytics-and-charts.md) | P1 | 03, 05 |
| 07 | [Интеграция и rollout Admin MVP](07-admin-mvp-integration-and-rollout.md) | P0 | 01–06 |

Порядок schema migrations зафиксирован: `01` → `02` → `03` → `04` → `05` → `06`. Migration `20260810160000_admin_analytics_facts` добавлена после `05`, потому что 90-дневные метрики не могут зависеть от raw данных с 30-дневным retention; она также фиксирует честную границу исторического покрытия upgrade. Задача `07` закрывается последней как rollout gate.

Задачи `02` и `03` можно разрабатывать параллельно после `01`; `04` и `05` — после audit foundation из `02`. Это product dependencies. Schema changes мержатся/применяются отдельно в указанном migration order, поэтому параллельная задача не публикует свою migration раньше предыдущего номера.

## Принятые решения до реализации

1. Все новые `/admin/*` endpoints остаются под существующим `AuthGuard`; публичные bot-контракты и маршруты не меняются.
2. Административные мутации записываются в отдельный append-only audit log. В записи есть actor, действие, сущность, результат, correlation/request ID и безопасные до/после metadata без секретов и сырого пользовательского контента.
3. Admin может просматривать session content и `AiProviderCall`: только extracted raw provider response content и metadata (`follow_up|analysis`, model, attempt, outcome, status, latency, optional usage и links). Request/system prompt, headers, secrets и полный provider JSON не сохраняются; trace write best effort. AI calls удаляются через фиксированные 30 дней от `createdAt`; session content — через настраиваемый срок closed-conversation retention, по умолчанию 30 дней от close.
4. Runtime settings строго hybrid: hot product overrides (rate counts/windows, dialogs/day, LLM token caps, voice limits в hard caps, retention) применяются со следующего admission; infrastructure overrides (model, concurrency/queue, timeouts/response bounds, shutdown drain) требуют restart; port/URLs/deployment readonly; secrets показывают только `configured`. `process.env` не мутируется.
5. Рассылка реализуется моделями `Broadcast`/`BroadcastRecipient`. Broadcast lifecycle: `queued|processing|completed|completed_with_errors|cancelled`; recipient: `pending|sent|failed|ambiguous|skipped`. Snapshot создаётся атомарно, а status/ban/opt-out перепроверяются после claim непосредственно перед Telegram API I/O.
6. Broadcast поддерживает одно plain-text сообщение в Telegram limit без chunking/`parse_mode`, immediate или scheduled Moscow send, filters `languageLevels`, `activity=any|7d|30d|90d|never`, `dailyPromptEnabled`; отдельный `announcementEnabled` opt-out обязателен и не обходится admin.
7. Analytics использует точный `GET /admin/analytics?days=7|30|90`, Moscow calendar buckets, product/funnel/retention/score/topic/AI/broadcast metrics. UI строит shadcn-vue Chart + Unovis и доступную HTML table для каждого графика.
8. Новые списки используют server-side pagination, стабильный tie-breaker и валидируемые filter/sort параметры. Timestamps передаются как ISO 8601 UTC; Moscow calendar/schedule semantics явно присутствует в контракте, а не вычисляется произвольно во frontend.
9. Retention matrix MVP: AI calls — фиксированные 30 дней; session content — effective closed-conversation retention, default 30; audit rows — 365 дней; terminal broadcast content/recipient rows — 90 дней, aggregate broadcast row — 365 дней. Активные broadcasts не очищаются.

## Общий Definition of Done

- Существующие admin и bot routes, auth flow и публичные payload сохраняются, если task явно не вводит новый versioned контракт.
- Для страниц и действий обработаны loading, empty, error, success, disabled и retry states, когда они применимы.
- Все административные мутации имеют audit trail; чувствительное содержимое не попадает в audit/error/application logs.
- DTO и query params валидируются; pagination и сортировка детерминированы.
- Изменённое поведение покрыто backend и admin-тестами.
- При изменении Prisma-схемы проходят `npx prisma validate` и migration/integration gate; migration order не нарушен.
- Проходят `npm run test:ci`, `npm --prefix admin test`, `npm --prefix admin run build` и `git diff --check`.
- Актуализированы затронутые `docs/app.md`, `docs/database.md`, архитектурные документы и environment contract.

## Правила ведения backlog

- При старте задачи сменить статус на `in-progress` в task-файле и [STATUS.md](STATUS.md).
- Не расширять scope молча: новые крупные возможности оформлять отдельной задачей.
- До миграции или изменения API фиксировать итоговые решения в разделе «Риски и решения».
- После завершения заполнять пустые разделы «Реализовано» и «Проверено» фактическими изменениями и командами.
- Не включать секреты, transcript, сообщения, analysis или provider payload в backlog и журналы проверок.
