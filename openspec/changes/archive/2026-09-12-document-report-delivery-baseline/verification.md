# Проверки baseline report-delivery

Здесь зафиксированы результаты подготовки и завершённого переноса baseline.
Все пути ниже указаны от корня репозитория; названия тестов позволяют найти
конкретные assertions. Состояние до применения описано отдельно от итогового.

## Карта сценариев

| Требование / сценарии | Существующие проверки и границы доказательства |
| --- | --- |
| Сохранённый отчёт без нового анализа | `test/report-handler-lifecycle.test.js`, `ReportHandler resends generated persisted output without invoking the LLM`: ноль LLM-вызовов/completeGeneration, сохранённые transcript и streak snapshot. `test/user-journey.test.js` проверяет явный `/report` после автоматического отчёта и второй delivery request без нового анализа. |
| Новая команда после доставки; повтор завершённого update | Journey проверяет самостоятельный message request после автоматической доставки. `test/report-lifecycle.test.js`, `a begun delivery is ambiguous until its exact attempt advances the cursor and finalizes` проверяет повтор уже завершённого request. `test/report-handler-lifecycle.test.js`, `already delivered saved request` проверяет отсутствие новых сообщений. |
| Повтор update с начатой отправкой | Тот же lifecycle-тест возвращает `ambiguous` для уже начатой попытки и не принимает подмену chunks. Подсказка пользователю для `ambiguous`/`failed` дополнительно сверена в `ReportWorkflowService.deliverPersisted`; отдельного сквозного теста этой подсказки нет. |
| Лимит частей, буквальный текст, emoji и клавиатура | `test/report-output.test.js`: literal quotes/emoji/markup, длины 4095/4096/4097, сохранение текста, surrogate pairs. `test/report-handler-lifecycle.test.js`, `ReportHandler manual claim generates and persists once, then delivers plain chunks with only a final keyboard`: порядок, отсутствие parse mode и клавиатура только в конце. |
| Подтверждение частей; устаревшее подтверждение | `test/report-lifecycle.test.js`, `a begun delivery is ambiguous until its exact attempt advances the cursor and finalizes`: неверные index/timestamp, старый token, переход к следующей части и фиксация полной доставки. |
| Определённый отказ; новая команда после него | `test/report-handler-lifecycle.test.js`, `ReportHandler records GrammyError as definite and HttpError as ambiguous delivery` и `ReportHandler can resend generated output under a new request after definite delivery failure`. `test/report-lifecycle.test.js`, `definite and ambiguous delivery failures diverge, while a new key permits intentional resend`: тот же ключ остаётся failed, новый создаёт самостоятельную доставку. |
| Неоднозначная ошибка; повтор update; новая команда | Те же handler/lifecycle-тесты проверяют разделение definite/ambiguous, сохранение pending и самостоятельность нового request. Запрет reclaim уже начатой попытки независимо от lease дополнительно проверен по порядку условий в `ResponseDeliveryOperations.createOrClaimDeliveryRequest`: attempt проверяется до срока lease. Неподтверждённая доставка не запускает generation в `ReportWorkflowService.deliver`. |
| Ошибка фиксации успеха после отправки | `test/report-handler-lifecycle.test.js`, `ReportHandler does not reclassify post-send persistence failure as generation failure`: один send, отсутствие второго/error-send, отсутствие failGeneration. |
| Отчёт после retention | `test/report-handler-lifecycle.test.js`, `ReportHandler explains when a generated report expired under data retention`: сообщение о сроке хранения и `/start`, ноль LLM и delivery calls. |

## Выполнено при подготовке

Дата: 2026-09-12. OpenSpec CLI 1.13.0. Для приложения использован Node.js
**24.18.0** из закреплённой версии, временно доступный через npm exec;
`package.json` и lockfile не менялись.

```bash
npm exec --yes --package=node@24.18.0 -- node -p 'process.execPath'
# Каталог полученного node добавлен в PATH для следующих команд.
npm run build
node --test test/report-handler-lifecycle.test.js test/report-lifecycle.test.js test/report-output.test.js test/user-journey.test.js
```

- Сборка: успешно.
- Тесты: **39 passed, 0 failed, 0 skipped**.
- Подтверждённых расхождений контракта с текущим кодом не обнаружено.
- Новые тесты и runtime-изменения на стадии подготовки не вносились.
- `openspec validate document-report-delivery-baseline --strict --no-interactive --json`: проверен один change, valid=true, issues=[]; основная spec пока отсутствует.
- Проверка формата: 7 требований, 15 сценариев; у каждого есть WHEN/THEN. Локальные ссылки и `git diff --check` прошли.
- Review baseline, proposal, tasks и карты проверок: без замечаний к корректности.
- Подготовлен `documentation.patch` для четырёх документов; `git apply --check` и отдельное review переноса прошли без замечаний. Patch не применён.
- `openspec status` показывает отсутствующий design: это осознанный условный пропуск, описанный в proposal/tasks, а не результат полной реализации.

## Ограничения

Запущенные проверки используют подменённые Telegram/AI/Prisma-зависимости.
Они не доказывают результат живой отправки Telegram или конкурентных
транзакций реального PostgreSQL.

В репозитории есть PostgreSQL-проверка `report ownership, fencing, and uniqueness
are enforced` в `integration/postgres-critical-invariants.integration.js`.
Она не запускалась в этой задаче: изменения DB/schema/concurrency не предлагаются.
При изменении этих механизмов нужен существующий `npm run test:postgres`.

Идемпотентность относится к повтору одного сообщения. Новая команда `/report`
намеренно может повторить уже полученные части; гарантия exactly-once для
Telegram при неизвестном сетевом исходе не заявляется.

## Итог переноса — 2026-09-12

- Пользователь явно принял baseline и `documentation.patch`, а также одобрил перевод карточек #2 и #3 в Done после завершения этапа.
- Создана `openspec/specs/report-delivery/spec.md`: Purpose, все 7 требований и 15 сценариев совпадают с принятой baseline; изменены только заголовки основного формата.
- `documentation.patch` применён к четырём документам. `git apply --reverse --check` подтвердил точное соответствие согласованному diff.
- Правило GitHub сохранено побайтно; src/test/prisma/package-файлы не менялись. Код остаётся на ревизии `7bc198c`, поэтому использованы результаты 39 тестов стадии подготовки без повторного запуска.
- `openspec validate --all --strict --no-interactive --json`: проверены **2 объекта — change и основная spec; 2 passed, 0 failed**.
- Проверены 44 локальные ссылки, точное совпадение основной spec с delta и `git diff --check`.
- Финальное review интеграции: без замечаний. Перенос не меняет продуктовую семантику.

## Завершение

- Change перемещён в `openspec/changes/archive/2026-09-12-document-report-delivery-baseline/` вместе с `.openspec.yaml`, принятыми артефактами и всеми 7 выполненными пунктами.
- `openspec list --json`: активных changes нет. `openspec list --specs --json`: присутствует `report-delivery`.
- `openspec validate --all --archived --strict --no-interactive --json`: архивированный change valid=true, issues=[] (режим `--archived` выбрал один архивный change; основная spec проверена отдельно до архивирования).
- На приватной Talking bob board карточки #2 и #3 переведены в **Done** по явному аппруву пользователя. После записи статусы перечитаны и подтверждены; состояние публичных issues осталось OPEN.
- Архитектура, runtime-код, тесты, Prisma schema и зависимости не изменены.
