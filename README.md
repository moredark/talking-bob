# Talking Bob

Telegram bot for practicing spoken English. Send voice messages, get AI-powered feedback.

## Setup

```bash
cp .env.example .env
# Edit .env with your API keys

npm install
npx prisma generate
npx prisma migrate dev
npx prisma db seed
```

## Run

```bash
# Development
npm run build && npm run start

# Docker
docker-compose up --build
```

## Tech Stack

- NestJS + TypeScript
- Grammy (Telegram)
- Prisma + PostgreSQL
- Cloud.ru (Whisper, LLM)
- ElevenLabs (TTS)
