# Talking Bob: application contract

> Verified against the backend on 2026-08-08, through migration
> `20260808180000_prompt_selection_history`.

Talking Bob is a Telegram bot for practising spoken English. User-facing
commands, status messages, and report feedback are in Russian. Questions and
LLM conversation follow-ups are in English.

The runtime uses Cloud.ru Whisper for speech-to-text and a Cloud.ru-compatible
chat-completions LLM behind injected interfaces. Questions are text-first. A
prompt may contain an existing Telegram `audioFileId`, but the backend has no
TTS provider and no TTS environment contract; generating question audio is a
separate future integration.

## Commands and settings

- `/start` resolves the Telegram user (creating the record when necessary),
  checks that an active prompt exists, consumes a manual-dialog allowance,
  atomically reserves a prompt, sends the welcome message, and dispatches the
  question. The welcome is attempted for every admitted `/start` after a
  prompt reservation, not only when the user is first registered.
- The **New question** callback (`new_question`) follows the same admission,
  reservation, and delivery flow without the welcome message.
- `/report` generates or resends the report for the latest question. At least
  one accepted voice reply is required.
- `/settings` can enable or disable the daily question, choose one of the fixed
  times (`09:00`, `12:00`, `13:00`, `15:00`, `18:00`, `21:00`), and select a
  friendly or playful agent tone. There is currently no Telegram timezone
  picker.

A new user starts with the daily question enabled at `13:00` in
`Europe/Moscow`. The persisted effective timezone is used when displaying and
calculating the schedule.

## Prompt selection and delivery

Manual and scheduled delivery use the same active prompt catalogue and avoid
up to five recent reservations for that user. The exclusion window is capped
at active-catalogue-size minus one, so a small catalogue always has a
deterministic fallback. Selection and creation of the `pending` `UserPrompt`
reservation are one database transaction, so concurrent workers cannot reserve
the same occurrence twice.

The delivered question is `Prompt.topic`. `difficulty`, `tags`, `textContent`,
and `sortOrder` are catalogue metadata; they are not substituted for the
question at runtime.

If a prompt has a pre-uploaded Telegram voice, the bot tries `sendVoice` first.
It falls back to the text question only after Telegram definitely rejects that
voice. Without an `audioFileId`, it sends text directly. A definite Telegram
API rejection records the delivery as `failed`. A transport or unknown error
has an ambiguous outcome and leaves it `pending`; the application does not
automatically resend an attempt whose remote outcome is unknown.

An unavailable or empty catalogue is reported before a manual quota claim, or
releases that claim if the catalogue becomes empty during reservation. Once a
reservation is persisted, a later Telegram delivery failure does not restore
the manual-dialog allowance. Scheduled deliveries do not consume that
allowance.

## Voice conversation and reports

Only the latest successfully sent (`deliveryStatus = sent`) `UserPrompt` can
accept voice messages. A voice message is limited to 300 seconds and 20 MiB by
default and cannot be configured above those limits. The bot downloads the
Telegram file with bounded time/size, transcribes it as English, then persists
the user message. `telegramUpdateId` is unique, so a duplicate Telegram update
is ignored rather than processed twice.

For accepted user turns one and two, the LLM receives the persisted history
and generates an English follow-up. The assistant message is inserted only if
the conversation is still open and the corresponding user message is still
the latest accepted turn. The third accepted user turn atomically closes the
conversation and claims automatic report generation.

`/report` may close and report a conversation after its first accepted voice
message; with no accepted user messages it is rejected. Report generation is
claimed in the database. A generated report is persisted and never regenerated
on later `/report` commands: later commands create an idempotent delivery
request and resend the saved result. A failed generation can be reclaimed only
by a new request key. Expired leases are reclaimable, while concurrent active
work returns a busy response.

Reports are formatted as literal plain text and split into Telegram-safe
chunks of at most 4096 UTF-16 code units. Only the final chunk carries the
**New question** keyboard. Definite delivery rejection marks that delivery
request failed; an ambiguous delivery remains pending and requires a new
`/report` command to attempt delivery of the same persisted report.

## Time and scheduling contract

- A user's effective timezone is a canonical IANA name. Aliases are normalized;
  blank or invalid legacy values fall back to `Europe/Moscow`.
- Business moments are UTC instants stored as PostgreSQL `timestamptz(3)`.
  `scheduledLocalDate` separately stores the effective local calendar date.
  Correctness does not depend on the Node process or database-session `TZ`, so
  there is no required `TZ` environment variable.
- A due occurrence includes the exact target minute. In a DST spring gap, the
  occurrence moves to the first valid local minute. In an autumn overlap, the
  earlier (first) occurrence is selected.
- The minute scheduler repairs legacy schedule state without delivering during
  startup normalization. After downtime it claims only the latest overdue
  occurrence, then advances `nextPromptAt` strictly beyond the current time;
  it does not replay every missed day.
- A scheduled occurrence has the immutable identity
  `scheduled:<userId>:YYYY-MM-DD`, plus immutable local-date and instant
  snapshots after claim. Database row locks, `SKIP LOCKED`, and uniqueness of
  that identity make concurrent workers safe.
- Enabling or changing a schedule recalculates only a future, unclaimed
  occurrence. Already claimed occurrences keep their original identity and
  snapshots.

## Quotas

Quotas are persisted in PostgreSQL and serialized per user/action window:

| Action | Limit | Window | Used by |
| --- | ---: | --- | --- |
| `voice_response` | 10 | rolling 60 minutes | Voice processing admission |
| `command` | 30 | rolling 60 minutes | `/report` |
| `dialog_start` | 20 | effective local calendar day | `/start` and **New question** after a prompt catalogue preflight |

The local-day window is persisted with its timezone snapshot. Changing a
timezone while that window is active does not create a second allowance. An
active window can span a 25-hour DST day and remains protected from retention
cleanup until it expires.

## Runtime and failure behavior

Startup parses all bot runtime configuration before creating the Nest
application. Missing required values, malformed URLs, and numeric values
outside their documented ranges fail startup with a consolidated error.

Telegram updates run through the official `@grammyjs/runner`. Global update
concurrency is bounded, updates for the same chat remain FIFO, and AI requests
use a separate bounded active/pending limiter. External Telegram-download,
Whisper, and LLM HTTP responses have independent timeout and byte bounds.
Telegram Bot API calls use grammY's standard API client and its configured
request timeout.

On `SIGINT` or `SIGTERM`, polling stops accepting updates and the application
waits up to `RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS` for Telegram business work,
callback acknowledgements, and AI work before closing. Operational failures
are stored as sanitized structured error records with correlation identifiers;
secrets, raw voice bytes, transcripts, prompts, and LLM output are not written
to those records.

`GET /health/live` is a process-only liveness probe. `GET /health/ready` also
requires a working database query and Telegram lifecycle state `running`; it
returns a sanitized `503` while Telegram starts, waits to restart, or shuts
down. Neither endpoint calls Whisper or the LLM. Both responses disable
caching. The runtime image healthcheck uses readiness.

## Privacy and retention

The retention job runs daily at `03:30` according to the runtime clock. Its day
settings are absolute 24-hour periods, not local calendar days. For old closed
conversations it deletes report-delivery request rows together with their
chunks and deletes conversation messages, nulls voice-file identifiers,
transcripts, and analysis, and sets
`sensitiveDataPurgedAt` while preserving conversation lifecycle and
prompt-delivery provenance.
`/report` gives an explicit message when saved report content has been purged.

Expired request-audit rows, orphaned expired quota windows, and sanitized error
logs have independent retention periods. Active quota windows are not removed.

## Environment contract

The example values live in [`.env.example`](../.env.example). Numeric values
must parse to safe integers in the inclusive ranges below.

| Variable | Requirement/default | Consumer and format | Secret |
| --- | --- | --- | --- |
| `DATABASE_URL` | required | Prisma; `postgres:` or `postgresql:` URL | yes |
| `TELEGRAM_BOT_TOKEN` | required | grammY bot token | yes |
| `CLOUD_RU_API_KEY` | required | Whisper and LLM bearer credential | yes |
| `PORT` | `3000`; 1..65535 | Nest HTTP listener | no |
| `LLM_API_URL` | `https://foundation-models.api.cloud.ru/v1/chat/completions` | LLM; HTTP(S) URL | no |
| `LLM_MODEL` | `zai-org/GLM-4.7` | Cloud.ru model identifier | no |
| `TELEGRAM_UPDATE_CONCURRENCY` | `4`; 1..100 | Telegram update runner | no |
| `TELEGRAM_API_TIMEOUT_MS` | `40000`; 5000..120000 | grammY API timeout, ms | no |
| `AI_REQUEST_CONCURRENCY` | `2`; 1..50 | AI request limiter | no |
| `AI_REQUEST_MAX_PENDING` | `8`; 0..1000 | AI pending queue bound | no |
| `RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS` | `30000`; 100..600000 | graceful-drain deadline, ms | no |
| `LLM_ANALYSIS_MAX_TOKENS` | `2500`; 64..32000 | report LLM output bound | no |
| `LLM_FOLLOWUP_MAX_TOKENS` | `1200`; 64..32000 | follow-up LLM output bound | no |
| `VOICE_MAX_DURATION_SECONDS` | `300`; 1..300 | accepted Telegram voice duration | no |
| `VOICE_MAX_FILE_SIZE_BYTES` | `20971520`; 1..20971520 | accepted/downloaded voice size | no |
| `TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS` | `30000`; 100..30000 | Telegram file HTTP bound | no |
| `TELEGRAM_FILE_DOWNLOAD_MAX_RESPONSE_BYTES` | `20971520`; 1..20971520 | Telegram file HTTP bound | no |
| `WHISPER_REQUEST_TIMEOUT_MS` | `120000`; 100..120000 | Whisper HTTP bound | no |
| `WHISPER_REQUEST_MAX_RESPONSE_BYTES` | `1048576`; 1..1048576 | Whisper response HTTP bound | no |
| `LLM_REQUEST_TIMEOUT_MS` | `90000`; 100..90000 | LLM HTTP bound | no |
| `LLM_REQUEST_MAX_RESPONSE_BYTES` | `1048576`; 1..1048576 | LLM response HTTP bound | no |
| `RETENTION_CLOSED_CONVERSATION_CONTENT_DAYS` | `30`; 1..3650 | closed-conversation content retention | no |
| `RETENTION_RATE_LIMIT_DAYS` | `30`; 1..3650 | request/quota audit retention | no |
| `RETENTION_ERROR_LOGS_DAYS` | `30`; 1..3650 | structured error-log retention | no |
| `POSTGRES_USER` | required by Compose; example `bob` | URI-unreserved PostgreSQL username | no |
| `POSTGRES_PASSWORD` | required by Compose; example `bob` | URI-unreserved PostgreSQL password | yes |
| `POSTGRES_DB` | required by Compose; example `talkingbob` | URI-unreserved PostgreSQL database name | no |
| `TALKING_BOB_RUNTIME_IMAGE` | required by production Compose | runtime image repository, without digest | no |
| `TALKING_BOB_RUNTIME_DIGEST` | required by production Compose | runtime image `sha256:` digest | no |
| `TALKING_BOB_INIT_IMAGE` | required by production Compose | init image repository, without digest | no |
| `TALKING_BOB_INIT_DIGEST` | required by production Compose | init image `sha256:` digest | no |
| `JWT_SECRET` | source has an unsafe development fallback | Existing HTTP auth signing secret; non-empty string | yes |
| `ADMIN_CORS_ORIGIN` | `http://localhost:5173` | Existing HTTP CORS origin | no |
| `ADMIN_USERNAME` | optional, only as a pair with password | Seed command; non-empty string | no |
| `ADMIN_PASSWORD` | optional, only as a pair with username | Seed command; non-empty string | yes |

The three `POSTGRES_*` values configure the Compose PostgreSQL service, not the
bot process. Every production deployment must set an explicit strong
`JWT_SECRET`; its source fallback is not production-safe. The optional seed
pair is consumed only by `npm run prisma:seed` / `npm run deploy:init`.

## Related documentation

- [Architecture guide](architecture/README.md)
- [Database contract](database.md)
- [Backend operations and recovery](operations.md)
- [Deployment plan](DEPLOYMENT_PLAN.md) — a forward-looking checklist, not a
  statement of current runtime behavior
