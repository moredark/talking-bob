# Работа с OpenSpec в Talking Bob

OpenSpec подключён для локальной работы с Codex: CLI **1.13.0**, профиль **core**,
схема **spec-driven**. Первый перенесённый контракт —
[доставка сохранённого отчёта](../openspec/specs/report-delivery/spec.md).
Следующий этап — полный цикл первого продуктового изменения.

## Установка и повторная настройка

OpenSpec требует Node.js >=20.19.0. Для самого приложения используется отдельная
закреплённая версия **24.18.0** из `.nvmrc` и `package.json`.

В текущей WSL-среде CLI установлен в пользовательский prefix `~/.local`.
Команды выполняются в корне репозитория:

```bash
node --version
npm install --global --prefix "$HOME/.local" @fission-ai/openspec@1.13.0
export PATH="$HOME/.local/bin:$PATH"
openspec --version
openspec init --tools codex --profile core --no-animation
```

Codex может запускать shell без `~/.local/bin` в PATH. В таком случае добавь
`export PATH="$HOME/.local/bin:$PATH"` в начало текущего shell-вызова либо используй
`$HOME/.local/bin/openspec`. Установка не меняет shell startup files, npm prefix
по умолчанию или зависимости приложения.

`init` создаёт `openspec/config.yaml`, каталоги specs/changes и шесть skills
в `.agents/skills/`. Существующие skills сохраняются. Профиль `core` в этой
команде применяется к текущему запуску и не меняет глобальный выбор workflows.
После первой настройки перечитай skills в новой сессии Codex; если они не
появились в списке, перезапусти приложение.

Generated skills и `.agents/skills/.openspec-target` храним в Git вместе
с `openspec/`. Контекст и правила редактируем в config/AGENTS; generated skills
обновляет CLI. Для повторной генерации core используй ту же закреплённую версию
и команду `init` выше. Проверяй diff после обновления. `openspec update` учитывает
глобальный профиль и может предложить обновление CLI, поэтому для воспроизведения
этой настройки используем явный `init --profile core`.

## Где что хранится

| Источник | Назначение |
| --- | --- |
| `AGENTS.md` | Архитектурные ограничения и правило аппрува GitHub |
| `openspec/config.yaml` | Компактный контекст, правила артефактов и guidance для apply/archive |
| `openspec/specs/<capability>/spec.md` | Согласованное реализованное поведение перенесённой области |
| `openspec/changes/<change-name>/` | Proposal, delta specs, design при необходимости и tasks текущего изменения |
| `openspec/changes/archive/` | Завершённые изменения |
| [docs/app.md](app.md), [docs/database.md](database.md) | Нормативные контракты до их явного переноса |
| [Архитектурный индекс](architecture/README.md) | Карта модулей и источников истины |

Переносим по одному затронутому контракту: сверяем документ, код и тесты,
согласуем spec, заменяем нормативный дубль ссылкой и обновляем карту источников
в той же правке. Prisma schema/SQL migrations и operational runbook сохраняют
свои функции. Массовая конвертация всей документации не требуется.

## Обычный цикл

Это обращения **в чат Codex**, а не команды терминала:

| Обращение | Результат |
| --- | --- |
| `$openspec-explore <проблема>` | Изучить текущую область и уточнить намерение |
| `$openspec-propose <change-name и описание>` | Подготовить предложение и артефакты для review |
| `$openspec-update-change <change-name и уточнение>` | Согласованно пересмотреть существующие артефакты |
| `$openspec-apply-change <change-name>` | Выполнить согласованные задачи |
| `$openspec-sync-specs <change-name>` | Перенести реализованные дельты в основные specs |
| `$openspec-archive-change <change-name>` | Синхронизировать оставшиеся дельты и архивировать готовое изменение |

Перед реализацией прочитай предложение и сценарии, разреши материальные вопросы
и согласуй сложное изменение. После apply выполни релевантные проверки и review.
Если меняется намерение, сначала обнови согласованные артефакты; если код нарушает
принятое требование — исправь код. Архивировать можно после подтверждения результата.

`verify`, `new`, `continue`, `ff`, `onboard`, `bulk-archive` в core не входят.
При необходимости выбери их через `openspec config profile`, затем обнови
generated files и проверь diff. Проектные `context`/`rules` являются инструкциями
агенту и не заменяют проверки или аппрув.

Маленькие исправления без изменения поведения могут идти обычным patch.
Если для tooling нужен отдельный tracked change, укажи `skip_specs: true`
в его `.openspec.yaml`; не создавай выдуманные требования ради валидатора.

## Проверки

Команды выполняются в терминале с настроенным PATH:

```bash
openspec --version
openspec context --json
openspec schemas --json
openspec list --specs
openspec list
openspec validate --all --strict --no-interactive
```

В списке specs ожидается как минимум `report-delivery`; список активных changes
зависит от текущей работы и архивирования. Успешный `validate` с нулём элементов
не проверяет поведение приложения: сверяй количество и содержимое найденных элементов. CLI проверяет структуру документов; смысл
подтверждают тесты и review. Правильность YAML/context дополнительно проверяется
через `openspec instructions <artifact> --change <name> --json` в реальном change.

Для backend используй `npm run test:ci`, для Telegram journey — `npm run test:smoke`,
для admin — `npm run test:admin`. Изменения DB/миграций требуют `test:postgres`,
контейнеров — подходящего container/operations gate. Сохраняй обязательные проверки
конкретного backlog. Для документации достаточно проверки ссылок и `git diff --check`.
Не отмечай пропущенные проверки как успешные.

## GitHub Projects

[Talking bob board](https://github.com/users/moredark/projects/2) показывает
крупные задачи в `Todo → In Progress → Done`. Действия внутри change остаются
в `tasks.md`; не создаём отдельную карточку на каждый шаг OpenSpec.

Публичные действия на GitHub требуют явного аппрува конкретного действия или
согласованного пакета по [AGENTS.md](../AGENTS.md#github-approval-mandatory).
Сначала готовим содержимое локально и показываем цель/изменения. Доступ через gh
не означает разрешение на публичную публикацию. Явно одобренное действие
в неизменном scope повторно не согласуем.

Изменения подтверждённо приватных ресурсов в рамках текущей задачи можно
выполнять без отдельного аппрува: например, переместить карточку, изменить поля
или описание приватной доски, обновить issue в приватном репозитории.
Перед записью проверяем видимость самого ресурса и публичные последствия.
Приватная доска не делает связанный публичный issue приватным: комментарий
или изменение такого issue требуют аппрува. Если видимость или последствия
неясны, сначала выясняем их.

## Источники

[Исследование и план внедрения](spec-driven-development.md),
[OpenSpec setup](https://openspec.dev/docs/setup),
[CLI reference](https://openspec.dev/docs/cli),
[Project config](https://openspec.dev/docs/project-config).
