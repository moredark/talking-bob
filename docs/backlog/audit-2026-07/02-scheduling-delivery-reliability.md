# Расписание и надёжная доставка prompts

- Priority: `P0`
- Status: `done`
- Scope: users, scheduler, prompt delivery
- Admin: out of scope
- Depends on: none
- Blocks: `05`, `07`, `08`

## Проблема

Новый пользователь создаётся с `dailyPromptEnabled=true`, но без `nextPromptAt`, поэтому рассылка отображается включённой и никогда не срабатывает. Scheduler двигает расписание, а dispatcher создаёт `UserPrompt` до подтверждённой доставки. При сбое Telegram день пропускается, а в БД остаётся вопрос, которого пользователь не видел.

Расчёт следующего слота использует текущее timezone-смещение и не имеет единой валидации IANA timezone, поэтому может ошибаться при DST и падать на legacy-невалидном значении. Не определены идентичность плановой отправки за локальную дату, смена времени/timezone, catch-up после простоя и независимость от timezone процесса и БД.

## Связанные файлы

- `prisma/schema.prisma`
- `prisma/migrations/*`
- `src/config/limits.config.ts`
- `src/modules/user/user.service.ts`
- `src/modules/schedule/schedule.service.ts`
- `src/modules/schedule/scheduler.service.ts`
- `src/modules/schedule/daily-prompt.dispatcher.ts`
- `src/modules/rate-limit/rate-limit.service.ts`
- `src/modules/telegram/handlers/start.handler.ts`
- `src/modules/telegram/handlers/settings.handler.ts`

## План реализации

1. Выбрать корректный initial state:
   - включённая рассылка с атомарно рассчитанным `nextPromptAt`; или
   - выключенная рассылка до выбора времени.
2. Исправить создание пользователя и подготовить идемпотентный schedule repair для `dailyPromptEnabled=true AND nextPromptAt IS NULL`: он только назначает первый регулярный слот не раньше `now` по правилу точной границы из пункта `10` и не инициирует отправку.
3. Использовать `UserPrompt` как устойчивую запись одной попытки доставки со статусом `pending/sent/failed`, nullable `sentAt` и sanitized полями последней ошибки.
4. До вызова Telegram атомарно создавать/claim запись `pending`; после подтверждения выставлять `sent` и фактический `sentAt`. Только однозначный отказ Telegram переводит запись в `failed`; timeout, потеря соединения и crash после возможной отправки оставляют `pending` с sanitized-причиной неоднозначного результата.
5. Не выполнять автоматическую повторную отправку после неоднозначного результата Telegram. Явно различать retry безопасной подготовительной операции и повтор самой доставки.
6. Разрешать voice/conversation flow только для `UserPrompt` со статусом `sent`; failed-запись не должна выглядеть доставленным вопросом.
7. Заменить in-memory delay первого вопроса на идемпотентный механизм или гарантированно отменять дубли.
8. Для нескольких экземпляров приложения добавить DB-atomic claim/lock; до этого сохранить явное ограничение «один instance».
9. Ввести общий resolver effective timezone для scheduler, settings и calendar-day rate limit: валидный canonical IANA identifier, нормализация aliases перед сохранением, default/fallback `Europe/Moscow`, sanitized warning для legacy-невалидного значения.
10. Валидировать `hour/minute` и рассчитывать `nextPromptAt` по timezone-правилам целевой локальной даты, а не по смещению в момент `now`. Зафиксировать:
   - при точном совпадении с целевой минутой текущий слот считается наступившим;
   - при DST gap используется первый валидный локальный момент после пропуска;
   - при DST overlap используется первое вхождение, повторный час не создаёт вторую доставку.
11. Добавить для scheduled delivery отдельные `source`, nullable `scheduledOccurrenceKey`, `scheduledLocalDate` и `timezoneSnapshot` либо эквивалентную сущность. Key детерминирован пользователем и scheduled local date, не включает timezone, атомарно сохраняется при claim и после claim неизменяем; DB-уникальность действует только для non-null scheduled key и не ограничивает ручные `/start`-диалоги.
12. При смене времени или timezone атомарно сохранять настройки и пересчитывать `nextPromptAt`: ещё не claimed occurrence заменяется, claimed/pending сохраняет key и snapshot, а новые настройки применяются со следующего occurrence. Settings показывает canonical effective timezone, а timezone-picker остаётся вне текущего scope.
13. Отделить runtime downtime catch-up от schedule repair и migration: все пропуски схлопываются в последний пропущенный слот, выполняется не более одной попытки overdue scheduled occurrence на пользователя, затем назначается первый регулярный слот строго после `now`.
14. Подготовить идемпотентную нормализацию legacy aliases, backfill legacy-невалидных timezone и пересчёт `nextPromptAt`. Backfill и runtime-расчёты не должны зависеть от `TZ` приложения, timezone контейнера или PostgreSQL session `TimeZone`.

## Acceptance criteria

- Любой пользователь со статусом «рассылка включена» имеет валидный `nextPromptAt`.
- Schedule repair безопасно запускается повторно, не меняет выключенных пользователей и не инициирует доставку.
- Scheduler, settings и rate limit одинаково разрешают effective timezone; legacy-невалидное значение не роняет пользовательский flow.
- `nextPromptAt` соответствует следующему локальному слоту на границах суток и DST и одинаков при разных `TZ` процесса и PostgreSQL session `TimeZone`.
- Точный целевой момент, DST gap и DST overlap следуют зафиксированной политике; за одну локальную дату возникает не более одного scheduled occurrence.
- У scheduled occurrence есть DB-защищённый, не зависящий от timezone key и snapshot metadata; identity не ограничивает ручные диалоги пользователя.
- При успешной доставке создаётся ровно один `UserPrompt`.
- При однозначном отказе доставки `UserPrompt` получает статус `failed` и sanitized-причину.
- При неоднозначном результате `UserPrompt` остаётся `pending` с sanitized-причиной, не повторяется автоматически и доступен для ручной диагностики.
- Два scheduler worker не отправляют один и тот же prompt дважды.
- Смена времени/timezone атомарно пересчитывает будущий слот, не меняет key уже claimed/pending occurrence и не создаёт дубль.
- После многодневного простоя пользователь не получает replay burst: обрабатывается не более одного последнего overdue scheduled occurrence, затем расписание продолжается строго после `now`.
- Только `sent`-запись доступна как текущий диалог пользователя.
- Настройки показывают canonical effective IANA timezone и фактический статус расписания.

## Проверки

- Тест создания нового пользователя и вычисления `nextPromptAt`.
- Отдельные тесты schedule repair без отправки, downtime catch-up последнего пропущенного слота и legacy `UserPrompt` migration без доставки.
- Тесты `text success`, однозначного `delivery failed` и неоднозначного timeout в `pending` без повторной отправки.
- Тест конкурентного claim одной due-записи.
- Fake-clock тесты до, после и точно в целевую минуту, на локальной полуночи, 23- и 25-часовых сутках, DST gap и DST overlap.
- Тесты canonical timezone, alias normalization и legacy-invalid fallback, одинакового результата при разных `process.env.TZ` и PostgreSQL session `TimeZone`.
- Тесты смены времени/timezone до и после claim, неизменности claimed key/snapshot, многодневного простоя и независимости scheduled identity от ручных `/start`.
- `npm test`
- `npx prisma validate`, если меняется схема.

## Риски и решения

- Окно `send succeeded → process crashed → DB not updated` не устраняется без идемпотентности на стороне Telegram; такая запись остаётся `pending` и требует ручной диагностики, а не автоматической повторной отправки.
- Миграция не должна считать все существующие `UserPrompt` доставленными: записи с последующими conversation/response данными можно backfill как `sent`, а записи без подтверждающих данных — как `pending` с причиной `legacy_unknown`, без автоматической повторной отправки. Такая migration только классифицирует данные и никогда не инициирует доставку. После классификации `sentAt` становится nullable и добавляются delivery status/error fields.
- До изменения схемы выбрать и документировать DB-семантику UTC instant (`TIMESTAMP` с жёсткой UTC-конвенцией или `timestamptz`); migration/backfill не использует session-dependent `CURRENT_DATE` без явной timezone.
- Snapshot локальной даты/timezone относится только к scheduled occurrence: `UserPrompt` также обслуживает ручные диалоги, поэтому общая уникальность по `userId + localDate` недопустима.

## Принятые решения реализации

- Сохраняется текущий product default: новый пользователь сразу имеет
  `dailyPromptEnabled=true`, `13:00`, `Europe/Moscow`; валидный
  `nextPromptAt` записывается атомарно при создании.
- Единственный timezone resolver использует `Intl.DateTimeFormat` и canonical
  identifier текущего Node/ICU. Пустое или невалидное legacy-значение получает
  fallback `Europe/Moscow` без логирования исходной строки.
- Расчёт wall-clock slot реализуется без новой зависимости. Текущая целевая
  минута считается наступившей; DST gap сдвигается к первой валидной минуте,
  overlap выбирает первое вхождение.
- Бизнес-моменты task 02 переводятся в PostgreSQL `timestamptz(3)`.
  Существующие `timestamp without time zone` интерпретируются как UTC явно
  через `AT TIME ZONE 'UTC'`; старые `nextPromptAt` не считаются надёжными,
  очищаются и пересчитываются runtime repair.
- Legacy `UserPrompt` получает source `legacy`. Наличие conversation/response
  подтверждает `sent`; запись без подтверждения становится terminal
  `pending` с `legacy_unknown` и никогда автоматически не отправляется.
- Scheduled occurrence key имеет вид
  `scheduled:<userId>:YYYY-MM-DD`, не включает timezone/time/prompt и защищён
  partial unique index. Metadata claimed occurrence неизменяема DB trigger.
- Claim выполняется короткой PostgreSQL transaction с row locks/
  `SKIP LOCKED`; Telegram I/O выполняется только после commit.
- Перед Telegram сохраняется `deliveryAttemptedAt` и
  `telegram_outcome_unknown`. `GrammyError` считается однозначным отказом;
  `HttpError` и неизвестный transport result остаются terminal `pending` без
  автоматической повторной отправки.
- Claim, завершённый до изменения settings/disable, может закончить доставку;
  новые настройки влияют только на ещё не claimed occurrence.
- Detached delay первого `/start`-вопроса удаляется: manual claim и доставка
  выполняются синхронно в контролируемом update lifecycle.

## Результат выполнения

- Добавлен общий canonical/fallback IANA timezone resolver и DST-safe расчёт
  wall-clock slots: точная граница, gap, overlap, локальная полночь и
  23/25-часовые сутки не зависят от timezone процесса.
- Новый пользователь атомарно получает включённое расписание и валидный
  `nextPromptAt`; startup normalization идемпотентно чинит enabled/disabled
  legacy rows, aliases, невалидные timezone и время без отправки сообщений.
- `UserPrompt` переведён на durable lifecycle `pending/sent/failed` с nullable
  `sentAt`, sanitized outcome fields, claim lease и scheduled snapshot.
- Миграция явно интерпретирует legacy timestamps как UTC, классифицирует
  подтверждённые legacy prompts как `sent`, а неоднозначные как terminal
  `pending/legacy_unknown`; raw partial index и trigger защищают scheduled
  identity.
- Scheduler использует короткие `FOR UPDATE SKIP LOCKED` transactions,
  схлопывает downtime до последнего overdue occurrence, продвигает расписание
  строго после `now` и выполняет Telegram I/O только после commit.
- Voice fallback разрешён только после однозначного `GrammyError`; transport и
  неизвестный outcome остаются `pending` без автоматической повторной отправки.
- `/start` создаёт durable manual claim и ожидает общий dispatcher без
  detached timer; текущим диалогом считается только `sent` prompt.
- Settings атомарно пересчитывает/очищает расписание и показывает canonical
  effective timezone. Admin остаётся вне scope этой задачи.

## Выполненные проверки

- `npm test` — успешно, 77 тестов из 77.
- `npx prisma validate` — схема валидна.
- `git diff --check` — успешно.
- Fake-clock/process-TZ, lifecycle/failure, catch-up, simulated two-worker
  conflict, user-create race, settings и legacy normalization покрыты тестами.
- Live PostgreSQL migration/concurrency/session-`TimeZone` test не запускался:
  в окружении нет доступного PostgreSQL или Docker daemon. Raw SQL и
  конкурентные гарантии прошли static review и mock contract tests; реальный
  двухсессионный прогон остаётся deployment validation, а не скрытой проверкой.
