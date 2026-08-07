# Backend operations и production readiness

- Priority: `P1`
- Status: `todo`
- Scope: backend container, health, deploy, recovery
- Admin: out of scope
- Depends on: `01`–`04`, `07`
- Blocks: production rollout

## Проблема

Текущий Dockerfile содержит build- и runtime-зависимости в одном root-контейнере. У приложения нет health/readiness endpoint, provider health и понятного сигнала готовности Telegram polling. Образы используют изменяемые tags, а backup/restore и rollout overlap остаются процессом на бумаге.

## Связанные файлы

- `Dockerfile`
- `docker-compose.yml`
- `src/main.ts`
- `package.json`
- `prisma/schema.prisma`
- `docs/DEPLOYMENT_PLAN.md`

## План реализации

1. Реализовать multi-stage Docker build с минимальным runtime image и непривилегированным пользователем.
2. Зафиксировать поддерживаемую Node.js version и согласовать её с typings.
3. Добавить:
   - liveness endpoint процесса;
   - readiness DB;
   - состояние Telegram polling/runner;
   - при необходимости отдельную degraded-индикацию providers.
4. Добавить container healthcheck и корректный restart behavior.
5. Зафиксировать immutable image tags/digests.
6. Не допускать одновременный scheduler processing при rollout двух версий; использовать locking из задачи `02`.
7. Описать и проверить backup перед миграцией, restore test и rollback.
8. Добавить smoke-check bot-команд и voice-flow с test user/provider mocks.
9. Настроить ротацию логов, disk alerts и наблюдение за failed deliveries.
10. Сверить реализацию с backend-разделами `docs/DEPLOYMENT_PLAN.md`, не расширяя scope на `admin`.
11. Проверить runtime, scheduler и migration/backfill из задачи `02` минимум при двух значениях Node/container `TZ` и PostgreSQL session `TimeZone`. Operational pinning к UTC разрешено, но не заменяет timezone-независимую бизнес-логику.

## Acceptance criteria

- Runtime container запускается не от root и не содержит лишние build tools/dev dependencies.
- Healthcheck различает «процесс жив» и «бот готов принимать updates».
- Приложение не считается ready без DB и рабочего Telegram runtime.
- Rolling/recreate deployment не создаёт дубликаты scheduled prompts.
- Есть проверенная процедура backup/restore и rollback приложения.
- Production-конфигурация не публикует PostgreSQL или backend наружу без явной необходимости.
- Smoke-check подтверждает `/start`, `/settings`, voice и report flow.
- Один и тот же вход даёт одинаковые UTC instants и scheduled occurrence независимо от timezone процесса, контейнера и DB session.

## Проверки

- `docker build` и проверка пользователя/runtime contents.
- `docker compose config` без публикации вывода с секретами.
- Запуск stack, healthchecks и controlled restart.
- Тест rollout overlap с двумя app processes без двойной рассылки.
- Запуск timezone smoke matrix для Node/container и PostgreSQL session, включая migration/backfill на отдельной БД.
- Тест restore в отдельную БД.
- `npm test`

## Риски и решения

- Readiness внешних AI providers не должна делать приложение permanently unready из-за краткого сбоя; использовать degraded status и runtime timeouts.
- Prisma migration rollback не всегда обратим; несовместимая схема требует restore.
- `TZ=UTC` полезен для единообразных логов и эксплуатации, но не считается исправлением DST, local-date или DB timestamp semantics.
- Эта задача использует существующий deployment-план как источник, но не изменяет его и не включает `admin`.
