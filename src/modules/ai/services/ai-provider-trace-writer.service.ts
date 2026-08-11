import { Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database";
import { ErrorLogService } from "../../error-log";

export interface AiProviderTraceContext {
  userId: string;
  userPromptId: string;
  userResponseId?: string;
  correlationId?: string;
  requestId?: string;
}

export interface AiProviderTraceInput extends AiProviderTraceContext {
  operation: "follow_up" | "analysis";
  provider: string;
  model: string;
  attempt: number;
  outcome: "succeeded" | "empty" | "failed";
  statusCode?: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  responseContent?: string;
  failureCode?: string;
}

@Injectable()
export class AiProviderTraceWriter {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly errorLog?: ErrorLogService,
  ) {}

  write(input: AiProviderTraceInput): void {
    void this.persist(input);
  }

  private async persist(input: AiProviderTraceInput): Promise<void> {
    try {
      await this.prisma.aiProviderCall.create({ data: {
        ...input,
        userResponseId: input.userResponseId ?? null,
        statusCode: input.statusCode ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        totalTokens: input.totalTokens ?? null,
        responseContent: input.outcome === "succeeded" ? input.responseContent!.trim() : null,
        failureCode: input.outcome === "failed" ? this.failureCode(input.failureCode) : null,
        correlationId: this.identifier(input.correlationId),
        requestId: this.identifier(input.requestId),
      } });
    } catch (error) {
      try {
        await this.errorLog?.capture({
          type: "system", service: "llm", operation: "trace.persist",
          error, retryable: true,
        });
      } catch {
        // Trace and fallback observability are both best effort.
      }
    }
  }

  private identifier(value?: string): string | null {
    if (!value) return null;
    const normalized = value.trim();
    return /^[A-Za-z0-9_.:-]{1,160}$/.test(normalized) ? normalized : null;
  }

  private failureCode(value?: string): string {
    const normalized = value?.trim() ?? "";
    return /^[A-Za-z0-9_.:-]{1,80}$/.test(normalized) ? normalized : "internal_error";
  }
}
