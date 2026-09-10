import { AiProviderTraceContext } from "../services/ai-provider-trace-writer.service";
export type AgentTone = "friendly" | "playful";
import type { AgentPersonalityPrompt } from "../../personality";
export type { AgentPersonalityPrompt } from "../../personality";

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

export interface ConversationReadiness {
  ready: boolean;
  lastQuestionAnswered: boolean;
  question: string;
  insufficiencyReason?: "too_short" | "needs_detail";
}

export interface ILLMService {
  assessConversation(
    history: ConversationMessage[],
    initialQuestion: string,
    topic: string,
    trace: AiProviderTraceContext | undefined,
    personality: AgentPersonalityPrompt,
  ): Promise<ConversationReadiness>;

  analyzeSpeech(
    transcript: string,
    topic: string,
    targetLanguage?: string,
    personality?: AgentPersonalityPrompt | AgentTone,
    trace?: AiProviderTraceContext,
  ): Promise<SpeechAnalysisResult>;

  generateFollowUp(
    conversationHistory: ConversationMessage[],
    topic: string,
    personality?: AgentPersonalityPrompt | AgentTone,
    trace?: AiProviderTraceContext,
  ): Promise<string>;
}

export const LLM_SERVICE = Symbol("LLM_SERVICE");
