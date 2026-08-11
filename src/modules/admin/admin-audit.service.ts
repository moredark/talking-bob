import { ConflictException, HttpException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../infrastructure/database";
import { registryEntry } from "../../config/runtime-settings.registry";
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_ENTITY_TYPES,
  ADMIN_AUDIT_FAILURE_CODES,
  ADMIN_AUDIT_OUTCOMES,
  ADMIN_LANGUAGE_LEVELS,
  ADMIN_PROMPT_TAGS,
  ADMIN_USER_STATUSES,
  AdminAuditAction,
  AdminAuditDetail,
  AdminAuditEntityType,
  AdminAuditFailureCode,
  AdminAuditListItem,
  AdminAuditLogsQuery,
  AdminAuditOutcome,
  PaginatedResult,
} from "./admin.contracts";
import { AdminAuditContextService } from "./admin-audit-context.service";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_INT = 2_147_483_647;
const AUDIT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AdminAuditWriteError extends Error {
  constructor() {
    super("Admin audit write failed");
    this.name = "AdminAuditWriteError";
  }
}

export interface AdminAuditMutationResult<T> {
  result: T;
  entityId: string;
  before?: unknown;
  after?: unknown;
  skipAudit?: boolean;
}

@Injectable()
export class AdminAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: AdminAuditContextService,
  ) {}

  async runSuccess<T>(
    input: { action: AdminAuditAction; entityType: AdminAuditEntityType },
    callback: (tx: Prisma.TransactionClient) => Promise<AdminAuditMutationResult<T>>,
  ): Promise<T> {
    const auditContext = this.context.current() ?? this.context.fallback();
    return this.prisma.$transaction(async (tx) => {
      const mutation = await callback(tx);
      if (mutation.skipAudit) return mutation.result;
      const entityId = this.identifier(mutation.entityId);
      if (!entityId) throw new AdminAuditWriteError();
      try {
        await tx.adminAuditLog.create({
          data: {
            actorId: auditContext.actorId,
            actorUsername: auditContext.actorUsername,
            action: input.action,
            entityType: input.entityType,
            entityId,
            outcome: "success",
            requestId: auditContext.requestId,
            correlationId: auditContext.correlationId,
            before: this.json(this.sanitizeSnapshot(input.action, mutation.before)),
            after: this.json(this.sanitizeSnapshot(input.action, mutation.after)),
            failureCode: null,
          },
        });
      } catch {
        throw new AdminAuditWriteError();
      }
      return mutation.result;
    });
  }

  async writeFailureBestEffort(input: {
    action: AdminAuditAction;
    entityType: AdminAuditEntityType;
    entityId?: unknown;
    error: unknown;
  }): Promise<void> {
    const auditContext = this.context.current() ?? this.context.fallback();
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          actorId: auditContext.actorId,
          actorUsername: auditContext.actorUsername,
          action: input.action,
          entityType: input.entityType,
          entityId: this.identifier(input.entityId),
          outcome: "failure",
          requestId: auditContext.requestId,
          correlationId: auditContext.correlationId,
          failureCode: this.failureCode(input.error),
        },
      });
    } catch {
      console.error("Admin audit failure log storage failed");
    }
  }

  async getLogs(query: AdminAuditLogsQuery): Promise<PaginatedResult<AdminAuditListItem>> {
    const where: Prisma.AdminAuditLogWhereInput = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.outcome) where.outcome = query.outcome;
    if (query.from || query.to) where.createdAt = { gte: query.from, lt: query.to };
    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);
    return {
      data: logs.map((log) => this.listItem(log)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async getLogById(id: string): Promise<AdminAuditDetail | null> {
    const log = await this.prisma.adminAuditLog.findUnique({ where: { id } });
    if (!log) return null;
    return {
      ...this.listItem(log),
      before: this.sanitizeSnapshot(log.action as AdminAuditAction, log.before),
      after: this.sanitizeSnapshot(log.action as AdminAuditAction, log.after),
    };
  }

  private listItem(log: { id: string; actorId: string; actorUsername: string; action: string; entityType: string; entityId: string | null; outcome: string; requestId: string; correlationId: string; failureCode: string | null; createdAt: Date }): AdminAuditListItem {
    return {
      id: AUDIT_UUID_PATTERN.test(log.id) ? log.id : "unknown",
      actorId: this.identifier(log.actorId) ?? "unknown",
      actorUsername: this.username(log.actorUsername),
      action: ADMIN_AUDIT_ACTIONS.includes(log.action as AdminAuditAction) ? log.action as AdminAuditAction : "user.update",
      entityType: ADMIN_AUDIT_ENTITY_TYPES.includes(log.entityType as AdminAuditEntityType) ? log.entityType as AdminAuditEntityType : "user",
      entityId: this.identifier(log.entityId),
      outcome: ADMIN_AUDIT_OUTCOMES.includes(log.outcome as AdminAuditOutcome) ? log.outcome as AdminAuditOutcome : "failure",
      requestId: this.identifier(log.requestId) ?? "unknown",
      correlationId: this.identifier(log.correlationId) ?? "unknown",
      failureCode: log.failureCode && ADMIN_AUDIT_FAILURE_CODES.includes(log.failureCode as AdminAuditFailureCode) ? log.failureCode as AdminAuditFailureCode : null,
      createdAt: log.createdAt,
    };
  }

  private sanitizeSnapshot(action: AdminAuditAction, value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    if (action === "user.update") {
      if (typeof source.dailyPromptEnabled === "boolean") result.dailyPromptEnabled = source.dailyPromptEnabled;
      if (source.languageLevel === null || (typeof source.languageLevel === "string" && ADMIN_LANGUAGE_LEVELS.includes(source.languageLevel as never))) result.languageLevel = source.languageLevel;
      if (typeof source.status === "string" && ADMIN_USER_STATUSES.includes(source.status as never)) result.status = source.status;
      const bannedAt = this.instantOrNull(source.bannedAt);
      if (bannedAt !== undefined) result.bannedAt = bannedAt;
      if (typeof source.hasBannedReason === "boolean") result.hasBannedReason = source.hasBannedReason;
    } else if (action.startsWith("prompt.")) {
      if (typeof source.difficulty === "string" && ["easy", "medium", "hard"].includes(source.difficulty)) result.difficulty = source.difficulty;
      if (Array.isArray(source.tags) && source.tags.length <= 6 && source.tags.every((tag) => typeof tag === "string" && ADMIN_PROMPT_TAGS.includes(tag as never)) && new Set(source.tags).size === source.tags.length) result.tags = source.tags;
      if (typeof source.isActive === "boolean") result.isActive = source.isActive;
      if (this.nonNegativeInt(source.sortOrder) !== null) result.sortOrder = source.sortOrder;
      if (typeof source.hasTextContent === "boolean") result.hasTextContent = source.hasTextContent;
      if (typeof source.hasAudioFileId === "boolean") result.hasAudioFileId = source.hasAudioFileId;
    } else if (action === "user.reset_progress") {
      for (const key of [
        "streakReminders",
        "streakDays",
        "reportDeliveryRequests",
        "userActivityDays",
        "conversationMessages",
        "userResponses",
        "userPrompts",
      ] as const) {
        const count = this.nonNegativeInt(source[key]);
        if (count !== null) result[key] = count;
      }
    } else if (action === "error_log.clear_old") {
      const cutoff = this.instantOrNull(source.cutoff);
      if (typeof cutoff === "string") result.cutoff = cutoff;
      const days = this.nonNegativeInt(source.days);
      if (days !== null && days >= 1 && days <= 3650) result.days = days;
      const deletedCount = this.nonNegativeInt(source.deletedCount);
      if (deletedCount !== null) result.deletedCount = deletedCount;
    } else if (action === "settings.product.update" || action === "settings.infrastructure.update") {
      const group = action === "settings.product.update" ? "product" : "infrastructure";
      const version = this.nonNegativeInt(source.version);
      if (version !== null) result.version = version;
      if (Array.isArray(source.overrideKeys) && source.overrideKeys.length <= 32 && source.overrideKeys.every((item) => typeof item === "string" && registryEntry(item)?.group === group)) {
        result.overrideKeys = [...source.overrideKeys];
      }
      for (const key of ["changedKeys", "resetKeys"] as const) {
        if (Array.isArray(source[key]) && source[key].length <= 32 && source[key].every((item) => {
          if (typeof item !== "string") return false;
          return registryEntry(item)?.group === group;
        })) result[key] = [...source[key]];
      }
    } else if (action === "broadcast.create" || action === "broadcast.cancel") {
      if (typeof source.mode === "string" && ["immediate", "scheduled"].includes(source.mode)) result.mode = source.mode;
      if (typeof source.status === "string" && ["queued", "processing", "completed", "completed_with_errors", "cancelled"].includes(source.status)) result.status = source.status;
      const scheduledAt = this.instantOrNull(source.scheduledAt);
      if (typeof scheduledAt === "string") result.scheduledAt = scheduledAt;
      const audienceCount = this.nonNegativeInt(source.audienceCount);
      if (audienceCount !== null) result.audienceCount = audienceCount;
      if (source.filters !== null && typeof source.filters === "object" && !Array.isArray(source.filters)) {
        const filters = source.filters as Record<string, unknown>;
        const safeFilters: Record<string, unknown> = {};
        if (Array.isArray(filters.languageLevels)
          && filters.languageLevels.length <= ADMIN_LANGUAGE_LEVELS.length
          && filters.languageLevels.every((level) => typeof level === "string" && ADMIN_LANGUAGE_LEVELS.includes(level as never))) {
          safeFilters.languageLevels = [...filters.languageLevels];
        }
        if (typeof filters.activity === "string" && ["any", "7d", "30d", "90d", "never"].includes(filters.activity)) safeFilters.activity = filters.activity;
        if (filters.dailyPromptEnabled === "any" || typeof filters.dailyPromptEnabled === "boolean") safeFilters.dailyPromptEnabled = filters.dailyPromptEnabled;
        if (Object.keys(safeFilters).length > 0) result.filters = safeFilters;
      }
      if (source.counts !== null && typeof source.counts === "object" && !Array.isArray(source.counts)) {
        const counts = source.counts as Record<string, unknown>;
        const safeCounts: Record<string, number> = {};
        for (const key of ["total", "pending", "sent", "failed", "ambiguous", "skipped"] as const) {
          const count = this.nonNegativeInt(counts[key]);
          if (count !== null) safeCounts[key] = count;
        }
        if (Object.keys(safeCounts).length > 0) result.counts = safeCounts;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  private json(value: Record<string, unknown> | null): Prisma.InputJsonValue | undefined {
    return value ? value as Prisma.InputJsonObject : undefined;
  }

  private failureCode(error: unknown): AdminAuditFailureCode {
    if (error instanceof AdminAuditWriteError) return "audit_write_failed";
    if (error instanceof UnprocessableEntityException) return "validation_failed";
    if (error instanceof NotFoundException || this.prismaCode(error) === "P2025") return "not_found";
    if (error instanceof ConflictException || ["P2002", "P2003"].includes(this.prismaCode(error) ?? "")) return "conflict";
    if (error instanceof HttpException && error.getStatus() === 422) return "validation_failed";
    return "internal_error";
  }

  private prismaCode(error: unknown): string | undefined {
    return error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  }

  private identifier(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
  }

  private username(value: unknown): string {
    if (typeof value !== "string") return "unknown";
    const normalized = value.trim();
    return normalized.length >= 1 && normalized.length <= 200 && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : "unknown";
  }

  private nonNegativeInt(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INT ? value : null;
  }

  private instantOrNull(value: unknown): string | null | undefined {
    if (value === null) return null;
    const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
}
