export interface FeedbackResult {
  summary: string;
  grammarErrors: string[];
  pronunciationTips: string[];
  vocabularySuggestions: string[];
  overallScore: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ILLMService {
  analyzeSpeech(
    transcript: string,
    topic: string,
    targetLanguage?: string
  ): Promise<FeedbackResult>;

  generateFollowUp(
    conversationHistory: ConversationMessage[],
    topic: string,
  ): Promise<string>;
}

export const LLM_SERVICE = Symbol("LLM_SERVICE");
