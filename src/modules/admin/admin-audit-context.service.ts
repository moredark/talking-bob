import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

export interface AdminAuditContext {
  actorId: string;
  actorUsername: string;
  requestId: string;
  correlationId: string;
}

@Injectable()
export class AdminAuditContextService {
  private readonly storage = new AsyncLocalStorage<AdminAuditContext>();

  create(input: { actorId?: unknown; actorUsername?: unknown; requestId?: unknown; correlationId?: unknown }): AdminAuditContext {
    return {
      actorId: this.identifier(input.actorId) ?? "unknown",
      actorUsername: this.username(input.actorUsername),
      requestId: this.identifier(input.requestId) ?? `admin-request-${randomUUID()}`,
      correlationId: this.identifier(input.correlationId) ?? `admin-${randomUUID()}`,
    };
  }

  run<T>(context: AdminAuditContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  current(): Readonly<AdminAuditContext> | undefined {
    return this.storage.getStore();
  }

  fallback(): AdminAuditContext {
    return this.create({ actorId: "unknown", actorUsername: "unknown" });
  }

  private identifier(value: unknown): string | undefined {
    if (Array.isArray(value)) value = value[0];
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return IDENTIFIER_PATTERN.test(normalized) ? normalized : undefined;
  }

  private username(value: unknown): string {
    if (typeof value !== "string") return "unknown";
    const normalized = value.trim();
    return normalized.length >= 1 && normalized.length <= 200 && !/[\u0000-\u001f\u007f]/.test(normalized)
      ? normalized
      : "unknown";
  }
}
