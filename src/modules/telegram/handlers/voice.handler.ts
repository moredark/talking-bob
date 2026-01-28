import { Injectable, Inject, Logger, forwardRef } from "@nestjs/common";
import { Context, InlineKeyboard } from "grammy";
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
  ) {}

  async handle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;
    const voice = ctx.message?.voice;

    if (!telegramId || !voice) {
      this.logger.warn("Received voice message without user or voice data");
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

    const typingInterval = this.startTypingIndicator(ctx);

    try {
      const audioBuffer = await this.downloadVoiceFile(ctx, voice.file_id);

      const { text: transcript } = await this.whisperService.transcribe(
        audioBuffer,
        "en",
      );

      this.logger.log(`Transcript: ${transcript.substring(0, 100)}...`);

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
        clearInterval(typingInterval);

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
      );

      await this.conversationService.addMessage(
        userPrompt.id,
        "assistant",
        followUp,
      );

      clearInterval(typingInterval);

      const keyboard = new InlineKeyboard().text(
        "📊 Получить отчёт",
        "report",
      );

      await ctx.reply(followUp, { reply_markup: keyboard });
    } catch (error) {
      clearInterval(typingInterval);
      this.logger.error("Failed to process voice message:", error);
      await ctx.reply(
        "😔 Произошла ошибка при обработке. Попробуйте ещё раз позже.",
      );
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

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
