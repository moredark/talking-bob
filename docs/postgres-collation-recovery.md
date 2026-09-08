# Восстановление PostgreSQL после перехода с Debian на Alpine

Этот сценарий предназначен для PostgreSQL 16 с `datlocprovider = c`,
`datcollate = en_US.utf8`, сохранённой `datcollversion = 2.41` и пустой
`pg_database_collation_actual_version(oid)` на Alpine. Предупреждение
`has no actual collation version, but a version was recorded` повторяется
при подключениях, включая healthcheck каждые 5 секунд.

Оба Compose-файла используют PostgreSQL `16.13-trixie` с закреплённым digest:

```text
postgres:16.13-trixie@sha256:5d143123fdf80462d1778cd4f24b9f7ca13c87174bca19141fb194c5a1ebca59
```

Debian Trixie использует glibc 2.41. После смены образа индексы нужно
перестроить: записи, сделанные на Alpine, могли использовать другой порядок
сортировки. Совпадение номеров версий само по себе не проверяет индексы.

## 1. Выбрать текущий Compose-проект

Выполняйте шаги на сервере из каталога проекта в одном сеансе Bash.
При любой ошибке остановитесь; бот должен оставаться остановленным до
завершения восстановления. На время работ отключите автоматический деплой
и остановите другие приложения, которые пишут в эту БД.

Определите `dc` с теми же Compose-файлами, `--env-file` и именем проекта
(`-p`, если использовалось), с которыми запущен сервер. Для обычного запуска
`docker compose`:

```bash
set -euo pipefail
umask 077
dc() { docker compose "$@"; }
```

Если используете npm-команды с Tailscale, замените определение функции:

```bash
dc() { docker compose -f docker-compose.yml -f compose.tailscale.yml "$@"; }
```

Для production-образов с Tailscale:

```bash
dc() { docker compose -f compose.production.yml -f compose.tailscale.production.yml "$@"; }
```

Проверьте, что выбрали существующий контейнер БД и его том:

```bash
dc config --quiet
dc ps
db_container=$(dc ps -q db)
test -n "$db_container"
docker inspect --format 'Image={{.Config.Image}} Mounts={{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}} {{.Source}}{{end}}{{end}}' "$db_container"
dc exec -T db sh -ceu 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"'
```

Если установлены дополнительные расширения помимо `plpgsql`, перед сменой
образа проверьте наличие их совместимых библиотек в целевом образе.
Сохраните текущий каталог проекта и настройки тома: смена имени Compose-проекта
может подключить другой, пустой том.

## 2. Скачать образ и создать резервную копию

Сначала доставьте обновлённые Compose-файлы на сервер. Далее скачайте образ,
остановите бот с предусмотренным временем завершения запросов и сохраните
дамп и роли в отдельном закрытом каталоге вне репозитория:

```bash
dc pull db
dc stop app
recovery_dir=$(mktemp -d "$HOME/talking-bob-collation-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
docker inspect --format '{{.Config.Image}}' "$db_container" > "$recovery_dir/previous-db-image.txt"
dc exec -T db sh -ceu 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$recovery_dir/talkingbob.dump"
dc exec -T db sh -ceu 'pg_dumpall -U "$POSTGRES_USER" --globals-only' > "$recovery_dir/globals.sql"
test -s "$recovery_dir/talkingbob.dump"
test -s "$recovery_dir/globals.sql"
dc exec -T db pg_restore --list < "$recovery_dir/talkingbob.dump" > /dev/null
(cd "$recovery_dir" && sha256sum talkingbob.dump globals.sql > SHA256SUMS && sha256sum --check SHA256SUMS)
printf 'Backup directory: %s\n' "$recovery_dir"
```

`pg_restore --list` проверяет читаемость оглавления, а не полное восстановление.
Скопируйте каталог резервной копии на отдельный хост перед следующим шагом.
`globals.sql` содержит роли и может содержать хеши паролей; храните его закрытым.
Если в `postgres`, `template1` или других базах есть пользовательские данные,
сделайте также отдельный дамп каждой такой базы.

## 3. Пересоздать только контейнер БД

Используйте существующий `db_data`. На этом шаге бот остаётся остановленным:

```bash
dc up -d --no-deps --force-recreate --wait --wait-timeout 180 db
dc exec -T db sh -ceu 'postgres --version; getconf GNU_LIBC_VERSION'
dc exec -T db sh -ceu 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT datname, datcollversion, pg_database_collation_actual_version(oid) AS actual_version FROM pg_database ORDER BY datname;"'
```

Ожидаются PostgreSQL 16.13, `glibc 2.41` и `actual_version = 2.41`.
У `template0` сохранённая версия может быть пустой — это нормально.
Если контейнер не стал healthy или фактическая версия отличается от ожидаемой,
оставьте бот остановленным и проверьте `dc logs --tail=100 db`.

## 4. Перестроить индексы и проверить версии

`reindexdb --all` перестраивает пользовательские индексы во всех доступных
базах, включая `talkingbob`, `postgres` и `template1`; закрытую для подключений
`template0` он пропускает. Операция требует места для новых индексов и может
занять время. При ошибке, включая нарушение уникальности, не запускайте бот.

```bash
dc exec -T db sh -ceu 'exec reindexdb --username="$POSTGRES_USER" --all --verbose'
dc exec -T db sh -ceu 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT format('ALTER DATABASE %I REFRESH COLLATION VERSION;', datname)
FROM pg_database
WHERE datcollversion IS NOT NULL
  AND pg_database_collation_actual_version(oid) IS NOT NULL
  AND datcollversion <> pg_database_collation_actual_version(oid)
\gexec

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_database
    WHERE datcollversion IS NOT NULL
      AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)
  ) THEN
    RAISE EXCEPTION 'Collation versions still differ; keep the app stopped';
  END IF;
END;
$$;

SELECT datname, datcollversion,
       pg_database_collation_actual_version(oid) AS actual_version
FROM pg_database
ORDER BY datname;
SQL
```

При совпадении версий `2.41` команды `ALTER DATABASE` не выполняются.
`REFRESH COLLATION VERSION` только обновляет метаданные, поэтому допускается
после успешного перестроения индексов. На прежнем Alpine переход из сохранённой
версии в `NULL` закончился бы ошибкой `invalid collation version change`.

## 5. Запустить существующий контейнер приложения

```bash
collation_check_since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc start app
dc ps
dc logs --since "$collation_check_since" db app
```

Дождитесь healthy у приложения и проверьте свежие логи БД как минимум через
два интервала healthcheck (10 секунд): предупреждения о collation должны
исчезнуть. Проверьте `/health/ready` через используемый адрес приложения.

При сбое сохраняйте резервные копии и остановленное приложение. Восстанавливайте
дамп в отдельную базу/том на проверенном Debian-образе и проверяйте данные перед
переключением. Не удаляйте `db_data` и не используйте `docker compose down -v`.
Возврат на Alpine поверх уже перестроенных индексов снова меняет правила
сортировки и не является безопасным откатом.

## Источники

- [Варианты официального PostgreSQL-образа](https://github.com/docker-library/docs/blob/master/postgres/README.md#image-variants)
- [glibc в Debian Trixie](https://packages.debian.org/trixie/libc6)
- [Версии collation и перестроение зависимых объектов](https://www.postgresql.org/docs/16/sql-altercollation.html)
- [reindexdb](https://www.postgresql.org/docs/16/app-reindexdb.html)
