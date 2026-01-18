export interface FeedbackResult {
  summary: string;
  grammarErrors: string[];
  pronunciationTips: string[];
  vocabularySuggestions: string[];
  overallScore: number;
}

export interface ILLMService {
  analyzeSpeech(
    transcript: string,
    topic: string,
    targetLanguage?: string
  ): Promise<FeedbackResult>;
}

export const LLM_SERVICE = Symbol("LLM_SERVICE");
