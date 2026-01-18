# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

"Talking Bob" is a Telegram bot for practicing spoken English. The bot sends voice questions, receives user voice responses, and provides text-based analysis of mistakes. Bot responds in Russian.

**Current stage: MVP development**

## Technology Stack

- **Backend**: TypeScript, Node.js, NestJS
- **Telegram**: grammy library
- **Database**: PostgreSQL with Prisma ORM
- **AI**: Interface-based abstraction with mock implementation (no real AI in MVP)

## Commands

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate dev

# Start development server
npm run start:dev

# Build for production
npm run build

# Start production server
npm run start:prod

# Run linting
npm run lint

# Run tests
npm run test

# Run single test file
npm run test -- <path-to-test-file>
```

## Architecture

### Layer Separation (NestJS Modular)

1. **Telegram Handlers** - Minimal logic, delegate to services
2. **Application Services** - Business logic
3. **Infrastructure** - Database (Prisma), external services

### Core Modules

- **User Module** - Registration, user management
- **Prompt Module** - Voice questions management
- **Response Module** - Handle user voice responses, transcription, analysis
- **AI Module** - Interface-based with mock implementation, encapsulated separately
- **Rate Limiting** - Database-based action limiting

### Database Schema

Five main tables (see `docs/database.md` for full schema):
- `users` - Telegram users (UUID primary keys, telegramId bigint unique)
- `prompts` - Voice questions sent by bot
- `user_prompts` - Tracks prompt → user send events
- `user_responses` - User voice responses with transcription/analysis
- `user_requests` - Rate limiting records

**Conventions**: Table names in snake_case, field names in camelCase (Prisma style).

### Core Flows

1. **Registration**: `/start` → check user in DB → create if new → welcome message
2. **Voice Question**: Select topic → send voice message → record in DB
3. **User Response**: Receive voice → save file_id → transcribe (mock) → analyze (mock) → send feedback

## Development Rules

- Follow specifications in `docs/app.md` and `docs/database.md`
- Do not add features outside MVP scope without explicit instruction
- Do not add new libraries without approval
- Do not change architecture without explicit instruction
- AI logic must be behind interfaces - no direct external API dependencies
- Minimal logic in Telegram handlers
- If information is missing - ask for clarification
- Development is iterative: Architecture → Database → Base modules → Telegram flow → Rate limiting
