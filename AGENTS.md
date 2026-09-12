# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Source of truth

- Start with [the architecture index](docs/architecture/README.md) for system boundaries and module ownership.
- Treat [the application contract](docs/app.md) as normative for behavior not transferred to OpenSpec; [the database contract](docs/database.md) and `prisma/schema.prisma` remain normative for data and persistence.
- Use [report-delivery](openspec/specs/report-delivery/spec.md) as the normative contract for persisted report delivery, retries, chunking, and unavailable purged reports.
- Use [the SDD workflow](docs/sdd-workflow.md) for OpenSpec changes; existing contracts remain canonical until a capability is deliberately transferred into a maintained specification.

## Project Overview

"Talking Bob" is a Telegram bot for practicing spoken English. The bot sends voice questions, receives user voice responses, and provides text-based analysis of mistakes. Bot responds in Russian.

## Technology Stack

- **Backend**: TypeScript, Node.js, NestJS
- **Telegram**: grammy library
- **Database**: PostgreSQL with Prisma ORM
- **AI Services**: Cloud.ru (Whisper STT, LLM), Yandex TTS behind interfaces
- **Admin**: Vue, TypeScript, Vite

## Commands

```bash
# Setup
# OpenSpec is installed under $HOME/.local/bin; add it to PATH or invoke it by absolute path.
export PATH="$HOME/.local/bin:$PATH"
npm ci
npx prisma generate
npx prisma migrate dev
npm run prisma:seed

# Development
npm run build && npm run start

# Docker (PostgreSQL -> migrations -> idempotent seeds -> app)
docker compose up -d --build

# Prisma commands
npx prisma migrate dev          # Create migration
npx prisma migrate deploy       # Apply migrations (production)
npm run prisma:seed             # Seed missing prompts and optional admin
npm run deploy:init             # Production migrations + seeds
```

## Architecture

### Layer Separation (NestJS Modular)

```text
src/
├── main.ts                          # Config bootstrap and HTTP listener
├── app.module.ts                    # Nest composition root
├── config/                          # Validated runtime config and settings
├── infrastructure/                  # Database and external HTTP
├── shared/time/                     # Timezone helpers
└── modules/
    ├── telegram/                    # Polling, commands, voice, report, settings
    ├── ai/                          # Provider interfaces and implementations
    ├── user/                        # Registration and settings
    ├── prompt/                      # Prompt selection and delivery
    ├── response/                    # Voice processing and report delivery
    ├── conversation/                # Multi-turn conversation state
    ├── schedule/                    # Daily prompt scheduling
    ├── streak/                      # Streak tracking and reminders
    ├── rate-limit/                  # Request admission and quotas
    ├── error-log/                   # Sanitized error persistence
    ├── auth/                        # Admin authentication
    ├── admin/                       # Protected administrative API
    ├── broadcast/                   # Broadcast execution and recipients
    ├── personality/                 # Agent personalities and prompt rules
    └── health/                      # Process, DB, and Telegram readiness
admin/                               # Separate Vue/Vite admin application
prisma/                              # Schema, migrations, and seed
test/                                # Unit/integration-style runtime tests
integration/                         # Real-PostgreSQL integration tests
```

`AppModule` imports `DatabaseModule`, `ErrorLogModule`, `TelegramModule`,
`HealthModule`, `AuthModule`, and `AdminModule`; `forRoot()` adds the configured
`RuntimeConfigModule`. See the architecture index for module dependencies.

### AI Service Pattern

AI services use interfaces and injection tokens (`WHISPER_SERVICE`, `LLM_SERVICE`, `TTS_SERVICE`) allowing implementation swapping:
```typescript
@Inject(WHISPER_SERVICE) private whisper: IWhisperService
```

The current contracts are `IWhisperService`, `ILLMService`, and `ITtsService`; concrete Cloud.ru/Yandex implementations stay inside `AiModule`.

### Database Schema

The Prisma schema is the source of truth. Models are grouped by domain rather than treated as a fixed table count:

- identity and product configuration: `User`, `AgentPersonality`, `AgentPromptRules`;
- prompt and conversation lifecycle: `Prompt`, `UserPrompt`, `ConversationMessage`;
- response delivery and AI observability: `UserResponse`, `ReportDeliveryRequest`, `AiProviderCall`;
- scheduling, quotas, and streaks: `UserRequest`, `QuotaWindow`, `UserActivityDay`, `StreakDay`, `StreakReminder`;
- administration and broadcasts: `AdminUser`, `AdminAuditLog`, `AdminAnalyticsCoverage`, `Broadcast`, `BroadcastRecipient`;
- operational state: `ErrorLog`, `RuntimeSettings`.

Field names are camelCase in Prisma and mapped SQL names are generally snake_case. Preserve the invariants and transitions documented in [docs/database.md](docs/database.md).

### Key Environment Variables

```
TELEGRAM_BOT_TOKEN    # Required
DATABASE_URL          # PostgreSQL connection
CLOUD_RU_API_KEY      # For Whisper STT and LLM
LLM_MODEL             # e.g., Qwen/Qwen3.6-35B-A3B
```

## Development Rules

- Follow specifications in `docs/app.md` and `docs/database.md`
- Do not add features outside MVP scope without explicit instruction
- Do not add new libraries without approval
- Do not change architecture without explicit instruction
- AI logic must be behind interfaces - inject via tokens, not concrete classes
- Minimal logic in Telegram handlers - delegate to services

## GitHub approval (mandatory)

- Obtain explicit user approval before GitHub actions with publicly visible effects, through `gh`, MCP, the API, `git push`, or any other tool. This includes writes to public issues, comments, pull requests (including drafts), repositories, Projects, and releases, as well as making private content public or triggering public publication/deployment.
- Actions confined to verified private GitHub resources may proceed without separate approval when they are within the user's task scope. For example, move a card between statuses, edit project fields or the description on a private board, or update an issue in a private repository.
- Check the visibility and effects of the actual resource being changed. A private board does not make its linked issues or repositories private: changing a public issue from that board still requires approval. If visibility or public effects are uncertain, resolve them before writing; do not assume the action is private.
- Before requesting approval for a public action, prepare it locally and show the target repository/project, exact operation, and content or diff. A clearly described batch may be approved together.
- Read-only inspection and local preparation do not require approval. Installing or authenticating a tool and granting API permissions do not authorize public writes.
- An explicit user instruction to perform a concrete, sufficiently specified public GitHub action counts as approval. Do not ask again within that approved scope; obtain new approval if the target, content, or effects change materially.
- This rule applies equally to subagents, scripts, and automations. Approval for one public action or batch is not blanket authorization for future public changes.
