# Talking Bob

Telegram bot for practicing spoken English. Send voice messages, get AI-powered feedback.

## Setup

```bash
cp .env.example .env
# Edit .env with your API keys

npm ci
npx prisma generate
npx prisma migrate dev
npm run prisma:seed
```

## Run

```bash
# Development
npm run build && npm run start

# Docker: waits for PostgreSQL, applies migrations and runs idempotent seeds
docker compose up -d --build
```

The Compose `init` service runs migrations and seeds before the application
starts. Built-in prompts are inserted only when their exact topic is missing,
so the init step can be rerun safely. `audioFileId` is optional; prompts without
audio are sent as text.

The admin frontend uses the same-origin `/api` path in every environment. Vite
proxies it to the backend during development; a production reverse proxy should
strip the `/api` prefix before forwarding requests to NestJS.

## Tech Stack

- NestJS + TypeScript
- Grammy (Telegram)
- Prisma + PostgreSQL
- Cloud.ru (Whisper STT, LLM)

Built-in questions currently use text delivery. A prompt may still reference a
pre-uploaded Telegram voice through optional `audioFileId`; runtime TTS
generation is not implemented.
