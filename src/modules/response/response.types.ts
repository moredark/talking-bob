import {
  ReportAnalysisKind,
  ReportDeliveryRequest,
  UserResponse,
} from "@prisma/client";

export interface CreateResponseData {
  userId: string;
  userPromptId: string;
  voiceFileId: string;
}

export interface UpdateResponseData {
  transcript?: string;
  analysis?: string;
}

export interface ClaimGenerationData extends CreateResponseData {
  generationRequestKey: string;
}

export interface GenerationClaim {
  responseId: string;
  claimToken: string;
  claimExpiresAt: Date;
}

export type ClaimGenerationResult =
  | { outcome: "claimed"; claim: GenerationClaim }
  | { outcome: "generated"; response: UserResponse }
  | { outcome: "busy"; response: UserResponse }
  | { outcome: "failed_same_request"; response: UserResponse }
  | { outcome: "no_messages" }
  | { outcome: "missing_prompt" };

export interface CompleteGenerationData {
  responseId: string;
  claimToken: string;
  transcript: string;
  analysis: string;
  analysisVersion: number;
  analysisKind: ReportAnalysisKind;
  chunks: string[];
}

export interface DeliveryClaim {
  requestId: string;
  claimToken: string;
  claimExpiresAt: Date;
  nextChunkIndex: number;
  chunks: string[];
}

export type CompleteGenerationResult =
  | { outcome: "claimed"; claim: DeliveryClaim }
  | { outcome: "stale" };

export type ClaimDeliveryResult =
  | { outcome: "claimed"; claim: DeliveryClaim }
  | { outcome: "busy" | "ambiguous" | "failed" | "delivered"; request: ReportDeliveryRequest }
  | { outcome: "response_not_generated" };

export type BeginChunkResult =
  | { outcome: "begun"; chunk: string; chunkIndex: number; attemptedAt: Date }
  | { outcome: "stale" };

export type CompleteChunkResult =
  | { outcome: "claimed_next"; claim: DeliveryClaim }
  | { outcome: "delivered"; request: ReportDeliveryRequest }
  | { outcome: "stale" };
