import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Context, InlineKeyboard } from "grammy";
import { UserService } from "../user";
import { PromptService } from "../prompt";
import { ConversationService } from "../conversation";
import { RateLimitService } from "../rate-limit";
import {
  LLM_SERVICE, ILLMService,
  ConversationMessage,
} from "../ai";
import { ReportWorkflowService } from "./report-workflow.service";
import { PersonalityService } from "../personality";
import { ErrorLogService, ObservabilityContextService } from "../error-log";
import { AmbiguousSpokenReplyDeliveryError, SpokenReplyService } from "./spoken-reply.service";
import { readinessExplanation } from "./readiness-reply";

export type ReplyProcessingStage =
  | "personality_resolve"
  | "telegram_download"
  | "whisper_transcribe"
  | "conversation_accept"
  | "report_generate"
  | "conversation_history"
  | "llm_follow_up"
  | "conversation_persist"
  | "telegram_reply";

@Injectable()
export class PracticeReplyWorkflowService {
  private readonly logger = new Logger(PracticeReplyWorkflowService.name);
  constructor(
    private readonly userService: UserService,
    private readonly promptService: PromptService,
    private readonly conversationService: ConversationService,
    private readonly rateLimitService: RateLimitService,
    @Inject(LLM_SERVICE) private readonly llmService: ILLMService,
    private readonly reportWorkflow: ReportWorkflowService,
    @Optional() private readonly errorLog?: ErrorLogService,
    @Optional() private readonly observability?: ObservabilityContextService,
    @Optional() private readonly personalityService?: PersonalityService,
    @Optional() private readonly spokenReply?: SpokenReplyService,
  ) {}

  async handle(
    ctx: Context,
    kind: "voice" | "text",
    prepare: (stage: (value: ReplyProcessingStage) => void) => Promise<string>,
    voiceFileId?: string,
  ): Promise<void> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) { await ctx.reply("Пожалуйста, начните с команды /start"); return; }
    this.observability?.enrich({ userId: user.id, requestId: this.requestKey(ctx) });

    const userPrompt = await this.promptService.getLatestUserPrompt(user.id);
    if (!userPrompt) {
      await ctx.reply("Сначала получите вопрос от бота. Отправьте /start для начала."); return;
    }
    const updateId = BigInt(ctx.update.update_id);
    const precheck = await this.conversationService.precheckReplyAcceptance(userPrompt.id, updateId);
    if (precheck.outcome === "duplicate") return;
    if (precheck.outcome === "closed") { await this.replyConversationClosed(ctx); return; }

    const admission = await this.rateLimitService.consumeLimit(user.id, "voice_response");
    if (!admission.allowed) {
      await ctx.reply("Превышен лимит ответов голосом и текстом. Попробуйте позже."); return;
    }
    const prompt = await this.promptService.getPromptById(userPrompt.promptId);
    const topic = prompt?.topic ?? "General";
    const typing = this.startTypingIndicator(ctx);
    const startedAt = Date.now();
    let stage: ReplyProcessingStage = "personality_resolve";
    let savedForReadinessRetry = false;

    try {
      const personality = this.personalityService
        ? await this.personalityService.resolveSelectedOrDefault(user.agentTone)
        : undefined;
      const transcript = await prepare((value) => { stage = value; });
      stage = "conversation_history";
      const previousMessages = await this.conversationService.getMessages(userPrompt.id);
      const needsReadiness = previousMessages.filter((message) => message.role === "user").length >= 2;
      stage = "llm_follow_up";
      let readinessError: unknown;
      const readiness = needsReadiness ? await this.llmService.assessConversation(
        [...previousMessages.map((message) => ({
          role: message.role as "user" | "assistant", content: message.content,
        })), { role: "user", content: transcript }],
        prompt?.textContent ?? "", topic, {
          userId: user.id, userPromptId: userPrompt.id, requestId: this.requestKey(ctx),
          correlationId: this.observability?.current()?.correlationId,
        }, personality!,
      ).catch((error: unknown) => {
        readinessError = error;
        return { ready: false, lastQuestionAnswered: false, question: "" };
      }) : undefined;
      stage = "conversation_accept";
      const accepted = await this.conversationService.acceptReplyAndMaybeClaimGeneration({
        userId: user.id, userPromptId: userPrompt.id, content: transcript,
        voiceFileId, telegramUpdateId: updateId,
        generationRequestKey: this.requestKey(ctx),
        readiness: {
          ready: readiness?.ready ?? false,
          expectedLastMessageId: previousMessages[previousMessages.length - 1]?.id ?? null,
        },
      });
      if (accepted.outcome === "duplicate") return;
      if (accepted.outcome === "stale") {
        await ctx.reply("Диалог изменился во время обработки. Пожалуйста, отправьте ответ ещё раз."); return;
      }
      if (accepted.outcome === "closed") { await this.replyConversationClosed(ctx); return; }
      if (readinessError) {
        savedForReadinessRetry = true;
        stage = "llm_follow_up";
        throw readinessError;
      }
      if (accepted.generationClaim) {
        stage = "report_generate";
        await this.reportWorkflow.generateClaimedReport(
          ctx, userPrompt.id, topic, personality, accepted.generationClaim,
        );
        return;
      }

      stage = "conversation_history";
      const messages = await this.conversationService.getMessages(userPrompt.id);
      const history: ConversationMessage[] = messages.map((message) => ({
        role: message.role as "user" | "assistant", content: message.content,
      }));
      if (prompt?.textContent) history.unshift({ role: "assistant", content: prompt.textContent });
      stage = "llm_follow_up";
      const followUp = readiness && !readiness.ready ? readiness.question : await this.llmService.generateFollowUp(history, topic, personality, {
        userId: user.id, userPromptId: userPrompt.id, requestId: this.requestKey(ctx),
        correlationId: this.observability?.current()?.correlationId,
      });
      stage = "conversation_persist";
      const inserted = await this.conversationService.addAssistantMessageIfOpen(
        userPrompt.id, followUp, accepted.message.id,
      );
      if (inserted.outcome !== "inserted") return;
      const keyboard = new InlineKeyboard().text("📊 Получить отчёт", "report");
      stage = "telegram_reply";
      if (readiness && !readiness.ready) {
        try {
          await ctx.reply(readinessExplanation(readiness));
        } catch (error) {
          this.logger.warn(`Failed to send readiness explanation (${this.errorKind(error)})`);
        }
      }
      if (this.spokenReply) {
        await this.spokenReply.send(ctx, followUp, keyboard);
      } else {
        await ctx.reply(followUp, { reply_markup: keyboard });
      }
    } catch (error) {
      const attribution = this.failureAttribution(stage);
      this.logger.error(
        `Failed to process ${kind} reply at ${stage} (${this.errorKind(error)})`,
      );
      await this.errorLog?.capture({
        type: attribution.type,
        service: attribution.service,
        operation: `${kind}.process`,
        userId: user.id,
        requestId: this.requestKey(ctx),
        latencyMs: Date.now() - startedAt,
        error,
        retryable: attribution.retryable,
      });
      if (!(error instanceof AmbiguousSpokenReplyDeliveryError)) {
        await ctx.reply(savedForReadinessRetry
          ? "😔 Не удалось подготовить отчёт. Ваш ответ сохранён. Отправьте /report, чтобы повторить попытку."
          : "😔 Произошла ошибка при обработке. Попробуйте ещё раз позже.");
      }
    } finally { clearInterval(typing); }
  }

  private async replyConversationClosed(ctx: Context): Promise<void> {
    const keyboard = new InlineKeyboard().text("🎤 Новый вопрос", "new_question");
    await ctx.reply("Этот разговор уже завершён. Начните новый вопрос.", { reply_markup: keyboard });
  }

  private requestKey(ctx: Context): string {
    if (ctx.message) return `message:${ctx.message.chat.id}:${ctx.message.message_id}`;
    return `update:${ctx.update.update_id}`;
  }

  private startTypingIndicator(ctx: Context): NodeJS.Timeout {
    const chatId = ctx.chat!.id;
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    return setInterval(() => ctx.api.sendChatAction(chatId, "typing").catch(() => {}), 4000);
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }
  private failureAttribution(stage: ReplyProcessingStage): {
    type: "ai" | "telegram" | "system";
    service: "whisper" | "llm" | "telegram" | "general";
    retryable: boolean;
  } {
    if (stage === "whisper_transcribe") {
      return { type: "ai", service: "whisper", retryable: true };
    }
    if (stage === "llm_follow_up") {
      return { type: "ai", service: "llm", retryable: true };
    }
    if (stage === "telegram_download" || stage === "telegram_reply") {
      return { type: "telegram", service: "telegram", retryable: true };
    }
    return { type: "system", service: "general", retryable: true };
  }
}
