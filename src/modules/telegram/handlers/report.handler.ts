import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Context } from "grammy";
import { AgentTone, ILLMService, LLM_SERVICE } from "../../ai";
import { ConversationService } from "../../conversation";
import { PromptService } from "../../prompt";
import { RateLimitService } from "../../rate-limit";
import { GenerationClaim, ResponseService } from "../../response";
import { UserService } from "../../user";
import { ErrorLogService, ObservabilityContextService } from "../../error-log";
import { ReportWorkflowService } from "../report-workflow.service";

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
    const result = await this.responseService.claimGeneration({
      userId: user.id, userPromptId: userPrompt.id,
      voiceFileId: messages.find((m) => m.role === "user")?.voiceFileId ?? "",
      generationRequestKey: requestKey,
    });
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
    const tone: AgentTone = user.agentTone === "playful" ? "playful" : "friendly";
    const typing = this.startTypingIndicator(ctx);
    try {
      await this.generateClaimedReport(ctx, userPrompt.id, prompt?.topic ?? "General", tone, result.claim);
    } finally { clearInterval(typing); }
  }

  async generateClaimedReport(
    ctx: Context, userPromptId: string, topic: string, tone: AgentTone, claim: GenerationClaim,
  ): Promise<void> {
    await this.workflow.generateClaimedReport(ctx, userPromptId, topic, tone, claim);
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
}
