export type AgentTone = "friendly" | "playful";

export interface FeedbackResult {
  summary: string;
  improvementPoints: string[];
  overallScore: number;
}

export interface SpeechAnalysisResult extends FeedbackResult {
  version: 1;
  kind: "model" | "fallback";
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
  ): Promise<SpeechAnalysisResult>;

  generateFollowUp(
    conversationHistory: ConversationMessage[],
    topic: string,
    tone?: AgentTone,
  ): Promise<string>;
}

export const LLM_SERVICE = Symbol("LLM_SERVICE");
