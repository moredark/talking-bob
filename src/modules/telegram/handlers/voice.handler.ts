import { Injectable, Inject, Logger, forwardRef } from "@nestjs/common";
import { Context, InlineKeyboard } from "grammy";
import { RUNTIME_CONFIG } from "../../../config/runtime-config.module";
import { RuntimeConfig } from "../../../config/runtime.config";
import { boundedFetch } from "../../../infrastructure/http";
import { UserService } from "../../user";
import { PromptService } from "../../prompt";
import { ConversationService } from "../../conversation";
import { RateLimitService } from "../../rate-limit";
import {
  WHISPER_SERVICE,
  IWhisperService,
  LLM_SERVICE,
  ILLMService,
  ConversationMessage,
  AgentTone,
} from "../../ai";
import { ReportHandler } from "./report.handler";

const AUTO_REPORT_AFTER_MESSAGES = 3;

@Injectable()
export class VoiceHandler {
  private readonly logger = new Logger(VoiceHandler.name);

  constructor(
    private readonly userService: UserService,
    private readonly promptService: PromptService,
    private readonly conversationService: ConversationService,
    private readonly rateLimitService: RateLimitService,
    @Inject(WHISPER_SERVICE)
    private readonly whisperService: IWhisperService,
    @Inject(LLM_SERVICE)
    private readonly llmService: ILLMService,
    @Inject(forwardRef(() => ReportHandler))
    private readonly reportHandler: ReportHandler,
    @Inject(RUNTIME_CONFIG) private readonly runtimeConfig: RuntimeConfig,
  ) {}

  async handle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;
    const voice = ctx.message?.voice;

    if (!telegramId || !voice) {
      this.logger.warn("Received voice message without user or voice data");
      return;
    }

    if (voice.duration > this.runtimeConfig.voice.maxDurationSeconds) {
      await ctx.reply(
        `Голосовое сообщение слишком длинное. Максимум — ${this.runtimeConfig.voice.maxDurationSeconds} секунд.`,
      );
      return;
    }

    if (
      typeof voice.file_size === "number" &&
      voice.file_size > this.runtimeConfig.voice.maxFileSizeBytes
    ) {
      await ctx.reply(
        `Голосовое сообщение слишком большое. Максимум — ${this.formatByteLimit(this.runtimeConfig.voice.maxFileSizeBytes)}.`,
      );
      return;
    }

    const user = await this.userService.findByTelegramId(BigInt(telegramId));

    if (!user) {
      await ctx.reply("Пожалуйста, начните с команды /start");
      return;
    }

    const isAllowed = await this.rateLimitService.checkLimit(
      user.id,
      "voice_response",
    );

    if (!isAllowed) {
      await ctx.reply("Превышен лимит голосовых сообщений. Попробуйте позже.");
      return;
    }

    await this.rateLimitService.recordAction(user.id, "voice_response");

    const userPrompt = await this.promptService.getLatestUserPrompt(user.id);

    if (!userPrompt) {
      await ctx.reply(
        "Сначала получите вопрос от бота. Отправьте /start для начала.",
      );
      return;
    }

    const prompt = await this.promptService.getPromptById(userPrompt.promptId);
    const topic = prompt?.topic ?? "General";
    const tone: AgentTone =
      user.agentTone === "playful" ? "playful" : "friendly";

    const typingInterval = this.startTypingIndicator(ctx);

    try {
      const audioBuffer = await this.downloadVoiceFile(ctx, voice.file_id);

      const { text: transcript } = await this.whisperService.transcribe(
        audioBuffer,
        "en",
      );

      await this.conversationService.addMessage(
        userPrompt.id,
        "user",
        transcript,
        voice.file_id,
      );

      const existingMessages = await this.conversationService.getMessages(
        userPrompt.id,
      );

      const userMessages = existingMessages.filter((m) => m.role === "user");

      if (userMessages.length >= AUTO_REPORT_AFTER_MESSAGES) {
        const formattedUserMessages = userMessages.map((m) => ({
          content: m.content,
          voiceFileId: m.voiceFileId,
        }));

        await this.reportHandler.generateReport(
          ctx,
          user.id,
          userPrompt.id,
          topic,
          formattedUserMessages,
          tone,
        );
        return;
      }

      const conversationHistory: ConversationMessage[] = existingMessages.map(
        (msg) => ({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        }),
      );

      const followUp = await this.llmService.generateFollowUp(
        conversationHistory,
        topic,
        tone,
      );

      await this.conversationService.addMessage(
        userPrompt.id,
        "assistant",
        followUp,
      );

      const keyboard = new InlineKeyboard().text(
        "📊 Получить отчёт",
        "report",
      );

      await ctx.reply(followUp, { reply_markup: keyboard });
    } catch (error) {
      this.logger.error(
        `Failed to process voice message (${this.errorKind(error)})`,
      );
      await ctx.reply(
        "😔 Произошла ошибка при обработке. Попробуйте ещё раз позже.",
      );
    } finally {
      clearInterval(typingInterval);
    }
  }

  private startTypingIndicator(ctx: Context): NodeJS.Timeout {
    const chatId = ctx.chat!.id;
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    return setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
  }

  private async downloadVoiceFile(
    ctx: Context,
    fileId: string,
  ): Promise<Buffer> {
    const file = await ctx.api.getFile(fileId);
    const filePath = file.file_path;

    if (!filePath) {
      throw new Error("File path not available");
    }

    const fileUrl = `https://api.telegram.org/file/bot${this.runtimeConfig.telegramBotToken}/${filePath}`;

    const response = await boundedFetch(fileUrl, {
      timeoutMs:
        this.runtimeConfig.externalRequests.telegramFileDownload.timeoutMs,
      maxResponseBytes: Math.min(
        this.runtimeConfig.voice.maxFileSizeBytes,
        this.runtimeConfig.externalRequests.telegramFileDownload
          .maxResponseBytes,
      ),
      safeToRetry: true,
    });
    if (!response.ok) {
      throw new Error(`Telegram file download failed with ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }

  private formatByteLimit(bytes: number): string {
    const mebibyte = 1024 * 1024;
    const kibibyte = 1024;
    if (bytes >= mebibyte) {
      const value = bytes / mebibyte;
      return `${Number.isInteger(value) ? value : value.toFixed(1)} МиБ`;
    }
    if (bytes >= kibibyte) {
      return `${Math.ceil(bytes / kibibyte)} КиБ`;
    }
    return `${bytes} байт`;
  }
}
