import { Injectable, Inject, Logger } from "@nestjs/common";
import { Context } from "grammy";
import { UserService } from "../../user";
import { PromptService } from "../../prompt";
import { ResponseService } from "../../response";
import { RateLimitService } from "../../rate-limit";
import {
  WHISPER_SERVICE,
  IWhisperService,
  LLM_SERVICE,
  ILLMService,
  FeedbackResult,
} from "../../ai";

@Injectable()
export class VoiceHandler {
  private readonly logger = new Logger(VoiceHandler.name);

  constructor(
    private readonly userService: UserService,
    private readonly promptService: PromptService,
    private readonly responseService: ResponseService,
    private readonly rateLimitService: RateLimitService,
    @Inject(WHISPER_SERVICE)
    private readonly whisperService: IWhisperService,
    @Inject(LLM_SERVICE)
    private readonly llmService: ILLMService,
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

    const existingResponse =
      await this.responseService.getResponseByUserPromptId(userPrompt.id);

    if (existingResponse) {
      await ctx.reply(
        "Вы уже ответили на этот вопрос. Дождитесь следующего вопроса.",
      );
      return;
    }

    const prompt = await this.promptService.getPromptById(userPrompt.promptId);
    const topic = prompt?.topic ?? "General";

    await ctx.reply("⏳ Анализирую ваш ответ...");

    try {
      const audioBuffer = await this.downloadVoiceFile(ctx, voice.file_id);

      const { text: transcript } = await this.whisperService.transcribe(
        audioBuffer,
        "en",
      );

      this.logger.log(`Transcript: ${transcript.substring(0, 100)}...`);

      const response = await this.responseService.createResponse({
        userId: user.id,
        userPromptId: userPrompt.id,
        voiceFileId: voice.file_id,
      });

      const feedback = await this.llmService.analyzeSpeech(transcript, topic);

      await this.responseService.updateResponse(response.id, {
        transcript,
        analysis: JSON.stringify(feedback),
      });

      this.logger.log(`Processed voice response: ${response.id}`);

      const formattedFeedback = this.formatFeedback(feedback, transcript);
      await ctx.reply(formattedFeedback, { parse_mode: "HTML" });
    } catch (error) {
      this.logger.error("Failed to process voice message:", error);
      await ctx.reply(
        "😔 Произошла ошибка при анализе. Попробуйте ещё раз позже.",
      );
    }
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

  private formatFeedback(feedback: FeedbackResult, transcript: string): string {
    const lines: string[] = [];

    lines.push(`📝 <b>Ваш ответ:</b>`);
    lines.push(`<i>"${transcript}"</i>`);
    lines.push("");

    lines.push(`⭐ <b>Оценка: ${feedback.overallScore}/10</b>`);
    lines.push("");

    lines.push(`💬 <b>Общий комментарий:</b>`);
    lines.push(feedback.summary);

    if (feedback.grammarErrors.length > 0) {
      lines.push("");
      lines.push(`📚 <b>Грамматика:</b>`);
      feedback.grammarErrors.forEach((error) => {
        lines.push(`• ${error}`);
      });
    }

    if (feedback.pronunciationTips.length > 0) {
      lines.push("");
      lines.push(`🎤 <b>Произношение:</b>`);
      feedback.pronunciationTips.forEach((tip) => {
        lines.push(`• ${tip}`);
      });
    }

    if (feedback.vocabularySuggestions.length > 0) {
      lines.push("");
      lines.push(`📖 <b>Словарный запас:</b>`);
      feedback.vocabularySuggestions.forEach((suggestion) => {
        lines.push(`• ${suggestion}`);
      });
    }

    return lines.join("\n");
  }
}
