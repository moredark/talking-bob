import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Context, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { AgentTone, ILLMService, LLM_SERVICE } from "../ai";
import { ConversationService } from "../conversation";
import { ErrorLogService, ObservabilityContextService } from "../error-log";
import { DeliveryClaim, GenerationClaim, ResponseService } from "../response";
import {
  chunkReportOutput,
  formatReportOutput,
  ReportOutputFeedback,
} from "./report-output";

@Injectable()
export class ReportWorkflowService {
  private readonly logger = new Logger(ReportWorkflowService.name);

  constructor(
    private readonly responseService: ResponseService,
    private readonly conversationService: ConversationService,
    @Inject(LLM_SERVICE) private readonly llmService: ILLMService,
    @Optional() private readonly errorLog?: ErrorLogService,
    @Optional() private readonly observability?: ObservabilityContextService,
  ) {}

  async generateClaimedReport(
    ctx: Context,
    userPromptId: string,
    topic: string,
    tone: AgentTone,
    claim: GenerationClaim,
  ): Promise<void> {
    this.observability?.enrich({ requestId: claim.responseId });
    const startedAt = Date.now();
    const messages = await this.conversationService.getMessages(userPromptId);
    const transcript = messages.filter((m) => m.role === "user").map((m) => m.content).join(" ");
    let deliveryClaim: DeliveryClaim | null = null;
    try {
      const feedback = await this.llmService.analyzeSpeech(transcript, topic, "en", tone, claim.userId ? {
        userId: claim.userId, userPromptId: claim.userPromptId ?? userPromptId,
        userResponseId: claim.responseId, requestId: claim.responseId,
        correlationId: this.observability?.current()?.correlationId,
      } : undefined);
      const chunks = chunkReportOutput(formatReportOutput(feedback, transcript));
      const completed = await this.responseService.completeGeneration({
        responseId: claim.responseId, claimToken: claim.claimToken, transcript,
        analysis: JSON.stringify(feedback), analysisVersion: feedback.version,
        analysisKind: feedback.kind,
        overallScore: feedback.kind === "model" ? feedback.overallScore : null,
        chunks,
      });
      if (completed.outcome === "claimed") deliveryClaim = completed.claim;
    } catch (error) {
      await this.responseService.failGeneration(claim.responseId, claim.claimToken, this.errorKind(error));
      this.logger.error(`Failed to generate report (${this.errorKind(error)})`);
      await this.errorLog?.capture({
        type: "ai",
        service: "llm",
        operation: "report.generate",
        requestId: claim.responseId,
        latencyMs: Date.now() - startedAt,
        error,
        retryable: true,
      });
      await ctx.reply("😔 Произошла ошибка при формировании отчёта. Попробуйте позже.");
      return;
    }
    if (deliveryClaim) await this.deliver(ctx, deliveryClaim);
  }

  async deliverPersisted(
    ctx: Context,
    response: { id: string; transcript: string | null; analysis: string | null },
    requestKey: string,
  ): Promise<void> {
    try {
      const chunks = chunkReportOutput(formatReportOutput(this.parseFeedback(response.analysis), response.transcript ?? ""));
      const result = await this.responseService.createOrClaimDeliveryRequest(response.id, requestKey, chunks);
      if (result.outcome === "claimed") await this.deliver(ctx, result.claim);
      if (result.outcome === "failed" || result.outcome === "ambiguous") {
        await ctx.reply(
          "Не удалось подтвердить доставку этого запроса. Отправьте новую команду /report, чтобы переотправить сохранённый отчёт.",
        );
      }
    } catch (error) {
      this.logger.error(`Failed to prepare saved report (${this.errorKind(error)})`);
      await this.errorLog?.capture({
        type: "telegram",
        service: "telegram",
        operation: "report.prepare_delivery",
        requestId: response.id,
        error,
        retryable: true,
      });
      await ctx.reply("😔 Не удалось отправить сохранённый отчёт.");
    }
  }

  private async deliver(ctx: Context, initialClaim: DeliveryClaim): Promise<void> {
    let claim = initialClaim;
    while (true) {
      let begun;
      try {
        begun = await this.responseService.beginDeliveryChunk(claim.requestId, claim.claimToken);
      } catch (error) {
        this.logger.error(`Could not persist report delivery attempt (${this.errorKind(error)})`);
        await this.errorLog?.capture({
          type: "system", service: "telegram", operation: "report.persist_attempt",
          requestId: claim.requestId, error, retryable: true,
        });
        return;
      }
      if (begun.outcome === "stale") return;
      try {
        const final = begun.chunkIndex === claim.chunks.length - 1;
        await ctx.reply(begun.chunk, final
          ? { reply_markup: new InlineKeyboard().text("🎤 Новый вопрос", "new_question") }
          : undefined);
      } catch (error) {
        if (error instanceof GrammyError) {
          await this.responseService.failDeliveryDefinite(claim.requestId, begun.chunkIndex, begun.attemptedAt, this.errorKind(error));
        } else {
          await this.responseService.failDeliveryAmbiguous(
            claim.requestId, begun.chunkIndex, begun.attemptedAt,
            error instanceof HttpError ? "http_error" : this.errorKind(error),
          );
        }
        this.logger.warn(`Report delivery failed (${error instanceof GrammyError ? "definite" : "ambiguous"})`);
        await this.errorLog?.capture({
          type: "telegram", service: "telegram", operation: "report.send_chunk",
          requestId: claim.requestId, error,
          retryable: !(error instanceof GrammyError),
          code: error instanceof GrammyError ? "definite" : "ambiguous",
        });
        return;
      }
      let completed;
      try {
        completed = await this.responseService.completeDeliveryChunk(
          claim.requestId,
          begun.chunkIndex,
          begun.attemptedAt,
        );
      } catch (error) {
        // beginDeliveryChunk persisted an unknown outcome before the send. Do
        // not emit another Telegram message when durable success recording
        // fails after Telegram accepted the chunk.
        this.logger.error(`Could not persist successful report delivery (${this.errorKind(error)})`);
        await this.errorLog?.capture({
          type: "system", service: "telegram", operation: "report.persist_success",
          requestId: claim.requestId, error, retryable: true,
        });
        return;
      }
      if (completed.outcome !== "claimed_next") return;
      claim = completed.claim;
    }
  }

  private parseFeedback(value: string | null): ReportOutputFeedback {
    if (!value) throw new Error("missing_report_analysis");
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_report_analysis");
    }
    const candidate = parsed as Partial<ReportOutputFeedback>;
    const score = typeof candidate.overallScore === "number" && Number.isFinite(candidate.overallScore)
      ? Math.min(10, Math.max(1, Math.round(candidate.overallScore)))
      : 5;
    return {
      summary: typeof candidate.summary === "string" && candidate.summary.trim()
        ? candidate.summary
        : "Анализ недоступен.",
      improvementPoints: Array.isArray(candidate.improvementPoints)
        ? candidate.improvementPoints.filter((point): point is string => typeof point === "string")
        : [],
      overallScore: score,
      kind: candidate.kind === "model" || candidate.kind === "fallback" || candidate.kind === "legacy"
        ? candidate.kind
        : undefined,
    };
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }
}
