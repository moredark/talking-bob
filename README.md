# Talking Bob

Talking Bob is a Telegram bot for spoken-English practice. It sends a question, accepts voice answers, continues the conversation in English, and returns feedback in Russian.

## Requirements

- Node.js 24.18.0 and npm (`nvm use` reads the pinned `.nvmrc`)
- PostgreSQL 16+
- a Telegram bot token
- a Cloud.ru API key for speech recognition and LLM requests
- Docker with Compose for the container and PostgreSQL integration-test paths

The application requires `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, and `CLOUD_RU_API_KEY`. Copy [`.env.example`](.env.example) to `.env` and replace the placeholder secrets. The Compose path additionally reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` from that file.

## Quick start with Docker Compose

```bash
cp .env.example .env
# Set bot/provider secrets, strong URI-unreserved POSTGRES_* credentials,
# and ADMIN_USERNAME/ADMIN_PASSWORD before the first start.
npm run docker:up
```

The local Compose stack starts PostgreSQL, waits for it to become healthy, applies production migrations, idempotently seeds missing built-in prompts and the configured admin, and then starts the bot and admin UI. The application listens on `127.0.0.1:3001` and the admin UI on `127.0.0.1:8080` by default.

`ADMIN_USERNAME` and `ADMIN_PASSWORD` must both be present in `.env` when the
initialization service runs. If the stack was started before they were set, add
them and run `npm run docker:init`. This reruns only the idempotent seed and
creates a missing admin; it does not apply migrations or change the password of
an existing username. Use `docker:up` or `docker:recreate` for the full lifecycle,
including migrations.

## Quick start with host Node.js

Start a PostgreSQL server first and create the database named by `DATABASE_URL`. One convenient development-only option is the repository's database service:

```bash
cp .env.example .env
# Edit .env and set DATABASE_URL, TELEGRAM_BOT_TOKEN, and CLOUD_RU_API_KEY.
npm run docker -- up -d db
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run build
npm run start
```

If PostgreSQL is already running on the host, omit `npm run docker -- up -d db` and point `DATABASE_URL` at that instance.

## Useful commands

```bash
npm run build          # compile TypeScript
npm test               # build and run the Node.js test suite
npm run test:ci        # tests plus Prisma schema validation
npm run test:smoke     # deterministic /start, /settings, voice and report journey
npm run test:postgres  # critical invariants against an ephemeral PostgreSQL 16 container
npm run test:container # build and inspect the runtime/init images
npm run test:operations # smoke, PostgreSQL recovery/timezone and container gates
npm run deploy:init    # apply production migrations and seed missing data
```

Local Docker commands use `docker-compose.yml` together with
`compose.tailscale.yml`:

```bash
npm run docker:config   # validate the resolved Compose configuration
npm run docker:build    # build local images
npm run docker:up       # build/start the stack and run migrations
npm run docker:recreate # rebuild/recreate the stack and run migrations
npm run docker:ps       # show service status
npm run docker:logs     # follow the latest 200 log lines
npm run docker:init     # rerun the seed and create a missing admin
npm run docker:down     # stop the stack; named volumes are preserved
```

`docker:recreate` briefly interrupts and recreates all containers, while
preserving the database volume. `docker:init` does not apply migrations or
change the password when `ADMIN_USERNAME` already exists.

Pass any Compose subcommand through the base alias when a helper is not enough,
for example `npm run docker -- logs app`.

The PostgreSQL and container gates require a working Docker daemon. They use
uniquely labelled temporary resources and remove only those owned by the run.

## Runtime boundaries

The bot uses the standard Telegram Bot API through grammY. Built-in questions are text-first; a prompt may reference a voice message uploaded to Telegram in advance. There is no runtime text-to-speech provider, dependency, or TTS configuration.

## Documentation

- [Architecture guide and recommended reader order](docs/architecture/README.md)
- [Application behavior and runtime contracts](docs/app.md)
- [Database schema and invariants](docs/database.md)
- [Backend operations and recovery runbook](docs/operations.md)
- [Environment template](.env.example)
- [Deployment plan](docs/DEPLOYMENT_PLAN.md) — a forward-looking production checklist, not a description of the current deployment
