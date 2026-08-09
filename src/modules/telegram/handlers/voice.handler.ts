import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Context, InlineKeyboard } from "grammy";
import { RUNTIME_CONFIG } from "../../../config/runtime-config.module";
import { RuntimeConfig } from "../../../config/runtime.config";
import { boundedFetch } from "../../../infrastructure/http";
import { UserService } from "../../user";
import { PromptService } from "../../prompt";
import { ConversationService } from "../../conversation";
import { RateLimitService } from "../../rate-limit";
import {
  WHISPER_SERVICE, IWhisperService, LLM_SERVICE, ILLMService,
  ConversationMessage, AgentTone,
} from "../../ai";
import { ReportWorkflowService } from "../report-workflow.service";
import { ErrorLogService, ObservabilityContextService } from "../../error-log";

type VoiceProcessingStage =
  | "telegram_download"
  | "whisper_transcribe"
  | "conversation_accept"
  | "report_generate"
  | "conversation_history"
  | "llm_follow_up"
  | "conversation_persist"
  | "telegram_reply";

@Injectable()
export class VoiceHandler {
  private readonly logger = new Logger(VoiceHandler.name);
  constructor(
    private readonly userService: UserService,
    private readonly promptService: PromptService,
    private readonly conversationService: ConversationService,
    private readonly rateLimitService: RateLimitService,
    @Inject(WHISPER_SERVICE) private readonly whisperService: IWhisperService,
    @Inject(LLM_SERVICE) private readonly llmService: ILLMService,
    private readonly reportWorkflow: ReportWorkflowService,
    @Inject(RUNTIME_CONFIG) private readonly runtimeConfig: RuntimeConfig,
    @Optional() private readonly errorLog?: ErrorLogService,
    @Optional() private readonly observability?: ObservabilityContextService,
  ) {}

  async handle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;
    const voice = ctx.message?.voice;
    if (!telegramId || !voice) {
      this.logger.warn("Received voice message without user or voice data"); return;
    }
    if (voice.duration > this.runtimeConfig.voice.maxDurationSeconds) {
      await ctx.reply(`Голосовое сообщение слишком длинное. Максимум — ${this.runtimeConfig.voice.maxDurationSeconds} секунд.`);
      return;
    }
    if (typeof voice.file_size === "number" && voice.file_size > this.runtimeConfig.voice.maxFileSizeBytes) {
      await ctx.reply(`Голосовое сообщение слишком большое. Максимум — ${this.formatByteLimit(this.runtimeConfig.voice.maxFileSizeBytes)}.`);
      return;
    }
    const user = await this.userService.findByTelegramId(BigInt(telegramId));
    if (!user) { await ctx.reply("Пожалуйста, начните с команды /start"); return; }
    this.observability?.enrich({ userId: user.id, requestId: this.requestKey(ctx) });

    const userPrompt = await this.promptService.getLatestUserPrompt(user.id);
    if (!userPrompt) {
      await ctx.reply("Сначала получите вопрос от бота. Отправьте /start для начала."); return;
    }
    const updateId = BigInt(ctx.update.update_id);
    const precheck = await this.conversationService.precheckVoiceAcceptance(userPrompt.id, updateId);
    if (precheck.outcome === "duplicate") return;
    if (precheck.outcome === "closed") { await this.replyConversationClosed(ctx); return; }

    const admission = await this.rateLimitService.consumeLimit(user.id, "voice_response");
    if (!admission.allowed) {
      await ctx.reply("Превышен лимит голосовых сообщений. Попробуйте позже."); return;
    }
    const prompt = await this.promptService.getPromptById(userPrompt.promptId);
    const topic = prompt?.topic ?? "General";
    const tone: AgentTone = user.agentTone === "playful" ? "playful" : "friendly";
    const typing = this.startTypingIndicator(ctx);
    const startedAt = Date.now();
    let stage: VoiceProcessingStage = "telegram_download";

    try {
      const audio = await this.downloadVoiceFile(ctx, voice.file_id);
      stage = "whisper_transcribe";
      const { text: transcript } = await this.whisperService.transcribe(audio, "en");
      stage = "conversation_accept";
      const accepted = await this.conversationService.acceptVoiceAndMaybeClaimGeneration({
        userId: user.id, userPromptId: userPrompt.id, content: transcript,
        voiceFileId: voice.file_id, telegramUpdateId: updateId,
        generationRequestKey: this.requestKey(ctx),
      });
      if (accepted.outcome === "duplicate") return;
      if (accepted.outcome === "closed") { await this.replyConversationClosed(ctx); return; }
      if (accepted.generationClaim) {
        stage = "report_generate";
        await this.reportWorkflow.generateClaimedReport(
          ctx, userPrompt.id, topic, tone, accepted.generationClaim,
        );
        return;
      }
      if (accepted.userMessageCount >= 3) return;

      stage = "conversation_history";
      const messages = await this.conversationService.getMessages(userPrompt.id);
      const history: ConversationMessage[] = messages.map((message) => ({
        role: message.role as "user" | "assistant", content: message.content,
      }));
      stage = "llm_follow_up";
      const followUp = await this.llmService.generateFollowUp(history, topic, tone);
      stage = "conversation_persist";
      const inserted = await this.conversationService.addAssistantMessageIfOpen(
        userPrompt.id, followUp, accepted.message.id,
      );
      if (inserted.outcome !== "inserted") return;
      const keyboard = new InlineKeyboard().text("📊 Получить отчёт", "report");
      stage = "telegram_reply";
      await ctx.reply(followUp, { reply_markup: keyboard });
    } catch (error) {
      const attribution = this.failureAttribution(stage);
      this.logger.error(
        `Failed to process voice message at ${stage} (${this.errorKind(error)})`,
      );
      await this.errorLog?.capture({
        type: attribution.type,
        service: attribution.service,
        operation: "voice.process",
        userId: user.id,
        requestId: this.requestKey(ctx),
        latencyMs: Date.now() - startedAt,
        error,
        retryable: attribution.retryable,
      });
      await ctx.reply("😔 Произошла ошибка при обработке. Попробуйте ещё раз позже.");
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

  private async downloadVoiceFile(ctx: Context, fileId: string): Promise<Buffer> {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error("File path not available");
    const url = `https://api.telegram.org/file/bot${this.runtimeConfig.telegramBotToken}/${file.file_path}`;
    const response = await boundedFetch(url, {
      timeoutMs: this.runtimeConfig.externalRequests.telegramFileDownload.timeoutMs,
      maxResponseBytes: Math.min(
        this.runtimeConfig.voice.maxFileSizeBytes,
        this.runtimeConfig.externalRequests.telegramFileDownload.maxResponseBytes,
      ),
      safeToRetry: true,
    });
    if (!response.ok) throw new Error(`Telegram file download failed with ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }
  private failureAttribution(stage: VoiceProcessingStage): {
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
  private formatByteLimit(bytes: number): string {
    const mebibyte = 1024 * 1024;
    const kibibyte = 1024;
    if (bytes >= mebibyte) {
      const value = bytes / mebibyte;
      return `${Number.isInteger(value) ? value : value.toFixed(1)} МиБ`;
    }
    if (bytes >= kibibyte) return `${Math.ceil(bytes / kibibyte)} КиБ`;
    return `${bytes} байт`;
  }
}
