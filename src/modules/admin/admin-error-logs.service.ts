import { Injectable } from "@nestjs/common";
import { ErrorLogService } from "../error-log";
import {
  ADMIN_ERROR_SERVICES,
  ADMIN_ERROR_TYPES,
  AdminErrorService,
  AdminErrorType,
  ErrorLogItem,
  PaginatedResult,
} from "./admin.contracts";
import { AdminAuditService } from "./admin-audit.service";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INT = 2_147_483_647;
const SAFE_OPERATIONS = new Set([
  "update.handle", "callback.acknowledge", "runner.start", "runner.run",
  "start.release_quota", "start.send_welcome", "voice.process", "report.generate",
  "report.prepare_delivery", "report.persist_attempt", "report.send_chunk",
  "report.persist_success", "transcribe", "analyze_speech", "generate_follow_up",
  "claim.dispatch", "tick", "delivery.bot_unavailable", "delivery.persist_success",
  "delivery.send", "delivery.persist_failure", "retention.cleanup", "unknown",
]);
const SAFE_ERROR_KINDS = new Set([
  "Error", "TypeError", "RangeError", "UnknownError", "LegacyError", "BoundedHttpError",
  "AiRequestLimiterClosedError", "AiRequestLimiterOverloadedError", "TelegramRuntimeClosedError",
  "WhisperProviderStatusError", "LlmProviderStatusError", "GrammyError", "HttpError",
]);
const SAFE_CODES = new Set([
  "aborted", "network", "response_too_large", "timeout", "definite", "ambiguous",
  "transport", "unknown", "bot_unavailable", "quota_release_failed",
]);

@Injectable()
export class AdminErrorLogsService {
  constructor(
    private readonly errorLogService: ErrorLogService,
    private readonly audit: AdminAuditService,
  ) {}

  async getErrorLogs(page: number, limit: number, type?: AdminErrorType, service?: AdminErrorService, correlationId?: string): Promise<PaginatedResult<ErrorLogItem>> {
    const result = await this.errorLogService.getLogs({ type, service, correlationId, limit, offset: (page - 1) * limit, stableOrder: true });
    return { data: result.logs.map((log) => this.mapLog(log)), total: result.total, page, limit, totalPages: Math.ceil(result.total / limit) };
  }

  async getErrorLogById(id: string): Promise<ErrorLogItem | null> {
    const log = await this.errorLogService.getLogById(id);
    return log ? this.mapLog(log) : null;
  }

  async clearOldErrorLogs(daysOld = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);
    return this.audit.runSuccess({ action: "error_log.clear_old", entityType: "error_log" }, async (tx) => {
      const deleted = await tx.errorLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
      return {
        result: deleted.count,
        entityId: "old",
        after: { cutoff, days: daysOld, deletedCount: deleted.count },
      };
    });
  }

  private mapLog(log: { id: string; type: string; service: string; operation: string; correlationId: string | null; statusCode: number | null; retryable: boolean | null; latencyMs: number | null; errorKind: string; message: string; metadata: unknown; userId: string | null; createdAt: Date }): ErrorLogItem {
    const errorKind = this.safeErrorKind(log.errorKind);
    return {
      id: this.safeUuid(log.id) ?? "unknown",
      type: this.safeErrorType(log.type),
      service: this.safeErrorService(log.service),
      operation: this.safeOperation(log.operation),
      correlationId: this.safeIdentifier(log.correlationId),
      statusCode: this.safeStatusCode(log.statusCode),
      retryable: typeof log.retryable === "boolean" ? log.retryable : null,
      latencyMs: this.safeNonNegativeInt(log.latencyMs),
      errorKind,
      message: errorKind,
      stack: null,
      metadata: this.sanitizeMetadata(log.metadata),
      userId: this.safeUuid(log.userId),
      createdAt: log.createdAt,
    };
  }

  private sanitizeMetadata(value: unknown): Record<string, string | number | boolean> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const sanitized: Record<string, string | number | boolean> = {};
    if (source.schemaVersion === 1) sanitized.schemaVersion = 1;
    const operation = this.safeOptionalOperation(source.operation);
    if (operation) sanitized.operation = operation;
    for (const key of ["correlationId", "telegramUpdateId", "requestId"] as const) {
      const identifier = this.safeIdentifier(source[key]);
      if (identifier) sanitized[key] = identifier;
    }
    const latencyMs = this.safeNonNegativeInt(source.latencyMs);
    if (latencyMs !== null) sanitized.latencyMs = latencyMs;
    const statusCode = this.safeStatusCode(source.statusCode);
    if (statusCode !== null) sanitized.statusCode = statusCode;
    if (typeof source.retryable === "boolean") sanitized.retryable = source.retryable;
    if (typeof source.errorKind === "string" && SAFE_ERROR_KINDS.has(source.errorKind)) sanitized.errorKind = source.errorKind;
    if (typeof source.code === "string" && SAFE_CODES.has(source.code)) sanitized.code = source.code;
    return Object.keys(sanitized).length > 0 ? sanitized : null;
  }

  private safeErrorType(value: unknown): string {
    return typeof value === "string" && ADMIN_ERROR_TYPES.includes(value as AdminErrorType) ? value : "unknown";
  }

  private safeErrorService(value: unknown): string {
    return typeof value === "string" && ADMIN_ERROR_SERVICES.includes(value as AdminErrorService) ? value : "unknown";
  }

  private safeErrorKind(value: unknown): string {
    return typeof value === "string" && SAFE_ERROR_KINDS.has(value) ? value : "UnknownError";
  }

  private safeOperation(value: unknown): string {
    return this.safeOptionalOperation(value) ?? "unknown";
  }

  private safeOptionalOperation(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return SAFE_OPERATIONS.has(normalized) ? normalized : null;
  }

  private safeIdentifier(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
  }

  private safeUuid(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return UUID_PATTERN.test(normalized) ? normalized : null;
  }

  private safeNonNegativeInt(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INT ? value : null;
  }

  private safeStatusCode(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
  }
}
