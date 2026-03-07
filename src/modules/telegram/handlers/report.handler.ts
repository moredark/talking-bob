import { Injectable, Inject, Logger } from "@nestjs/common";
import { Context, InlineKeyboard } from "grammy";
import { UserService } from "../../user";
import { PromptService } from "../../prompt";
import { ResponseService } from "../../response";
import { ConversationService } from "../../conversation";
import { RateLimitService } from "../../rate-limit";
import {
  LLM_SERVICE,
  ILLMService,
  FeedbackResult,
  AgentTone,
} from "../../ai";

@Injectable()
export class ReportHandler {
  private readonly logger = new Logger(ReportHandler.name);

  constructor(
    private readonly userService: UserService,
    private readonly promptService: PromptService,
    private readonly responseService: ResponseService,
    private readonly conversationService: ConversationService,
    private readonly rateLimitService: RateLimitService,
    @Inject(LLM_SERVICE)
    private readonly llmService: ILLMService,
  ) {}

  async handle(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      this.logger.warn("Received /report without user id");
      return;
    }

    const user = await this.userService.findByTelegramId(BigInt(telegramId));

    if (!user) {
      await ctx.reply("Пожалуйста, начните с команды /start");
      return;
    }

    const isAllowed = await this.rateLimitService.checkLimit(
      user.id,
      "command",
    );

    if (!isAllowed) {
      await ctx.reply("Превышен лимит запросов. Попробуйте позже.");
      return;
    }

    await this.rateLimitService.recordAction(user.id, "command");

    const userPrompt = await this.promptService.getLatestUserPrompt(user.id);

    if (!userPrompt) {
      await ctx.reply("Нет активного разговора. Отправьте /start для начала.");
      return;
    }

    const messages = await this.conversationService.getMessages(userPrompt.id);
    const userMessages = messages.filter((m) => m.role === "user");

    if (userMessages.length === 0) {
      await ctx.reply("Вы ещё не отправили ни одного голосового сообщения в этом разговоре.");
      return;
    }

    const existingResponse = await this.responseService.getResponseByUserPromptId(
      userPrompt.id,
    );

    if (existingResponse) {
      await ctx.reply("Отчёт по этому разговору уже был сформирован. Отправьте /start для нового вопроса.");
      return;
    }

    const prompt = await this.promptService.getPromptById(userPrompt.promptId);
    const topic = prompt?.topic ?? "General";
    const tone: AgentTone =
      user.agentTone === "playful" ? "playful" : "friendly";

    await this.generateReport(
      ctx,
      user.id,
      userPrompt.id,
      topic,
      userMessages,
      tone,
    );
  }

  async generateReport(
    ctx: Context,
    userId: string,
    userPromptId: string,
    topic: string,
    userMessages: Array<{ content: string; voiceFileId: string | null }>,
    tone: AgentTone = "friendly",
  ): Promise<void> {
    const typingInterval = this.startTypingIndicator(ctx);

    try {
      const fullTranscript = userMessages
        .map((m) => m.content)
        .join(" ");

      const feedback = await this.llmService.analyzeSpeech(
        fullTranscript,
        topic,
        "en",
        tone,
      );

      const response = await this.responseService.createResponse({
        userId,
        userPromptId,
        voiceFileId: userMessages[0].voiceFileId || "",
      });

      await this.responseService.updateResponse(response.id, {
        transcript: fullTranscript,
        analysis: JSON.stringify(feedback),
      });

      clearInterval(typingInterval);

      const formattedFeedback = this.formatFeedback(feedback, fullTranscript);
      await ctx.reply(formattedFeedback, { parse_mode: "HTML" });

      const keyboard = new InlineKeyboard().text(
        "🎤 Новый вопрос",
        "new_question",
      );

      await ctx.reply("Готово! Хотите продолжить практику?", {
        reply_markup: keyboard,
      });
    } catch (error) {
      clearInterval(typingInterval);
      this.logger.error("Failed to generate report:", error);
      await ctx.reply(
        "😔 Произошла ошибка при формировании отчёта. Попробуйте позже.",
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

  private formatFeedback(feedback: FeedbackResult, transcript: string): string {
    const lines: string[] = [];

    lines.push(`📝 <b>Ваш ответ:</b>`);
    lines.push(`<i>"${transcript}"</i>`);
    lines.push("");

    lines.push(`⭐ <b>Оценка: ${feedback.overallScore}/10</b>`);
    lines.push("");

    lines.push(`💬 <b>Комментарий:</b>`);
    lines.push(feedback.summary);

    if (feedback.improvementPoints.length > 0) {
      lines.push("");
      lines.push(`📌 <b>Разбор ошибок и улучшений:</b>`);
      feedback.improvementPoints.forEach((point) => {
        lines.push(`• ${point}`);
      });
    }

    return lines.join("\n");
  }
}
