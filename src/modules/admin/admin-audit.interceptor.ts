import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, Subscriber, Subscription } from "rxjs";
import { ObservabilityContextService } from "../error-log";
import { AdminAuditEntityType, AdminAuditAction } from "./admin.contracts";
import { AdminAuditContextService } from "./admin-audit-context.service";
import { ADMIN_AUDIT_MUTATION_METADATA, AdminAuditMutationMetadata } from "./admin-audit.decorator";
import { AdminAuditService } from "./admin-audit.service";

interface MutationDescriptor {
  action: AdminAuditAction;
  entityType: AdminAuditEntityType;
  entityId?: unknown;
}

@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly context: AdminAuditContextService,
    private readonly audit: AdminAuditService,
    private readonly reflector: Reflector,
    @Optional() private readonly observability?: ObservabilityContextService,
  ) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = execution.switchToHttp().getRequest<{
      admin?: { sub?: unknown; username?: unknown };
      headers?: Record<string, unknown>;
      params?: Record<string, unknown>;
    }>();
    const response = execution.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
    const auditContext = this.context.create({
      actorId: request.admin?.sub,
      actorUsername: request.admin?.username,
      requestId: request.headers?.["x-request-id"],
      correlationId: request.headers?.["x-correlation-id"],
    });
    const mutation = this.mutation(execution, request.params ?? {});
    response.setHeader("x-request-id", auditContext.requestId);
    response.setHeader("x-correlation-id", auditContext.correlationId);

    return new Observable((subscriber) => this.context.run(auditContext, () => {
      const subscribe = () => this.subscribe(next, mutation, subscriber);
      return this.observability
        ? this.observability.run({ correlationId: auditContext.correlationId, requestId: auditContext.requestId }, subscribe)
        : subscribe();
    }));
  }

  private subscribe(next: CallHandler, mutation: MutationDescriptor | undefined, subscriber: Subscriber<unknown>): Subscription | undefined {
    try {
      return next.handle().subscribe({
        next: (value) => subscriber.next(value),
        complete: () => subscriber.complete(),
        error: (error: unknown) => {
          if (!mutation) {
            subscriber.error(error);
            return;
          }
          void this.audit.writeFailureBestEffort({ ...mutation, error });
          subscriber.error(error);
        },
      });
    } catch (error) {
      if (!mutation) {
        subscriber.error(error);
        return undefined;
      }
      void this.audit.writeFailureBestEffort({ ...mutation, error });
      subscriber.error(error);
      return undefined;
    }
  }

  private mutation(execution: ExecutionContext, params: Record<string, unknown>): MutationDescriptor | undefined {
    const metadata = this.reflector.get<AdminAuditMutationMetadata>(ADMIN_AUDIT_MUTATION_METADATA, execution.getHandler());
    if (!metadata) return undefined;
    const entityId = metadata.entityType === "error_log" ? "old" : params.id;
    return { ...metadata, entityId };
  }
}
