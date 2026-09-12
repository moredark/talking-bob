## Why

Повторная доставка `/report` уже реализована, но её контракт распределён между
`docs/app.md`, lifecycle-кодом и тестами. Задача [#3](https://github.com/moredark/talking-bob/issues/3)
переносит этот существующий срез в первую проверяемую baseline-spec OpenSpec.

## What Changes

- Описать `report-delivery`: повторное использование сохранённого анализа,
  новый запрос и повтор того же update, доставка частями, definite/ambiguous
  ошибки и недоступность очищенного отчёта.
- Сопоставить сценарии с существующими assertions и записать результаты проверок
  в `verification.md` этого change.
- После принятия baseline перенести её в `openspec/specs/report-delivery/spec.md`,
  заменить только соответствующие нормативные фрагменты `docs/app.md` ссылками
  и обновить карту источников истины и указатели в инструкциях проекта.

Сейчас создаются артефакты для review. До принятия baseline текущим нормативным
источником остаётся `docs/app.md`; перенос источника истины выполняется одной
согласованной правкой. План переноса указан в `tasks.md`; точный diff четырёх
документов подготовлен в `documentation.patch` и пока не применён.

### Non-goals

Продуктовое поведение, зависимости, schema/migrations и runtime-код не меняются.
Readiness, первоначальная генерация и её retries, квоты, квалификация стрика,
callback-протокол и сроки retention остаются вне переносимого контракта.
Новые тесты нужны только при подтверждённом пробеле в выбранных сценариях.
Полный цикл первого продуктового изменения остаётся отдельной задачей #4.

## Capabilities

### New Capabilities

- `report-delivery`: впервые представленный в OpenSpec контракт уже работающей
  доставки сохранённого отчёта. `ADDED` означает добавление baseline в реестр
  спецификаций, а не новую функцию бота.

### Modified Capabilities

Нет: реестр основных OpenSpec specs пока пуст.

## Impact

- После согласования меняются только основная spec, соответствующие фрагменты
  `docs/app.md`, карта `docs/architecture/README.md`, указатели в `AGENTS.md`
  и описание текущего этапа в `docs/sdd-workflow.md`.
- Исходный контракт: `docs/app.md`, разделы Voice conversation and reports
  и Privacy and retention; DB-инварианты остаются в `docs/database.md`
  и `prisma/schema.prisma`.
- Сверено с `ReportHandler`, `ReportWorkflowService`,
  `ResponseDeliveryOperations`, `ResponseGenerationOperations` и report tests.
  Обнаруженные ограничения покрытия фиксируются отдельно от требований.
- Отдельный `design.md` не нужен: нет изменения архитектуры, внешних зависимостей,
  данных или алгоритма; мигрирует только место описания существующего поведения.
