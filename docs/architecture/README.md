# Архитектура Talking Bob

Этот раздел — точка входа в текущую архитектуру проекта. Он объясняет, как
части системы связаны между собой, но не заменяет нормативные контракты,
Prisma-схему или operational runbook.

Документы сверены с кодом 2026-08-09.

## Как читать

Если нужно быстро получить общую картину, прочитайте документы по порядку:

1. [Контекст системы](01-system-context.md) — пользователи, внешние системы и
   границы процессов.
2. [Карта backend-модулей](02-backend-module-map.md) — NestJS-модули,
   зависимости и владельцы ответственности.
3. [Telegram, диалог и отчёт](03-telegram-conversation.md) — интерактивные
   пользовательские потоки.
4. [Фоновые процессы](04-background-jobs.md) — расписание, доставка, retention
   и восстановление после ошибок.
5. [Данные и состояния](05-data-and-state.md) — агрегаты, state machines,
   транзакции и fencing.
6. [Admin и эксплуатация](06-admin-and-operations.md) — HTTP API, отдельный
   admin UI, health и текущая container topology.

## Маршруты для конкретной задачи

| Задача | С чего начать |
| --- | --- |
| Изменить команду или callback Telegram | [Telegram flow](03-telegram-conversation.md) |
| Изменить conversation/report lifecycle | [Данные и состояния](05-data-and-state.md), затем [Telegram flow](03-telegram-conversation.md) |
| Изменить расписание или выбор prompt | [Фоновые процессы](04-background-jobs.md) |
| Добавить AI provider или лимит | [Карта модулей](02-backend-module-map.md), затем [Telegram flow](03-telegram-conversation.md) |
| Изменить Prisma schema/migration | [Данные и состояния](05-data-and-state.md), затем [database.md](../database.md) |
| Изменить admin API/UI | [Admin и эксплуатация](06-admin-and-operations.md) |
| Разобраться с deploy/backup/health | [Admin и эксплуатация](06-admin-and-operations.md), затем [operations.md](../operations.md) |
| Найти подходящий набор тестов | Раздел «Как безопасно менять систему» в тематическом документе |

## Где находится источник истины

Архитектурные страницы намеренно описывают связи и причины, а точные контракты
держатся в других местах:

| Что нужно узнать | Нормативный источник |
| --- | --- |
| Команды, лимиты, сообщения, env и пользовательское поведение | [Application contract](../app.md) |
| Поля, enum, индексы, SQL-инварианты и миграции | [Database contract](../database.md) и `prisma/schema.prisma` |
| Deploy, backup, restore, monitoring | [Operations runbook](../operations.md) |
| Будущая production-схема с proxy/admin hosting | [Deployment plan](../DEPLOYMENT_PLAN.md), помеченный как forward-looking |
| Причины большой переработки 2026-08 | [Закрытый backlog](../backlog/audit-2026-07/README.md) |

## Термины

- **Prompt** — запись каталога вопросов.
- **UserPrompt** — конкретная зарезервированная пользователю сессия вопроса;
  это центральный агрегат диалога и доставки.
- **ConversationMessage** — принятый user turn или сохранённый assistant turn.
- **UserResponse** — владелец жизненного цикла генерации сохранённого отчёта.
- **ReportDeliveryRequest** — отдельная идемпотентная попытка доставить уже
  сформированный отчёт частями.
- **Claim/lease** — временное право воркера продолжить работу.
- **Fencing** — проверка token/index/timestamp, не позволяющая устаревшему
  воркеру подтвердить результат.

## Правило поддержки документации

При изменении межмодульной зависимости, владельца состояния или основного
потока обновляйте соответствующую страницу здесь. При изменении конкретного
поля, лимита или команды обновляйте нормативный документ, а здесь оставляйте
только ссылку и архитектурный смысл.
