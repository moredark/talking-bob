# Database Schema (MVP)

## Telegram Bot "Talking Bob"

You are a senior backend developer.
Your task is to implement the database for the MVP of a Telegram bot
for practicing spoken English.

Technologies used:

- PostgreSQL
- Prisma ORM
- Backend: NestJS
- Language: TypeScript

---

## General Requirements

- Use UUID as primary keys
- Store only Telegram `file_id`; do not store audio files
- Schema must be extensible (subscriptions, settings, AI)
- All tables must have `createdAt`
- Table names — snake_case
- Field names — camelCase (Prisma style)
- Relations must be explicitly defined

---

## Tables

### 1. users

Stores Telegram users.

Fields:

- `id`: UUID, primary key
- `telegramId`: bigint, unique
- `username`: string, nullable
- `createdAt`: timestamp
- `updatedAt`: timestamp

Purpose:

- user identification
- base entity for all relations

---

### 2. prompts

Voice questions sent by the bot to users.

Fields:

- `id`: UUID, primary key
- `topic`: string
- `audioFileId`: string (Telegram file_id)
- `isActive`: boolean
- `createdAt`: timestamp

Purpose:

- storing topics and bot voice messages
- ability to disable prompts without deleting them

---

### 3. user_prompts

Tracks the fact that a specific prompt was sent to a specific user.

Fields:

- `id`: UUID, primary key
- `userId`: UUID, FK → users.id
- `promptId`: UUID, FK → prompts.id
- `sentAt`: timestamp

Purpose:

- analytics
- linking prompt → response
- prompt reuse

---

### 4. user_responses

User responses to voice prompts.

Fields:

- `id`: UUID, primary key
- `userId`: UUID, FK → users.id
- `userPromptId`: UUID, FK → user_prompts.id
- `voiceFileId`: string (Telegram file_id)
- `transcript`: string, nullable
- `analysis`: string, nullable
- `createdAt`: timestamp

Purpose:

- storing user responses
- storing transcription and analysis
- foundation for dialogue history

---

### 5. user_requests

Used for database-based rate limiting.

Fields:

- `id`: UUID, primary key
- `userId`: UUID, FK → users.id
- `action`: string
- `createdAt`: timestamp

Purpose:

- limiting the number of user actions
- supporting different action types (voice, command, etc.)

---

## Relationships (ER)

- User → many UserPrompts
- UserPrompt → one Prompt
- UserPrompt → zero or one UserResponse
- User → many UserResponses
- User → many UserRequests

---

## Required Indexes

- users.telegramId (unique)
- user_prompts.userId
- user_responses.userId
- user_requests.userId + createdAt

---

## Prisma Requirements

- Use `@id @default(uuid())`
- Use `@map` for snake_case table names
- Enable `relationMode = "prisma"`
- Prepare schema for migrations

---

## Important

- Do not add fields or tables outside the MVP
- Do not implement subscriptions or settings
- If unsure — ask for clarification
- Code must be clean and easily extensible
