# Application Overview

## Telegram Bot "Talking Bob"

---

## 1. Product Description

“Talking Bob” is a Telegram bot for practicing spoken English.

The bot periodically sends voice messages with questions or conversation topics.
The user responds with a voice message.
The bot analyzes the response and returns a textual breakdown of mistakes.
Bot text and answers in Russian.

At the current stage, an **MVP** with basic functionality is being developed.

---

## 2. MVP Goal

- Validate the hypothesis of regular voice practice
- Implement the full cycle:
  - question → answer → analysis
- Create an architectural foundation for future scaling

---

## 3. Target Audience

- Private Telegram users
- English language learners
- Individual usage (1 user = 1 chat)

---

## 4. MVP Scope

### Included in MVP

- User registration on `/start`
- Sending a voice question from the bot
- Receiving a voice response from the user
- Simplified transcription (stub)
- Text analysis of the response (stub)
- Storing question and answer history
- Backend-level rate limiting

### Not Included in MVP

- Subscriptions and payments
- Flexible scheduling settings
- Admin panel
- Web interfaces
- Real AI integration
- Multilingual support

⚠️ **Adding features outside the MVP is strictly forbidden without explicit instruction**

---

## 5. Technology Stack

### Backend

- TypeScript
- Node.js
- NestJS

### Telegram

- grammy

### Database

- PostgreSQL
- Prisma ORM

### AI

- Interface-based abstraction
- Mock implementation

---

## 6. Architectural Principles

- Modular NestJS architecture
- Clear separation of layers:
  - Telegram handlers
  - Application services
  - Infrastructure (DB, external services)
- Minimal coupling between modules
- Ability to replace AI provider without changing business logic

---

## 7. Core Flows

### 7.1 User Registration

1. User sends `/start`
2. Backend checks the user in the database
3. If the user is new — creates a record
4. Bot sends a welcome message

---

### 7.2 Sending a Voice Question

1. Bot selects a topic from the list
2. Sends a voice message
3. Records the send event in the database

---

### 7.3 User Response

1. User sends a voice message
2. Backend saves the `file_id`
3. Runs transcription (mock)
4. Passes text to analysis (mock)
5. Sends textual feedback to the user

---

## 8. AI Handling (MVP)

- AI is implemented via an interface
- Default implementation is a mock
- All AI logic is encapsulated in a separate module
- No direct dependency on external APIs

---

## 9. Rate Limiting

- Limits the number of user actions
- Implemented via the database
- Limits are configurable
- Applied to:
  - voice messages
  - commands

---

## 10. Code Quality

- Strict TypeScript typing
- Explicit interfaces
- Minimal logic in Telegram handlers
- Logging of key actions
- Code must be easily extensible

---

## 11. Development Rules

- Follow the description in `app.md`
- Follow the schema in `database.md`
- Do not add new libraries
- Do not change architecture without explicit instruction
- If information is missing — ask a question

---

## 12. Work Format

Development is iterative:

1. Architecture
2. Database schema
3. Base modules
4. Telegram flow
5. Rate limiting

❗ **Do not implement the entire project in a single step**
