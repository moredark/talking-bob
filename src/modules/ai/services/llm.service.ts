import { Injectable, Logger } from "@nestjs/common";
import {
  ILLMService,
  FeedbackResult,
  ConversationMessage,
} from "../interfaces";

const FOLLOW_UP_SYSTEM_PROMPT = `You are a friendly English conversation partner helping a Russian speaker practice spoken English.
Your role is to maintain a natural conversation on the given topic.

Rules:
- Speak ONLY in English
- React naturally to what the student said
- Ask ONE follow-up or clarifying question to keep the conversation going
- Keep your response concise (2-3 sentences max)
- Be encouraging but natural — like a real conversation partner
- Do NOT correct grammar or pronunciation during the conversation
- If the student's response is very short or unclear, gently encourage them to elaborate`;

const SYSTEM_PROMPT = `You are an English language tutor helping Russian speakers improve their spoken English.
Analyze the student's speech transcript and provide constructive feedback.

IMPORTANT: Always respond in Russian language.

Return your analysis as a valid JSON object with this exact structure:
{
  "summary": "Brief overall assessment in Russian (1-2 sentences)",
  "grammarErrors": ["List of grammar mistakes found, explained in Russian"],
  "vocabularySuggestions": ["Better word choices or expressions in Russian"],
  "overallScore": 7
}

The overallScore should be from 1 to 10.
If no errors found in a category, return an empty array.
Be encouraging but honest.`;

@Injectable()
export class LLMService implements ILLMService {
  private readonly logger = new Logger(LLMService.name);
  private readonly apiUrl =
    process.env.LLM_API_URL ||
    "https://foundation-models.api.cloud.ru/v1/chat/completions";
  private readonly model = process.env.LLM_MODEL || "openai/gpt-4o-mini";

  async analyzeSpeech(
    transcript: string,
    topic: string,
    targetLanguage: string = "en",
  ): Promise<FeedbackResult> {
    const apiKey = process.env.CLOUD_RU_API_KEY;

    if (!apiKey) {
      throw new Error("CLOUD_RU_API_KEY is not defined");
    }

    const userPrompt = `Topic: "${topic}"
Student's response (transcribed from voice): "${transcript}"

Analyze this English speech and provide feedback.`;

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 1000,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`LLM API error: ${response.status} - ${errorText}`);
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("No content in LLM response");
      }

      const feedback = this.parseJsonResponse(content);

      this.logger.log(`Analysis complete, score: ${feedback.overallScore}`);

      return feedback;
    } catch (error) {
      this.logger.error("Speech analysis failed:", error);
      throw error;
    }
  }

  async generateFollowUp(
    conversationHistory: ConversationMessage[],
    topic: string,
  ): Promise<string> {
    const apiKey = process.env.CLOUD_RU_API_KEY;

    if (!apiKey) {
      throw new Error("CLOUD_RU_API_KEY is not defined");
    }

    const messages = [
      {
        role: "system",
        content: `${FOLLOW_UP_SYSTEM_PROMPT}\n\nConversation topic: "${topic}"`,
      },
      ...conversationHistory.map((msg) => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      })),
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
          temperature: 0.8,
          max_tokens: 300,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`LLM API error: ${response.status} - ${errorText}`);
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("No content in LLM response");
      }

      return content.trim();
    } catch (error) {
      this.logger.error("Follow-up generation failed:", error);
      throw error;
    }
  }

  private parseJsonResponse(content: string): FeedbackResult {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        summary: parsed.summary || "Анализ недоступен",
        grammarErrors: parsed.grammarErrors || [],
        vocabularySuggestions: parsed.vocabularySuggestions || [],
        overallScore: Math.min(10, Math.max(1, parsed.overallScore || 5)),
      };
    } catch {
      this.logger.warn("Failed to parse JSON response, using fallback");
      return {
        summary: content.substring(0, 200),
        grammarErrors: [],
        vocabularySuggestions: [],
        overallScore: 5,
      };
    }
  }
}
