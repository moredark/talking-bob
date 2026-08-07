# Синхронизация документации и runtime-конфигурации

- Priority: `P1`
- Status: `todo`
- Scope: product docs, data docs, env contract
- Admin: out of scope
- Depends on: целевые решения из `01`–`05`, но не их полная реализация
- Blocks: `08`

## Проблема

Документы описывают mock AI и старый одношаговый MVP, хотя приложение использует реальные providers, follow-up разговор, расписание и автоматический report. Database doc не совпадает со схемой. Подготовительная очистка уже исключила TTS из текущего runtime-контракта. `.env.example` ещё не содержит все читаемые кодом параметры и не разделяет required/optional.

## Связанные файлы

- `README.md`
- `docs/app.md`
- `docs/database.md`
- `.env.example`
- `package.json`
- `prisma/schema.prisma`
- `docs/DEPLOYMENT_PLAN.md` — только backend-релевантная ссылка, без изменения в этой задаче

## План реализации

1. Сделать `README.md` короткой точкой входа: назначение, быстрый старт, команды, ссылки на подробные docs.
2. Переписать `docs/app.md` по фактическому flow:
   - регистрация;
   - prompts;
   - follow-up;
   - report;
   - settings;
   - failure/retry behavior.
3. Обновить `docs/database.md` по фактическим bot/backend моделям, связям, индексам и инвариантам.
4. Зафиксировать языки сообщений: русский интерфейс/feedback и английский conversation follow-up.
5. Описать границу text-only runtime и явно указать, что voice/TTS для вопросов относится к отдельной будущей задаче.
6. Составить таблицу env:
   - имя;
   - required/optional;
   - default;
   - consumer;
   - secret/non-secret;
   - допустимый формат.
7. Устранить расхождение между `.env.example`, code defaults и deployment docs.
8. Описать time contract:
   - canonical effective IANA timezone пользователя, alias normalization и default/fallback `Europe/Moscow`;
   - хранение бизнес-моментов как UTC instants и DB-семантику timestamp;
   - DST gap/overlap и точную границу целевого слота;
   - bounded catch-up после простоя;
   - изменение времени/timezone и scheduled occurrence identity;
   - локальный календарный день и состав действий в лимите 20 диалогов;
   - отсутствие обязательного `TZ` env для корректности.
9. Указать версию/дату актуальности нормативных документов.

## Acceptance criteria

- Новый разработчик может запустить bot по README без поиска скрытых шагов.
- `docs/app.md` описывает фактический conversation/report flow.
- `docs/database.md` соответствует Prisma-схеме в bot/backend scope.
- Для каждой читаемой bot/backend env-переменной есть запись в `.env.example` и документации.
- Документация однозначно описывает timezone, UTC storage, DST, catch-up, изменение расписания и календарный лимит; operational `TZ=UTC` не представлен как исправление бизнес-логики.
- В документации нет обещания рабочего TTS, если он не интегрирован.
- Документация описывает startup validation, реализованную в задаче `01`.
- Документы не содержат задач или требований для `admin`.

## Проверки

- Сопоставить `process.env.*` и `env()` с таблицей env.
- Сопоставить time contract с задачами `02`, `04`, Prisma schema/migrations и deployment docs.
- Выполнить setup по README в чистом окружении.
- `npm run build`
- `npm test`
- `npx prisma validate`
- Ручная проверка относительных ссылок.

## Риски и решения

- Docs выполняются после целевых решений, иначе они снова устареют.
- Сгенерированная schema reference не заменяет объяснение доменных инвариантов.
- `docs/DEPLOYMENT_PLAN.md` остаётся отдельным пользовательским документом и не редактируется этой задачей.
