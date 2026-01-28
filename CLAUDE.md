# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

"Talking Bob" is a Telegram bot for practicing spoken English. The bot sends voice questions, receives user voice responses, and provides text-based analysis of mistakes. Bot responds in Russian.

## Technology Stack

- **Backend**: TypeScript, Node.js, NestJS
- **Telegram**: grammy library
- **Database**: PostgreSQL with Prisma ORM
- **AI Services**: Cloud.ru (Whisper STT, LLM), ElevenLabs (TTS) - all behind interfaces

## Commands

```bash
# Setup
npm install
npx prisma generate
npx prisma migrate dev
npx prisma db seed

# Development
npm run build && npm run start

# Docker (includes PostgreSQL)
docker-compose up --build

# Prisma commands
npx prisma migrate dev          # Create migration
npx prisma migrate deploy       # Apply migrations (production)
npx prisma db seed              # Seed prompts
```

## Architecture

### Layer Separation (NestJS Modular)

```
src/
├── main.ts                          # Bootstrap
├── app.module.ts                    # Root module (imports Database + Telegram modules only)
├── infrastructure/database/         # PrismaService, DatabaseModule
└── modules/
    ├── telegram/                    # Bot setup, command/voice handlers
    │   ├── telegram.service.ts      # Bot initialization, handler registration
    │   └── handlers/                # start, voice, report, settings handlers
    ├── ai/                          # Interface-based AI services
    │   ├── interfaces/              # IWhisperService, ILLMService, ITTSService
    │   └── services/                # Cloud.ru & ElevenLabs implementations
    ├── user/                        # User registration, settings management
    ├── prompt/                      # Voice question management
    ├── response/                    # Voice response processing pipeline
    ├── conversation/                # Multi-turn conversation state
    ├── schedule/                    # Daily prompt scheduling (cron-based)
    └── rate-limit/                  # Database-based request limiting
```

### AI Service Pattern

AI services use injection tokens (`WHISPER_SERVICE`, `LLM_SERVICE`, `TTS_SERVICE`) allowing implementation swapping:
```typescript
@Inject(WHISPER_SERVICE) private whisper: IWhisperService
```

### Database Schema

Six tables (see `prisma/schema.prisma`):
- `users` - Telegram users with daily prompt settings and timezone
- `prompts` - Voice questions with audio file IDs
- `user_prompts` - Tracks which prompts were sent to which users
- `conversation_messages` - Multi-turn conversation history per user_prompt
- `user_responses` - User voice responses with transcription/analysis
- `user_requests` - Rate limiting records

**Conventions**: Table names in snake_case (`@@map`), field names in camelCase.

### Key Environment Variables

```
TELEGRAM_BOT_TOKEN    # Required
DATABASE_URL          # PostgreSQL connection
CLOUD_RU_API_KEY      # For Whisper STT and LLM
ELEVENLABS_API_KEY    # For TTS (optional)
LLM_MODEL             # e.g., Qwen/Qwen3-235B-A22B-Instruct-2507
```

## Development Rules

- Follow specifications in `docs/app.md` and `docs/database.md`
- Do not add features outside MVP scope without explicit instruction
- Do not add new libraries without approval
- Do not change architecture without explicit instruction
- AI logic must be behind interfaces - inject via tokens, not concrete classes
- Minimal logic in Telegram handlers - delegate to services
