# Приватный доступ к admin через Tailscale

Admin запускается в Docker за nginx и публикуется только на loopback-интерфейсе
сервера. Tailscale Serve добавляет приватный HTTPS-адрес внутри tailnet:

```text
Tailscale Serve -> 127.0.0.1:8080 -> admin nginx
                                      |-- /*      -> React SPA
                                      `-- /api/*  -> app:3000/*
```

Tailscale устанавливается на Linux-хост, а не в Compose. Auth key и состояние
Tailscale не должны храниться в репозитории или контейнерах приложения.

## 1. Запустить приложение и admin

Для локально собираемого Compose используйте дополнительный файл:

```bash
npm run docker:up
curl --fail http://127.0.0.1:${ADMIN_PORT:-8080}/healthz
curl --fail http://127.0.0.1:${ADMIN_PORT:-8080}/api/health/live
```

Команда использует `docker-compose.yml` вместе с `compose.tailscale.yml`.
Перед первым запуском задайте одновременно `ADMIN_USERNAME` и
`ADMIN_PASSWORD` в `.env`. Если стек уже запускался без них, добавьте значения
и выполните `npm run docker:init`. Команда повторно запускает только
идемпотентный seed и создает отсутствующего администратора; она не применяет
миграции и не меняет пароль уже существующего `ADMIN_USERNAME`.

Для повседневной работы доступны `npm run docker:ps`, `npm run docker:logs`,
`npm run docker:recreate` и `npm run docker:down`. Произвольную Compose-команду
можно передать через базовый alias, например `npm run docker -- logs app`.
Команды `docker:up` и `docker:recreate` выполняют полный цикл, включая миграции.
`docker:recreate` кратковременно прерывает работу и пересоздает все контейнеры,
но сохраняет volume базы данных.

Порт должен слушать только на `127.0.0.1`, что можно проверить командой
`ss -ltn`. Не меняйте binding на `0.0.0.0`.

Для production заранее опубликуйте admin-образ из `admin/Dockerfile`, задайте
immutable reference в серверном `.env` и подключите production overlay:

```dotenv
TALKING_BOB_ADMIN_IMAGE=registry.example/talking-bob-admin
TALKING_BOB_ADMIN_DIGEST=sha256:...
ADMIN_PORT=8080
```

```bash
docker compose \
  -f compose.production.yml \
  -f compose.tailscale.production.yml \
  up -d
```

## 2. Установить и подключить Tailscale

Используйте официальную инструкцию для вашего Linux-дистрибутива:
<https://tailscale.com/docs/install/linux>.

Официальный универсальный установщик и интерактивное подключение выглядят так:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

`tailscale up` покажет URL для входа. Откройте его и добавьте сервер в нужный
tailnet. Не помещайте reusable auth key в shell history или `.env` проекта.

## 3. Включить приватный HTTPS-доступ

```bash
sudo tailscale serve --bg http://127.0.0.1:${ADMIN_PORT:-8080}
tailscale serve status
```

При первом запуске Tailscale может попросить включить HTTPS для tailnet. Команда
покажет адрес вида `https://server-name.tailnet-name.ts.net`. Он доступен только
устройствам и пользователям, которым разрешен доступ в политике tailnet.

Это именно Tailscale Serve. Не используйте Tailscale Funnel: Funnel сделал бы
админку публично доступной из интернета.

## 4. Проверить доступ

На другом устройстве, подключенном к тому же tailnet:

```bash
curl --fail https://server-name.tailnet-name.ts.net/healthz
curl --fail https://server-name.tailnet-name.ts.net/api/health/live
```

Затем откройте HTTPS-адрес в браузере, войдите в admin и проверьте прямой переход
на `/users` или `/prompts`. Такой переход также проверяет SPA fallback nginx.

Для постоянно работающего сервера проверьте срок действия ключа машины в
Tailscale Admin Console и настройте tailnet policy так, чтобы доступ имели только
нужные администраторы.

## Отключение и диагностика

```bash
tailscale status
tailscale serve status
sudo tailscale serve reset
```

`tailscale serve reset` удаляет конфигурацию Serve с этого узла. После этого
локальный admin остается на `127.0.0.1`, но его tailnet HTTPS-адрес перестает
работать.

Официальная документация Serve:
<https://tailscale.com/docs/reference/tailscale-cli/serve>.
