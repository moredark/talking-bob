import { Injectable, Logger } from "@nestjs/common";
import {
  AgentTone,
  ILLMService,
  FeedbackResult,
  ConversationMessage,
} from "../interfaces";

const ANALYSIS_SCHEMA_PROMPT = `Return ONLY valid JSON:
{
  "summary": "Короткий комментарий на русском (1 предложение)",
  "improvementPoints": ["Список ошибок/улучшений без дублей, на русском"],
  "overallScore": 7
}

Rules:
- overallScore: integer from 1 to 10
- one combined list in improvementPoints
- no duplicates
- if no issues, improvementPoints must be []`;

@Injectable()
export class LLMService implements ILLMService {
  private readonly logger = new Logger(LLMService.name);
  private readonly apiUrl =
    process.env.LLM_API_URL ||
    "https://foundation-models.api.cloud.ru/v1/chat/completions";
  private readonly model = process.env.LLM_MODEL || "zai-org/GLM-4.7";
  private readonly analysisMaxTokens = Number(
    process.env.LLM_ANALYSIS_MAX_TOKENS || 2500,
  );
  private readonly followUpMaxTokens = Number(
    process.env.LLM_FOLLOWUP_MAX_TOKENS || 1200,
  );
  private readonly defaultFollowUp =
    "Thanks for your answer. Could you tell me a bit more and give one specific example?";

  async analyzeSpeech(
    transcript: string,
    topic: string,
    targetLanguage: string = "en",
    tone: AgentTone = "friendly",
  ): Promise<FeedbackResult> {
    const apiKey = process.env.CLOUD_RU_API_KEY;

    if (!apiKey) {
      throw new Error("CLOUD_RU_API_KEY is not defined");
    }

    const systemPrompt = this.buildAnalysisSystemPrompt(tone);

    const userPrompt = `Topic: "${topic}"\nStudent: "${this.shortenText(transcript, 1800)}"\nAnalyze this English speech.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const attempts = [
      { temperature: 0.5, maxTokens: this.analysisMaxTokens },
      { temperature: 0.3, maxTokens: this.analysisMaxTokens + 500 },
    ];

    try {
      for (let i = 0; i < attempts.length; i += 1) {
        const attempt = attempts[i];

        const response = await fetch(this.apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: attempt.temperature,
            top_p: 0.95,
            presence_penalty: 0,
            max_tokens: attempt.maxTokens,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`LLM API error: ${response.status} - ${errorText}`);
          throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        const content = this.extractMessageContent(data);
        const finishReason = data.choices?.[0]?.finish_reason ?? "unknown";
        const completionTokens = data?.usage?.completion_tokens ?? "unknown";

        if (content) {
          const feedback = this.parseJsonResponse(content);
          this.logger.log(`Analysis complete, score: ${feedback.overallScore}`);
          return feedback;
        }

        this.logger.warn(
          `Analysis response is empty on attempt ${i + 1}/${attempts.length}. finish_reason=${finishReason}, completion_tokens=${completionTokens}`,
        );
      }

      this.logger.error(
        "LLM response has no readable content after retries. Using fallback analysis.",
      );
      return this.createFallbackFeedback(transcript);
    } catch (error) {
      this.logger.error("Speech analysis failed:", error);
      return this.createFallbackFeedback(transcript);
    }
  }

  async generateFollowUp(
    conversationHistory: ConversationMessage[],
    topic: string,
    tone: AgentTone = "friendly",
  ): Promise<string> {
    const apiKey = process.env.CLOUD_RU_API_KEY;

    if (!apiKey) {
      throw new Error("CLOUD_RU_API_KEY is not defined");
    }

    const recentHistory = conversationHistory
      .slice(-6)
      .map((msg) => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: this.shortenText(msg.content, 400),
      }));

    const messages = [
      {
        role: "system",
        content: `${this.buildFollowUpSystemPrompt(tone)}\n\nConversation topic: "${topic}"`,
      },
      ...recentHistory,
    ];

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.5,
          top_p: 0.95,
          presence_penalty: 0,
          max_tokens: this.followUpMaxTokens,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`LLM API error: ${response.status} - ${errorText}`);
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json();
      const content = this.extractMessageContent(data);
      const completionTokens = data?.usage?.completion_tokens ?? "unknown";

      if (!content) {
        this.logger.warn(
          `Follow-up response is empty, using fallback. finish_reason=${data.choices?.[0]?.finish_reason ?? "unknown"}, completion_tokens=${completionTokens}`,
        );
        return this.defaultFollowUp;
      }

      return content;
    } catch (error) {
      this.logger.error("Follow-up generation failed:", error);
      return this.defaultFollowUp;
    }
  }

  private extractMessageContent(data: any): string | null {
    const message = data?.choices?.[0]?.message;
    const content = message?.content;

    if (typeof content === "string") {
      const normalized = content.trim();
      return normalized.length > 0 ? normalized : null;
    }

    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          if (typeof part?.value === "string") return part.value;
          return "";
        })
        .join(" ")
        .trim();

      return text.length > 0 ? text : null;
    }

    if (typeof message?.refusal === "string" && message.refusal.trim()) {
      return message.refusal.trim();
    }

    const outputText = data?.output_text;
    if (typeof outputText === "string" && outputText.trim()) {
      return outputText.trim();
    }

    return null;
  }

  private buildFollowUpSystemPrompt(tone: AgentTone): string {
    const basePrompt = `You are an English speaking partner.
Rules:
- English only
- 1 short follow-up question
- max 2 short sentences
- no grammar correction in this step`;

    if (tone === "playful") {
      return `${basePrompt}
- Use playful, slightly teasing humor, but stay supportive and never insulting
- Accept slang and informal speech naturally
- If slang appears, briefly explain or extend it with another useful slang phrase`;
    }

    return `${basePrompt}
- Be encouraging and warm, like a friendly teacher
- If the student's response is very short or unclear, gently encourage them to elaborate`;
  }

  private buildAnalysisSystemPrompt(tone: AgentTone): string {
    const basePrompt = `You are an English tutor for Russian speakers.
Respond in Russian.
${ANALYSIS_SCHEMA_PROMPT}`;

    if (tone === "playful") {
      return `${basePrompt}
Style rules for "playful" tone:
- Use light playful humor in wording, with a bit of cheeky style
- Do not shame or insult the student
- Do not criticize slang or informal wording
- Treat slang as valid conversational English and, when helpful, suggest extra slang alternatives`;
    }

    return `${basePrompt}
Style rules for "friendly" tone:
- Be encouraging, clear, and kind
- Use calm teacher-like explanations`;
  }

  private parseJsonResponse(content: string): FeedbackResult {
    const cleanedContent = this.stripCodeFences(content);

    try {
      const parsedFromWhole = this.tryParseJson(cleanedContent);
      if (parsedFromWhole) {
        return {
          summary: this.normalizeSummary(parsedFromWhole.summary),
          improvementPoints: this.extractImprovementPoints(parsedFromWhole),
          overallScore: Math.min(
            10,
            Math.max(1, Number(parsedFromWhole.overallScore) || 5),
          ),
        };
      }

      const jsonCandidate = this.extractFirstJsonObject(cleanedContent);
      const parsedFromCandidate = jsonCandidate
        ? this.tryParseJson(jsonCandidate)
        : null;

      if (parsedFromCandidate) {
        return {
          summary: this.normalizeSummary(parsedFromCandidate.summary),
          improvementPoints: this.extractImprovementPoints(parsedFromCandidate),
          overallScore: Math.min(
            10,
            Math.max(1, Number(parsedFromCandidate.overallScore) || 5),
          ),
        };
      }

      throw new Error("No valid JSON found in model response");
    } catch {
      this.logger.warn("Failed to parse JSON response, using fallback");

      const extractedSummary = this.extractSummaryFromText(cleanedContent);
      const extractedPoints = this.extractPointsFromText(cleanedContent);

      return {
        summary:
          extractedSummary ||
          "Не удалось корректно разобрать структурированный ответ модели. Ниже базовый разбор.",
        improvementPoints: extractedPoints,
        overallScore: 5,
      };
    }
  }

  private stripCodeFences(content: string): string {
    return content
      .trim()
      .replace(/^```[a-zA-Z]*\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  private tryParseJson(value: string): any | null {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private extractFirstJsonObject(text: string): string | null {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === "{") {
        if (depth === 0) {
          start = i;
        }
        depth += 1;
        continue;
      }

      if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  private normalizeSummary(value: unknown): string {
    if (typeof value !== "string") {
      return "Анализ недоступен";
    }

    const summary = value.trim();
    if (!summary) {
      return "Анализ недоступен";
    }

    return summary.length > 220 ? `${summary.slice(0, 220)}...` : summary;
  }

  private extractSummaryFromText(content: string): string | null {
    const match = content.match(/"summary"\s*:\s*"([\s\S]*?)"/i);
    if (!match?.[1]) {
      return null;
    }

    const cleaned = match[1]
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, " ")
      .trim();

    if (!cleaned) {
      return null;
    }

    return cleaned.length > 220 ? `${cleaned.slice(0, 220)}...` : cleaned;
  }

  private extractPointsFromText(content: string): string[] {
    const blockMatch = content.match(
      /"improvementPoints"\s*:\s*\[([\s\S]*?)\]/i,
    );

    if (!blockMatch?.[1]) {
      return [];
    }

    const matches = blockMatch[1].match(/"([\s\S]*?)"/g) || [];
    const values = matches.map((item) =>
      item
        .slice(1, -1)
        .replace(/\\"/g, "\"")
        .replace(/\\n/g, " ")
        .trim(),
    );

    return this.normalizePoints(values);
  }

  private extractImprovementPoints(parsed: any): string[] {
    if (Array.isArray(parsed.improvementPoints)) {
      return this.normalizePoints(parsed.improvementPoints);
    }

    // Backward compatibility with the previous response schema
    const legacyPoints = [
      ...(Array.isArray(parsed.grammarErrors) ? parsed.grammarErrors : []),
      ...(Array.isArray(parsed.vocabularySuggestions)
        ? parsed.vocabularySuggestions
        : []),
    ];

    return this.normalizePoints(legacyPoints);
  }

  private normalizePoints(points: any[]): string[] {
    const unique = new Set<string>();

    for (const point of points) {
      if (typeof point !== "string") {
        continue;
      }

      const normalized = point.trim();
      if (!normalized) {
        continue;
      }

      unique.add(normalized);
    }

    return Array.from(unique);
  }

  private createFallbackFeedback(transcript: string): FeedbackResult {
    return {
      summary:
        "Не удалось получить полный анализ от модели. Ниже базовая оценка, попробуйте запросить отчёт ещё раз позже.",
      improvementPoints: [
        "Добавьте больше деталей: причина, пример, сравнение.",
        "Используйте связки: because, however, for example, in my opinion.",
      ],
      overallScore: transcript.trim().split(/\s+/).length >= 20 ? 6 : 5,
    };
  }

  private shortenText(text: string, maxChars: number): string {
    const normalized = text.trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars)}...`;
  }
}
