import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Context } from "grammy";
import { AgentPersonalityPrompt, ILLMService, LLM_SERVICE } from "../../ai";
import { ConversationService } from "../../conversation";
import { PromptService } from "../../prompt";
import { RateLimitService } from "../../rate-limit";
import { GenerationClaim, ResponseService } from "../../response";
import { UserService } from "../../user";
import { PersonalityService } from "../../personality";
import { ErrorLogService, ObservabilityContextService } from "../../error-log";
import { ReportWorkflowService } from "../report-workflow.service";
import { readinessReply } from "../readiness-reply";

@Injectable()
export class ReportHandler {
  private readonly logger = new Logger(ReportHandler.name);
  private readonly workflow: ReportWorkflowService;

  constructor(
    private readonly userService: UserService,
    private readonly promptService: PromptService,
    private readonly responseService: ResponseService,
    private readonly conversationService: ConversationService,
    private readonly rateLimitService: RateLimitService,
    @Inject(LLM_SERVICE) private readonly llmService: ILLMService,
    @Optional() private readonly errorLog?: ErrorLogService,
    @Optional() private readonly observability?: ObservabilityContextService,
    injectedWorkflow?: ReportWorkflowService,
    @Optional() private readonly personalityService?: PersonalityService,
  ) {
    this.workflow = injectedWorkflow ?? new ReportWorkflowService(
      this.responseService,
      this.conversationService,
      this.llmService,
      this.errorLog,
      this.observability,
    );
  }

  async handle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;
    if (!telegramId) { this.logger.warn("Received /report without user id"); return; }
    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) { await ctx.reply("Пожалуйста, начните с команды /start"); return; }
    this.observability?.enrich({ userId: user.id, requestId: this.requestKey(ctx) });
    const admission = await this.rateLimitService.consumeLimit(user.id, "command");
    if (!admission.allowed) {
      await ctx.reply("Превышен лимит запросов. Попробуйте позже."); return;
    }
    const userPrompt = await this.promptService.getLatestUserPrompt(user.id);
    if (!userPrompt) { await ctx.reply("Нет активного разговора. Отправьте /start для начала."); return; }
    const messages = await this.conversationService.getMessages(userPrompt.id);
    const requestKey = this.requestKey(ctx);
    let personality: AgentPersonalityPrompt | undefined;
    try {
      personality = this.personalityService
        ? await this.personalityService.resolveSelectedOrDefault(user.agentTone)
        : undefined;
    } catch (error) {
      this.logger.error(`Failed to resolve personality (${this.errorKind(error)})`);
      await this.errorLog?.capture({
        type: "system", service: "general", operation: "report.personality.resolve",
        userId: user.id, requestId: requestKey, error, retryable: true,
      });
      await ctx.reply("😔 Произошла ошибка при формировании отчёта. Попробуйте ещё раз позже.");
      return;
    }
    let expectedLastMessageId: string | undefined;
    if (userPrompt.conversationStatus === "open" && messages.some((message) => message.role === "user")) {
      const typing = this.startTypingIndicator(ctx);
      try {
        const prompt = await this.promptService.getPromptById(userPrompt.promptId);
        const readiness = await this.llmService.assessConversation(messages.map((message) => ({
          role: message.role as "user" | "assistant", content: message.content,
        })), prompt?.textContent ?? "", prompt?.topic ?? "General", {
          userId: user.id, userPromptId: userPrompt.id, requestId: requestKey,
          correlationId: this.observability?.current()?.correlationId,
        }, personality!);
        if (!readiness.ready) {
          const latest = messages[messages.length - 1];
          if (latest?.role === "assistant" && latest.content.trim() === readiness.question.trim()) {
            await ctx.reply(readinessReply(readiness.question, readiness));
            return;
          }
          const inserted = await this.conversationService.addAssistantMessageIfOpen(
            userPrompt.id, readiness.question, latest.id,
          );
          if (inserted.outcome === "inserted") await ctx.reply(readinessReply(readiness.question, readiness));
          return;
        }
        expectedLastMessageId = messages[messages.length - 1]?.id;
      } catch (error) {
        await this.errorLog?.capture({
          type: "ai", service: "llm", operation: "report.readiness",
          userId: user.id, requestId: requestKey, error, retryable: true,
        });
        await ctx.reply("😔 Не удалось подготовить отчёт. Ваши ответы сохранены. Отправьте /report, чтобы повторить попытку.");
        return;
      } finally { clearInterval(typing); }
    }
    const result = await this.responseService.claimGeneration({
      userId: user.id, userPromptId: userPrompt.id,
      voiceFileId: messages.find((m) => m.role === "user")?.voiceFileId ?? "",
      generationRequestKey: requestKey,
      ...(expectedLastMessageId ? { expectedLastMessageId } : {}),
    });
    if (result.outcome === "stale") {
      await ctx.reply("Диалог изменился во время обработки. Отправьте /report ещё раз."); return;
    }
    if (result.outcome === "no_messages") {
      await ctx.reply("Вы ещё не отправили ни одного голосового сообщения в этом разговоре."); return;
    }
    if (result.outcome === "missing_prompt") {
      await ctx.reply("Нет активного разговора. Отправьте /start для начала."); return;
    }
    if (result.outcome === "busy") { await ctx.reply("Отчёт уже формируется. Пожалуйста, подождите."); return; }
    if (result.outcome === "failed_same_request") {
      await ctx.reply("😔 Этот запрос отчёта завершился ошибкой. Отправьте новую команду /report для повторной попытки."); return;
    }
    if (result.outcome === "generated") {
      if (result.response.sensitiveDataPurgedAt) {
        await ctx.reply(
          "Сохранённый отчёт больше недоступен: его данные удалены по сроку хранения. Начните новый разговор командой /start.",
        );
        return;
      }
      await this.workflow.deliverPersisted(ctx, result.response, requestKey); return;
    }
    const prompt = await this.promptService.getPromptById(userPrompt.promptId);
    const typing = this.startTypingIndicator(ctx);
    try {
      await this.generateClaimedReport(ctx, userPrompt.id, prompt?.topic ?? "General", personality, result.claim);
    } finally { clearInterval(typing); }
  }

  async generateClaimedReport(
    ctx: Context, userPromptId: string, topic: string, personality: AgentPersonalityPrompt | undefined, claim: GenerationClaim,
  ): Promise<void> {
    await this.workflow.generateClaimedReport(ctx, userPromptId, topic, personality, claim);
  }

  private requestKey(ctx: Context): string {
    const source = ctx.callbackQuery?.message;
    if (source) return `callback:${source.chat.id}:${source.message_id}`;
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
}
