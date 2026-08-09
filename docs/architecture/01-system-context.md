# Контекст системы

Talking Bob — один backend-процесс NestJS для практики разговорного английского в Telegram. Пользователь общается с ботом через Telegram Bot API; backend хранит состояние в PostgreSQL и обращается к Cloud.ru для распознавания речи и генерации ответов. Администратор работает с отдельным React-приложением, которое вызывает HTTP API backend.

```mermaid
flowchart LR
    user[Пользователь Telegram] <--> tg[Telegram Bot API]
    tg <--> app["Talking Bob backend<br/>NestJS + grammY"]
    app <--> db[(PostgreSQL)]
    app --> cloud["Cloud.ru<br/>Whisper + LLM"]
    operator[Администратор] --> ui["Admin SPA<br/>React + Vite"]
    ui -->|/api: auth, admin| app
```

## Границы и ответственность

- Telegram отвечает за доставку команд, голосовых сообщений и ответов бота. Backend запускает grammY polling; одновременно должен работать только один полный экземпляр приложения.
- Backend владеет прикладными сценариями, расписанием, ограничениями запросов, состоянием диалога и административным API.
- PostgreSQL — долговременное хранилище состояния. Модели и инварианты описаны в [контракте базы данных](../database.md).
- Cloud.ru — внешний AI-провайдер: отдельные вызовы используются для транскрибации и LLM-ответов. В текущем runtime нет TTS-сервиса.
- `admin/` — самостоятельный frontend-пакет. Его production-хостинг не является частью текущего backend Compose.

## Текущий процесс и Compose

В обычном запуске один процесс Node.js поднимает Nest HTTP API, Telegram polling и фоновые задачи. Его состав и пользовательское поведение описаны в [контракте приложения](../app.md).

Текущий Compose разворачивает только backend-контур:

```mermaid
flowchart LR
    db[db: PostgreSQL] -->|service_healthy| init[init: migrations + seed]
    init -->|completed successfully| app[app: NestJS runtime]
    app --> ready["/health/ready"]
```

`init` — одноразовый этап; `app` стартует только после его успешного завершения. Локальный Compose публикует backend и PostgreSQL только на loopback, production-вариант не публикует их порты. Команды запуска, проверки и восстановления остаются в [операционном руководстве](../operations.md).

Reverse proxy, TLS, размещение Admin SPA и прочая целевая инфраструктура не входят в эту схему текущего состояния; они перечислены в [плане deployment](../DEPLOYMENT_PLAN.md).
