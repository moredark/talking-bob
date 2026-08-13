import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { RUNTIME_CONFIG } from "../../../config/runtime-config.module";
import { RuntimeConfig } from "../../../config/runtime.config";
import {
  boundedFetch,
  BoundedHttpError,
} from "../../../infrastructure/http";
import { RuntimeSettingsService } from "../../../config/runtime-settings.service";
import { FRIENDLY_ANALYSIS_SYSTEM_PROMPT, FRIENDLY_FOLLOWUP_SYSTEM_PROMPT, PLAYFUL_ANALYSIS_SYSTEM_PROMPT, PLAYFUL_FOLLOWUP_SYSTEM_PROMPT } from "../../../config/llm-system-prompts";
import {
  AgentPersonalityPrompt,
  AgentTone,
  ILLMService,
  SpeechAnalysisResult,
  ConversationMessage,
} from "../interfaces";
import {
  AiRequestLimiterClosedError,
  AiRequestLimiterOverloadedError,
  AiRequestLimiterService,
} from "./ai-request-limiter.service";
import { ErrorLogService } from "../../error-log";
import { AiProviderTraceContext, AiProviderTraceWriter } from "./ai-provider-trace-writer.service";

class LlmProviderStatusError extends Error {
  constructor(readonly statusCode: number) {
    super("LLM provider rejected the request");
    this.name = "LlmProviderStatusError";
  }
}

@Injectable()
export class LLMService implements ILLMService {
  private readonly logger = new Logger(LLMService.name);
  private readonly apiUrl: string;
  @Inject(RuntimeSettingsService) private readonly settings!: RuntimeSettingsService;
  private readonly model: string;
  private readonly analysisMaxTokens: number;
  private readonly followUpMaxTokens: number;
  private readonly defaultFollowUp =
    "Thanks for your answer. Could you tell me a bit more and give one specific example?";

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly runtimeConfig: RuntimeConfig,
    private readonly requestLimiter: AiRequestLimiterService,
    @Optional() private readonly errorLog?: ErrorLogService,
    @Optional() private readonly traceWriter?: AiProviderTraceWriter,
  ) {
    this.apiUrl = runtimeConfig.llm.apiUrl;
    this.model = runtimeConfig.llm.model;
    this.analysisMaxTokens = runtimeConfig.llm.analysisMaxTokens;
    this.followUpMaxTokens = runtimeConfig.llm.followUpMaxTokens;
  }

  async analyzeSpeech(
    transcript: string,
    topic: string,
    targetLanguage: string = "en",
    personality?: AgentPersonalityPrompt | AgentTone,
    trace?: AiProviderTraceContext,
  ): Promise<SpeechAnalysisResult> {
    const startedAt = Date.now();
    const analysisMaxTokens = this.settings.productNumber("LLM_ANALYSIS_MAX_TOKENS");
    const systemPrompt = typeof personality === "object" ? personality.analysisPrompt : personality === "playful" ? PLAYFUL_ANALYSIS_SYSTEM_PROMPT : FRIENDLY_ANALYSIS_SYSTEM_PROMPT;

    const userPrompt = `Topic: "${topic}"\nStudent: "${this.shortenText(transcript, 1800)}"\nAnalyze this English speech.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    try {
      const attempts = [
        { temperature: 0.5, maxTokens: analysisMaxTokens },
        {
          temperature: 0.3,
          maxTokens: Math.min(32_000, analysisMaxTokens + 500),
        },
      ];

      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        const { content } = await this.requestTracedCompletion({
          messages,
          temperature: attempt.temperature,
          top_p: 0.95,
          presence_penalty: 0,
          max_tokens: attempt.maxTokens,
        }, "analysis", index + 1, trace);
        if (content) {
          const feedback = this.parseJsonResponse(content);
          this.logger.log("Analysis completed");
          return feedback;
        }

        this.logger.warn(
          `Analysis response is empty on attempt ${index + 1}/${attempts.length}`,
        );
      }

      return this.createFallbackFeedback(transcript);
    } catch (error) {
      this.logger.error(`Speech analysis failed (${this.errorKind(error)})`);
      await this.captureFailure("analyze_speech", startedAt, error);
      if (this.mustPropagate(error)) throw error;
      return this.createFallbackFeedback(transcript);
    }
  }

  async generateFollowUp(
    conversationHistory: ConversationMessage[],
    topic: string,
    personality?: AgentPersonalityPrompt | AgentTone,
    trace?: AiProviderTraceContext,
  ): Promise<string> {
    const startedAt = Date.now();
    const recentHistory = conversationHistory
      .slice(-6)
      .map((msg) => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: this.shortenText(msg.content, 400),
      }));

    const messages = [
      {
        role: "system",
        content: `${typeof personality === "object" ? personality.followUpPrompt : personality === "playful" ? PLAYFUL_FOLLOWUP_SYSTEM_PROMPT : FRIENDLY_FOLLOWUP_SYSTEM_PROMPT}\n\nConversation topic: "${topic}"`,
      },
      ...recentHistory,
    ];

    try {
      const { content } = await this.requestTracedCompletion({
        messages,
        temperature: 0.5,
        top_p: 0.95,
        presence_penalty: 0,
        max_tokens: this.settings.productNumber("LLM_FOLLOWUP_MAX_TOKENS"),
      }, "follow_up", 1, trace);
      if (!content) {
        this.logger.warn("Follow-up response is empty, using fallback");
        return this.defaultFollowUp;
      }

      return content;
    } catch (error) {
      this.logger.error(
        `Follow-up generation failed (${this.errorKind(error)})`,
      );
      await this.captureFailure("generate_follow_up", startedAt, error);
      if (this.mustPropagate(error)) throw error;
      return this.defaultFollowUp;
    }
  }

  private async requestTracedCompletion(
    payload: Record<string, unknown>,
    operation: "follow_up" | "analysis",
    attempt: number,
    trace?: AiProviderTraceContext,
  ): Promise<{ content: string | null }> {
    const startedAt = Date.now();
    let recorded = false;
    try {
      const response = await this.requestCompletion(payload);
      if (!response.ok) {
        if (trace) this.traceWriter?.write({
          ...trace, operation, provider: "cloud.ru", model: this.model, attempt,
          outcome: "failed", statusCode: response.status,
          latencyMs: Date.now() - startedAt, failureCode: `http_${response.status}`,
        });
        recorded = true;
        throw new LlmProviderStatusError(response.status);
      }
      const data = await response.json();
      const content = this.extractMessageContent(data);
      if (trace) this.traceWriter?.write({
        ...trace, operation, provider: "cloud.ru", model: this.model, attempt,
        outcome: content ? "succeeded" : "empty", statusCode: response.status,
        latencyMs: Date.now() - startedAt,
        inputTokens: data?.usage?.prompt_tokens,
        outputTokens: data?.usage?.completion_tokens,
        totalTokens: data?.usage?.total_tokens,
        responseContent: content ?? undefined,
      });
      return { content };
    } catch (error) {
      if (trace && !recorded) this.traceWriter?.write({
        ...trace, operation, provider: "cloud.ru", model: this.model, attempt,
        outcome: "failed", latencyMs: Date.now() - startedAt,
        failureCode: this.errorKind(error),
      });
      throw error;
    }
  }

  private requestCompletion(
    payload: Record<string, unknown>,
  ): Promise<Response> {

    return this.requestLimiter.run((signal) =>
      boundedFetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.runtimeConfig.cloudRuApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, ...payload }),
        signal,
        timeoutMs: this.runtimeConfig.externalRequests.llm.timeoutMs,
        maxResponseBytes:
          this.runtimeConfig.externalRequests.llm.maxResponseBytes,
      }),
    );
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }

  private mustPropagate(error: unknown): boolean {
    return (
      error instanceof AiRequestLimiterOverloadedError ||
      error instanceof AiRequestLimiterClosedError ||
      (error instanceof BoundedHttpError && error.code === "aborted")
    );
  }

  private async captureFailure(operation: string, startedAt: number, error: unknown): Promise<void> {
    await this.errorLog?.capture({
      type: "ai",
      service: "llm",
      operation,
      latencyMs: Date.now() - startedAt,
      statusCode: error instanceof LlmProviderStatusError ? error.statusCode : undefined,
      retryable: this.isRetryable(error),
      error,
      code: error instanceof BoundedHttpError ? error.code : undefined,
    });
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof LlmProviderStatusError) return error.statusCode === 429 || error.statusCode >= 500;
    return error instanceof BoundedHttpError && (error.code === "network" || error.code === "timeout");
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

  private parseJsonResponse(content: string): SpeechAnalysisResult {
    const cleanedContent = this.stripCodeFences(content);

    try {
      const parsedFromWhole = this.tryParseJson(cleanedContent);
      if (this.isValidAnalysisResponse(parsedFromWhole)) {
        return {
          version: 1,
          kind: "model",
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

      if (this.isValidAnalysisResponse(parsedFromCandidate)) {
        return {
          version: 1,
          kind: "model",
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
        version: 1,
        kind: "fallback",
        summary:
          extractedSummary ||
          "Ответ модели не удалось разобрать полностью. Показана доступная часть и базовая оценка.",
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

  private isValidAnalysisResponse(value: any): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    const hasSummary =
      typeof value.summary === "string" && value.summary.trim().length > 0;
    const hasValidScore =
      typeof value.overallScore === "number" &&
      Number.isInteger(value.overallScore) &&
      value.overallScore >= 1 &&
      value.overallScore <= 10;
    const hasPointList =
      Array.isArray(value.improvementPoints) ||
      Array.isArray(value.grammarErrors) ||
      Array.isArray(value.vocabularySuggestions);

    return hasSummary && hasValidScore && hasPointList;
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

  private createFallbackFeedback(transcript: string): SpeechAnalysisResult {
    return {
      version: 1,
      kind: "fallback",
      summary:
        "Модель не предоставила полный анализ. Показана базовая автоматическая оценка ответа.",
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
