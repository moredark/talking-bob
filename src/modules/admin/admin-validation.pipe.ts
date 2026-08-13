import { PipeTransform, UnprocessableEntityException } from "@nestjs/common";
import { normalizeRuntimeOverride, registryEntry, validateRuntimeOverride } from "../../config/runtime-settings.registry";
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_ENTITY_TYPES,
  ADMIN_CONVERSATION_STATUSES,
  ADMIN_GENERATION_STATUSES,
  ADMIN_SESSION_DELIVERY_STATUSES,
  ADMIN_SESSION_SOURCES,
  ADMIN_AUDIT_OUTCOMES,
  ADMIN_DIFFICULTIES,
  ADMIN_ERROR_SERVICES,
  ADMIN_ERROR_TYPES,
  ADMIN_LANGUAGE_LEVELS,
  ADMIN_PROMPT_TAGS,
  ADMIN_USER_STATUSES,
  AdminSessionsQuery,
  AnalyticsDays,
  AdminAuditLogsQuery,
  CreatePromptDto,
  ErrorLogsQuery,
  PaginationQuery,
  UpdatePromptDto,
  UpdateRuntimeSettingsDto,
  UpdateUserDto,
} from "./admin.contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const PROMPT_KEYS = new Set(["topic", "textContent", "audioFileId", "difficulty", "tags", "isActive", "sortOrder"]);
const USER_KEYS = new Set(["dailyPromptEnabled", "languageLevel", "status", "bannedReason"]);

function invalid(message: string): never {
  throw new UnprocessableEntityException(message);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("Body must be an object");
  return value as Record<string, unknown>;
}

function rejectUnknown(body: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(body).some((key) => !allowed.has(key))) invalid("Body contains unknown fields");
}

function integerQuery(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) invalid(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) invalid(`${name} is out of range`);
  return parsed;
}

function optionalString(body: Record<string, unknown>, key: string, max: number, nullable = false): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (nullable && value === null) return null;
  if (typeof value !== "string") invalid(`${key} must be a string${nullable ? " or null" : ""}`);
  const normalized = (value as string).trim();
  if (normalized.length > max) invalid(`${key} is too long`);
  return normalized;
}

export class AdminUuidPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid("id must be a UUID");
    return value as string;
  }
}

export class AdminPaginationPipe implements PipeTransform<unknown, PaginationQuery> {
  constructor(private readonly defaultLimit: number) {}
  transform(value: unknown): PaginationQuery {
    const query = objectBody(value);
    rejectUnknown(query, new Set(["page", "limit"]));
    return {
      page: integerQuery(query.page, 1, "page", 1, 1_000_000),
      limit: integerQuery(query.limit, this.defaultLimit, "limit", 1, 100),
    };
  }
}

export class AdminErrorLogsQueryPipe implements PipeTransform<unknown, ErrorLogsQuery> {
  transform(value: unknown): ErrorLogsQuery {
    const query = objectBody(value);
    rejectUnknown(query, new Set(["page", "limit", "type", "service", "correlationId"]));
    const pagination = {
      page: integerQuery(query.page, 1, "page", 1, 1_000_000),
      limit: integerQuery(query.limit, 50, "limit", 1, 100),
    };
    const type = query.type;
    const service = query.service;
    if (type !== undefined && (typeof type !== "string" || !ADMIN_ERROR_TYPES.includes(type as never))) invalid("type is invalid");
    if (service !== undefined && (typeof service !== "string" || !ADMIN_ERROR_SERVICES.includes(service as never))) invalid("service is invalid");
    let correlationId: string | undefined;
    if (query.correlationId !== undefined) {
      if (typeof query.correlationId !== "string") invalid("correlationId must be a string");
      correlationId = (query.correlationId as string).trim();
      if (!CORRELATION_PATTERN.test(correlationId)) invalid("correlationId is invalid");
    }
    return { ...pagination, type: type as ErrorLogsQuery["type"], service: service as ErrorLogsQuery["service"], correlationId };
  }
}

export class AdminAnalyticsQueryPipe implements PipeTransform<unknown, AnalyticsDays> {
  transform(value: unknown): AnalyticsDays {
    const query = objectBody(value);
    rejectUnknown(query, new Set(["days"]));
    if (typeof query.days !== "string" || !["7", "30", "90"].includes(query.days)) {
      invalid("days must be one of 7, 30, or 90");
    }
    return Number(query.days) as AnalyticsDays;
  }
}

export class AdminDaysPipe implements PipeTransform<unknown, number> {
  transform(value: unknown): number {
    return integerQuery(value, 30, "days", 1, 3650);
  }
}

function validatePrompt(value: unknown, patch: boolean): CreatePromptDto | UpdatePromptDto {
  const body = objectBody(value);
  rejectUnknown(body, PROMPT_KEYS);
  if (patch && Object.keys(body).length === 0) invalid("Patch body must not be empty");
  if (!patch && body.topic === undefined) invalid("topic is required");
  const result: Record<string, unknown> = {};
  if (body.topic !== undefined) {
    if (typeof body.topic !== "string") invalid("topic must be a string");
    const topic = body.topic.trim();
    if (topic.length === 0 || topic.length > 200) invalid("topic must contain 1 to 200 characters");
    result.topic = topic;
  }
  const textContent = optionalString(body, "textContent", 10_000);
  if (textContent !== undefined) result.textContent = textContent;
  const audioFileId = optionalString(body, "audioFileId", 512, true);
  if (audioFileId !== undefined) result.audioFileId = audioFileId === "" ? null : audioFileId;
  if (body.difficulty !== undefined) {
    if (typeof body.difficulty !== "string" || !ADMIN_DIFFICULTIES.includes(body.difficulty as never)) invalid("difficulty is invalid");
    result.difficulty = body.difficulty;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 6 || body.tags.some((tag) => typeof tag !== "string" || !ADMIN_PROMPT_TAGS.includes(tag as never)) || new Set(body.tags).size !== body.tags.length) invalid("tags are invalid");
    result.tags = body.tags;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") invalid("isActive must be a boolean");
    result.isActive = body.isActive;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== "number" || !Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 2_147_483_647) invalid("sortOrder must be an integer between 0 and 2147483647");
    result.sortOrder = body.sortOrder;
  }
  return result as unknown as CreatePromptDto | UpdatePromptDto;
}

export class AdminCreatePromptPipe implements PipeTransform<unknown, CreatePromptDto> {
  transform(value: unknown): CreatePromptDto { return validatePrompt(value, false) as CreatePromptDto; }
}
export class AdminUpdatePromptPipe implements PipeTransform<unknown, UpdatePromptDto> {
  transform(value: unknown): UpdatePromptDto { return validatePrompt(value, true); }
}

export class AdminUpdateUserPipe implements PipeTransform<unknown, UpdateUserDto> {
  transform(value: unknown): UpdateUserDto {
    const body = objectBody(value);
    rejectUnknown(body, USER_KEYS);
    if (Object.keys(body).length === 0) invalid("Patch body must not be empty");
    const result: Record<string, unknown> = {};
    if (body.dailyPromptEnabled !== undefined) {
      if (typeof body.dailyPromptEnabled !== "boolean") invalid("dailyPromptEnabled must be a boolean");
      result.dailyPromptEnabled = body.dailyPromptEnabled;
    }
    if (body.languageLevel !== undefined) {
      if (body.languageLevel !== null && (typeof body.languageLevel !== "string" || !ADMIN_LANGUAGE_LEVELS.includes(body.languageLevel as never))) invalid("languageLevel is invalid");
      result.languageLevel = body.languageLevel;
    }
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !ADMIN_USER_STATUSES.includes(body.status as never)) invalid("status is invalid");
      result.status = body.status;
    }
    if (body.bannedReason !== undefined) {
      if (body.status !== "banned") invalid("bannedReason requires banned status");
      if (typeof body.bannedReason !== "string") invalid("bannedReason must be a string");
      const bannedReason = body.bannedReason.trim();
      if (bannedReason.length > 500) invalid("bannedReason is too long");
      result.bannedReason = bannedReason;
    }
    return result as unknown as UpdateUserDto;
  }
}


const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function auditIdentifier(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${name} must be a string`);
  const normalized = value.trim();
  if (!CORRELATION_PATTERN.test(normalized)) invalid(`${name} is invalid`);
  return normalized;
}

function utcInstant(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !UTC_INSTANT_PATTERN.test(value)) invalid(`${name} must be an ISO 8601 UTC instant`);
  const parsed = new Date(value);
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== canonical) invalid(`${name} must be an ISO 8601 UTC instant`);
  return parsed;
}

export class AdminAuditLogsQueryPipe implements PipeTransform<unknown, AdminAuditLogsQuery> {
  transform(value: unknown): AdminAuditLogsQuery {
    const query = objectBody(value);
    rejectUnknown(query, new Set(["page", "limit", "actorId", "action", "entityType", "entityId", "outcome", "from", "to"]));
    const page = integerQuery(query.page, 1, "page", 1, 1_000_000);
    const limit = integerQuery(query.limit, 50, "limit", 1, 100);
    if (query.action !== undefined && (typeof query.action !== "string" || !ADMIN_AUDIT_ACTIONS.includes(query.action as never))) invalid("action is invalid");
    if (query.entityType !== undefined && (typeof query.entityType !== "string" || !ADMIN_AUDIT_ENTITY_TYPES.includes(query.entityType as never))) invalid("entityType is invalid");
    if (query.outcome !== undefined && (typeof query.outcome !== "string" || !ADMIN_AUDIT_OUTCOMES.includes(query.outcome as never))) invalid("outcome is invalid");
    const from = utcInstant(query.from, "from");
    const to = utcInstant(query.to, "to");
    if (from && to && from.getTime() >= to.getTime()) invalid("from must be before to");
    return {
      page, limit,
      actorId: auditIdentifier(query.actorId, "actorId"),
      action: query.action as AdminAuditLogsQuery["action"],
      entityType: query.entityType as AdminAuditLogsQuery["entityType"],
      entityId: auditIdentifier(query.entityId, "entityId"),
      outcome: query.outcome as AdminAuditLogsQuery["outcome"],
      from, to,
    };
  }
}

export class AdminSessionsQueryPipe implements PipeTransform<unknown, AdminSessionsQuery> {
  transform(value: unknown): AdminSessionsQuery {
    const query = objectBody(value);
    rejectUnknown(query, new Set(["page", "limit", "userId", "topic", "source", "deliveryStatus", "conversationStatus", "generationStatus", "from", "to"]));
    const page = integerQuery(query.page, 1, "page", 1, 1_000_000);
    const limit = integerQuery(query.limit, 50, "limit", 1, 100);
    let userId: string | undefined;
    if (query.userId !== undefined) {
      if (typeof query.userId !== "string" || !UUID_PATTERN.test(query.userId)) invalid("userId must be a UUID");
      userId = query.userId;
    }
    let topic: string | undefined;
    if (query.topic !== undefined) {
      if (typeof query.topic !== "string") invalid("topic must be a string");
      topic = query.topic.trim();
      if (!topic || topic.length > 200) invalid("topic is invalid");
    }
    if (query.source !== undefined && (typeof query.source !== "string" || !ADMIN_SESSION_SOURCES.includes(query.source as never))) invalid("source is invalid");
    if (query.deliveryStatus !== undefined && (typeof query.deliveryStatus !== "string" || !ADMIN_SESSION_DELIVERY_STATUSES.includes(query.deliveryStatus as never))) invalid("deliveryStatus is invalid");
    if (query.conversationStatus !== undefined && (typeof query.conversationStatus !== "string" || !ADMIN_CONVERSATION_STATUSES.includes(query.conversationStatus as never))) invalid("conversationStatus is invalid");
    if (query.generationStatus !== undefined && (typeof query.generationStatus !== "string" || !ADMIN_GENERATION_STATUSES.includes(query.generationStatus as never))) invalid("generationStatus is invalid");
    const from = utcInstant(query.from, "from");
    const to = utcInstant(query.to, "to");
    if (from && to && from.getTime() >= to.getTime()) invalid("from must be before to");
    return {
      page, limit, userId, topic,
      source: query.source as AdminSessionsQuery["source"],
      deliveryStatus: query.deliveryStatus as AdminSessionsQuery["deliveryStatus"],
      conversationStatus: query.conversationStatus as AdminSessionsQuery["conversationStatus"],
      generationStatus: query.generationStatus as AdminSessionsQuery["generationStatus"],
      from, to,
    };
  }
}

export class AdminRuntimeSettingsPatchPipe implements PipeTransform<unknown, UpdateRuntimeSettingsDto> {
  constructor(private readonly group: "product" | "infrastructure") {}

  transform(value: unknown): UpdateRuntimeSettingsDto {
    const body = objectBody(value);
    rejectUnknown(body, new Set(["expectedVersion", "values"]));
    if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0 || body.expectedVersion > 2_147_483_647) {
      invalid("expectedVersion must be an integer between 0 and 2147483647");
    }
    const values = objectBody(body.values);
    if (Object.keys(values).length === 0) invalid("values must not be empty");
    const normalized: Record<string, string | number | null> = {};
    for (const [key, candidate] of Object.entries(values)) {
      const entry = registryEntry(key);
      if (!entry || entry.group !== this.group) invalid(`${key} is not an allowed ${this.group} setting`);
      if (candidate === null) {
        normalized[key] = null;
      } else {
        if (!validateRuntimeOverride(entry, candidate)) invalid(`${key} has an invalid value`);
        normalized[key] = normalizeRuntimeOverride(entry, candidate);
      }
    }
    return { expectedVersion: body.expectedVersion as number, values: normalized };
  }
}

const PERSONALITY_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function personalityText(body:Record<string,unknown>,key:string,min:number,max:number,multiline=false):string|undefined{
  const value=body[key]; if(value===undefined)return undefined; if(typeof value!=="string")invalid(`${key} must be a string`);
  const normalized=(value as string).trim(); if(normalized.length<min||normalized.length>max)invalid(`${key} must contain ${min} to ${max} characters`);
  const controls=multiline?/[^\S\r\n\t]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/;
  if(controls.test(normalized)&&!multiline)invalid(`${key} contains invalid characters`);
  if(multiline&&/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized))invalid(`${key} contains invalid characters`);
  return normalized;
}
function validatePersonality(value:unknown,patch:boolean){const body=objectBody(value);const allowed=patch?new Set(["name","description","followUpStylePrompt","analysisStylePrompt","sortOrder"]):new Set(["key","name","description","followUpStylePrompt","analysisStylePrompt","isActive","sortOrder"]);rejectUnknown(body,allowed);if(patch&&Object.keys(body).length===0)invalid("Patch body must not be empty");const result:Record<string,unknown>={};if(!patch){if(typeof body.key!=="string"||!PERSONALITY_KEY_PATTERN.test(body.key))invalid("key is invalid");result.key=body.key;}for(const [key,min,max,multi] of [["name",1,80,false],["description",0,240,false],["followUpStylePrompt",1,8000,true],["analysisStylePrompt",1,8000,true]] as const){const parsed=personalityText(body,key,min,max,multi);if(parsed!==undefined)result[key]=parsed;else if(!patch&&key!=="description")invalid(`${key} is required`);}if(!patch&&body.isActive!==undefined){if(typeof body.isActive!=="boolean")invalid("isActive must be a boolean");result.isActive=body.isActive;}if(body.sortOrder!==undefined){if(typeof body.sortOrder!=="number"||!Number.isInteger(body.sortOrder)||body.sortOrder<0||body.sortOrder>2147483647)invalid("sortOrder is invalid");result.sortOrder=body.sortOrder;}return result;}
export class AdminCreatePersonalityPipe implements PipeTransform<unknown, import("./admin.contracts").CreatePersonalityDto>{transform(value:unknown){return validatePersonality(value,false) as unknown as import("./admin.contracts").CreatePersonalityDto;}}
export class AdminUpdatePersonalityPipe implements PipeTransform<unknown, import("./admin.contracts").UpdatePersonalityDto>{transform(value:unknown){return validatePersonality(value,true) as import("./admin.contracts").UpdatePersonalityDto;}}

export class AdminUpdateAgentPromptRulesPipe implements PipeTransform<unknown, import("./admin.contracts").UpdateAgentPromptRulesDto> {
  transform(value: unknown): import("./admin.contracts").UpdateAgentPromptRulesDto {
    const body = objectBody(value);
    rejectUnknown(body, new Set(["followUpPrompt", "analysisPrompt"]));
    const followUpPrompt = personalityText(body, "followUpPrompt", 1, 8000, true);
    const analysisPrompt = personalityText(body, "analysisPrompt", 1, 8000, true);
    if (followUpPrompt === undefined || analysisPrompt === undefined) invalid("followUpPrompt and analysisPrompt are required");
    return { followUpPrompt, analysisPrompt };
  }
}
