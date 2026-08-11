import { PipeTransform, UnprocessableEntityException } from "@nestjs/common";
import { Temporal } from "@js-temporal/polyfill";
import {
  BROADCAST_ACTIVITIES,
  BROADCAST_LIMITS,
  BROADCAST_RECIPIENT_STATUSES,
  BROADCAST_STATUSES,
  BroadcastDetailQuery,
  BroadcastFilters,
  BroadcastInputDto,
  BroadcastListQuery,
} from "../broadcast";
import { ADMIN_LANGUAGE_LEVELS } from "./admin.contracts";

const LOCAL_MOSCOW_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function invalid(message: string): never {
  throw new UnprocessableEntityException(message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("Body contains unknown fields");
}

function integer(value: unknown, fallback: number, name: string, max: number): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) invalid(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) invalid(`${name} is out of range`);
  return result;
}

function utc(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !UTC_INSTANT_PATTERN.test(value)) invalid(`${name} must be an ISO 8601 UTC instant`);
  try {
    return new Date(Number(Temporal.Instant.from(value).epochMilliseconds));
  } catch {
    invalid(`${name} must be an ISO 8601 UTC instant`);
  }
}

function filters(value: unknown): BroadcastFilters {
  const input = object(value, "filters");
  exactKeys(input, ["languageLevels", "activity", "dailyPromptEnabled"]);
  const languageLevels = input.languageLevels ?? [];
  if (!Array.isArray(languageLevels)
    || languageLevels.length > ADMIN_LANGUAGE_LEVELS.length
    || languageLevels.some((level) => typeof level !== "string" || !ADMIN_LANGUAGE_LEVELS.includes(level as never))
    || new Set(languageLevels).size !== languageLevels.length) {
    invalid("filters.languageLevels is invalid");
  }
  const activity = input.activity ?? "any";
  if (typeof activity !== "string" || !BROADCAST_ACTIVITIES.includes(activity as never)) invalid("filters.activity is invalid");
  const dailyPromptEnabled = input.dailyPromptEnabled ?? "any";
  if (dailyPromptEnabled !== "any" && typeof dailyPromptEnabled !== "boolean") invalid("filters.dailyPromptEnabled is invalid");
  return {
    languageLevels: [...languageLevels] as string[],
    activity: activity as BroadcastFilters["activity"],
    dailyPromptEnabled: dailyPromptEnabled as BroadcastFilters["dailyPromptEnabled"],
  };
}

export class AdminBroadcastInputPipe implements PipeTransform<unknown, BroadcastInputDto> {
  constructor(private readonly now: () => Date = () => new Date()) {}

  transform(value: unknown): BroadcastInputDto {
    const input = object(value, "Body");
    exactKeys(input, ["content", "filters", "mode", "scheduledFor"]);
    if (typeof input.content !== "string") invalid("content must be a string");
    const content = input.content.trim();
    if (content.length < 1 || content.length > BROADCAST_LIMITS.contentUtf16) {
      invalid(`content must contain 1 to ${BROADCAST_LIMITS.contentUtf16} UTF-16 code units`);
    }
    if (input.mode !== "immediate" && input.mode !== "scheduled") invalid("mode is invalid");
    const now = this.now();
    if (input.mode === "immediate") {
      if (input.scheduledFor !== undefined && input.scheduledFor !== null) invalid("scheduledFor is forbidden for immediate mode");
      return { content, filters: filters(input.filters), mode: "immediate", scheduledFor: null, scheduledAt: now };
    }
    if (typeof input.scheduledFor !== "string" || !LOCAL_MOSCOW_PATTERN.test(input.scheduledFor)) {
      invalid("scheduledFor must be Moscow wall time YYYY-MM-DDTHH:mm");
    }
    let scheduledAt: Date;
    try {
      const plain = Temporal.PlainDateTime.from(`${input.scheduledFor}:00`);
      scheduledAt = new Date(plain.toZonedDateTime("Europe/Moscow").toInstant().epochMilliseconds);
    } catch {
      invalid("scheduledFor is invalid");
    }
    if (scheduledAt!.getTime() <= now.getTime()) invalid("scheduledFor must be in the future");
    return { content, filters: filters(input.filters), mode: "scheduled", scheduledFor: input.scheduledFor, scheduledAt: scheduledAt! };
  }
}

export class AdminBroadcastListQueryPipe implements PipeTransform<unknown, BroadcastListQuery> {
  transform(value: unknown): BroadcastListQuery {
    const query = object(value, "Query");
    exactKeys(query, ["page", "limit", "status", "from", "to"]);
    if (query.status !== undefined && (typeof query.status !== "string" || !BROADCAST_STATUSES.includes(query.status as never))) invalid("status is invalid");
    const from = utc(query.from, "from");
    const to = utc(query.to, "to");
    if (from && to && from >= to) invalid("from must be before to");
    return { page: integer(query.page, 1, "page", 1_000_000), limit: integer(query.limit, 20, "limit", 100), status: query.status as BroadcastListQuery["status"], from, to };
  }
}

export class AdminBroadcastDetailQueryPipe implements PipeTransform<unknown, BroadcastDetailQuery> {
  transform(value: unknown): BroadcastDetailQuery {
    const query = object(value, "Query");
    exactKeys(query, ["recipientPage", "recipientLimit", "recipientStatus"]);
    if (query.recipientStatus !== undefined && (typeof query.recipientStatus !== "string" || !BROADCAST_RECIPIENT_STATUSES.includes(query.recipientStatus as never))) invalid("recipientStatus is invalid");
    return {
      recipientPage: integer(query.recipientPage, 1, "recipientPage", 1_000_000),
      recipientLimit: integer(query.recipientLimit, 50, "recipientLimit", 100),
      recipientStatus: query.recipientStatus as BroadcastDetailQuery["recipientStatus"],
    };
  }
}
