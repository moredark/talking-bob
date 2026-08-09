import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface ObservabilityContext {
  correlationId: string;
  userId?: string;
  telegramUpdateId?: string;
  requestId?: string;
}

@Injectable()
export class ObservabilityContextService {
  private readonly storage = new AsyncLocalStorage<ObservabilityContext>();

  createCorrelationId(prefix: "tg" | "schedule" | "delivery" | "retention" = "tg"): string {
    return `${prefix}-${randomUUID()}`;
  }

  run<T>(
    context: Partial<ObservabilityContext> & Pick<ObservabilityContext, "correlationId">,
    callback: () => T,
  ): T {
    return this.storage.run({ ...context }, callback);
  }

  enrich(context: Omit<Partial<ObservabilityContext>, "correlationId">): void {
    const current = this.storage.getStore();
    if (current) Object.assign(current, context);
  }

  current(): Readonly<ObservabilityContext> | undefined {
    return this.storage.getStore();
  }
}
