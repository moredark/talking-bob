import { Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { ObservabilityContextService } from "./observability-context.service";

export type ErrorType = "ai" | "telegram" | "system";
export type ErrorService = "whisper" | "llm" | "tts" | "telegram" | "scheduler" | "general";

export interface LogErrorParams {
  type: ErrorType;
  service: ErrorService;
  message?: string;
  stack?: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  operation?: string;
  correlationId?: string;
  telegramUpdateId?: string | number | bigint;
  requestId?: string;
  latencyMs?: number;
  statusCode?: number;
  retryable?: boolean;
  error?: unknown;
  code?: string;
}

interface SanitizedErrorMetadata {
  schemaVersion: 1;
  operation: string;
  correlationId?: string;
  telegramUpdateId?: string;
  requestId?: string;
  latencyMs?: number;
  statusCode?: number;
  retryable?: boolean;
  errorKind: string;
  code?: string;
}

const SAFE_ERROR_KINDS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "UnknownError",
  "BoundedHttpError",
  "AiRequestLimiterClosedError",
  "AiRequestLimiterOverloadedError",
  "TelegramRuntimeClosedError",
  "WhisperProviderStatusError",
  "LlmProviderStatusError",
  "GrammyError",
  "HttpError",
]);

const SAFE_CODES = new Set([
  "aborted",
  "network",
  "response_too_large",
  "timeout",
  "definite",
  "ambiguous",
  "transport",
  "unknown",
  "bot_unavailable",
  "quota_release_failed",
]);

const SAFE_OPERATIONS = new Set([
  "update.handle",
  "callback.acknowledge",
  "runner.start",
  "runner.run",
  "start.release_quota",
  "start.send_welcome",
  "voice.process",
  "report.generate",
  "report.prepare_delivery",
  "report.persist_attempt",
  "report.send_chunk",
  "report.persist_success",
  "transcribe",
  "analyze_speech",
  "generate_follow_up",
  "claim.dispatch",
  "tick",
  "delivery.bot_unavailable",
  "delivery.persist_success",
  "delivery.send",
  "delivery.persist_failure",
  "retention.cleanup",
]);

@Injectable()
export class ErrorLogService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly observability?: ObservabilityContextService,
  ) {}

  async capture(params: LogErrorParams): Promise<void> {
    const current = this.observability?.current();
    const metadata = this.sanitize(params, current);
    try {
      await this.prisma.errorLog.create({
        data: {
          type: params.type,
          service: params.service,
          operation: metadata.operation,
          correlationId: metadata.correlationId,
          statusCode: metadata.statusCode,
          retryable: metadata.retryable,
          latencyMs: metadata.latencyMs,
          errorKind: metadata.errorKind,
          message: metadata.errorKind,
          stack: null,
          metadata: JSON.parse(JSON.stringify(metadata)),
          userId: this.safeIdentifier(params.userId ?? current?.userId),
        },
      });
    } catch {
      console.error("Structured error log storage failed");
    }
  }

  async log(params: LogErrorParams): Promise<void> {
    await this.capture(params);
  }

  async getLogs(options: { type?: ErrorType; service?: ErrorService; correlationId?: string; limit?: number; offset?: number; stableOrder?: boolean }) {
    const { type, service, correlationId, limit = 50, offset = 0, stableOrder = false } = options;
    const where: Record<string, string> = {};
    if (type) where.type = type;
    if (service) where.service = service;
    const safeCorrelationId = this.safeIdentifier(correlationId);
    if (correlationId !== undefined && !safeCorrelationId) {
      return { logs: [], total: 0 };
    }
    if (safeCorrelationId) where.correlationId = safeCorrelationId;
    const [logs, total] = await Promise.all([
      this.prisma.errorLog.findMany({ where, orderBy: stableOrder ? [{ createdAt: "desc" }, { id: "desc" }] : { createdAt: "desc" }, take: limit, skip: offset }),
      this.prisma.errorLog.count({ where }),
    ]);
    return { logs, total };
  }

  async getLogById(id: string) {
    return this.prisma.errorLog.findUnique({ where: { id } });
  }

  async clearOldLogs(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    const result = await this.prisma.errorLog.deleteMany({ where: { createdAt: { lt: cutoffDate } } });
    return result.count;
  }

  private sanitize(
    params: LogErrorParams,
    current?: Readonly<{ correlationId: string; telegramUpdateId?: string; requestId?: string }>,
  ): SanitizedErrorMetadata {
    const legacy = params.metadata ?? {};
    const errorKind = params.error instanceof Error
      ? this.safeErrorKind(params.error.name)
      : "LegacyError";
    const retryable = params.retryable ?? legacy.retryable;
    return {
      schemaVersion: 1,
      operation: this.safeOperation(params.operation),
      correlationId: this.safeIdentifier(params.correlationId ?? current?.correlationId),
      telegramUpdateId: this.safeIdentifier(params.telegramUpdateId ?? current?.telegramUpdateId),
      requestId: this.safeIdentifier(params.requestId ?? current?.requestId),
      latencyMs: this.safeNonNegativeNumber(params.latencyMs ?? legacy.latencyMs),
      statusCode: this.safeStatusCode(params.statusCode ?? legacy.statusCode),
      retryable: typeof retryable === "boolean" ? retryable : undefined,
      errorKind,
      code: this.safeCode(params.code),
    };
  }

  private safeToken(value: unknown, fallback: string): string {
    return this.safeOptionalToken(value) ?? fallback;
  }

  private safeOptionalToken(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return /^[A-Za-z0-9_.:-]{1,80}$/.test(normalized) ? normalized : undefined;
  }

  private safeErrorKind(value: string): string {
    return SAFE_ERROR_KINDS.has(value) ? value : "UnknownError";
  }

  private safeOperation(value: unknown): string {
    return typeof value === "string" && SAFE_OPERATIONS.has(value)
      ? value
      : "unknown";
  }

  private safeCode(value: unknown): string | undefined {
    return typeof value === "string" && SAFE_CODES.has(value) ? value : undefined;
  }

  private safeIdentifier(value: unknown): string | undefined {
    if (typeof value === "bigint" || typeof value === "number") value = String(value);
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return /^[A-Za-z0-9_.:-]{1,160}$/.test(normalized) ? normalized : undefined;
  }

  private safeNonNegativeNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  }

  private safeStatusCode(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
  }
}
