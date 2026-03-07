export type AgentTone = "friendly" | "playful";

export interface FeedbackResult {
  summary: string;
  improvementPoints: string[];
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
    targetLanguage?: string,
    tone?: AgentTone,
  ): Promise<FeedbackResult>;

  generateFollowUp(
    conversationHistory: ConversationMessage[],
    topic: string,
    tone?: AgentTone,
  ): Promise<string>;
}

export const LLM_SERVICE = Symbol("LLM_SERVICE");
