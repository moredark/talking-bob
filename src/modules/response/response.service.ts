import { Injectable } from "@nestjs/common";
import { UserResponse } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { StreakService } from "../streak";
import { ResponseCrudOperations } from "./response-crud.operations";
import { ResponseDeliveryOperations } from "./response-delivery.operations";
import { ResponseGenerationOperations } from "./response-generation.operations";
import {
  BeginChunkResult,
  ClaimDeliveryResult,
  ClaimGenerationData,
  ClaimGenerationResult,
  CompleteChunkResult,
  CompleteGenerationData,
  CompleteGenerationResult,
  CreateResponseData,
  UpdateResponseData,
} from "./response.types";

export {
  BeginChunkResult,
  ClaimDeliveryResult,
  ClaimGenerationData,
  ClaimGenerationResult,
  CompleteChunkResult,
  CompleteGenerationData,
  CompleteGenerationResult,
  CreateResponseData,
  DeliveryClaim,
  GenerationClaim,
  UpdateResponseData,
} from "./response.types";

@Injectable()
export class ResponseService {
  private readonly generation: ResponseGenerationOperations;
  private readonly delivery: ResponseDeliveryOperations;
  private readonly crud: ResponseCrudOperations;

  constructor(prisma: PrismaService, streakService: StreakService) {
    this.generation = new ResponseGenerationOperations(prisma, streakService);
    this.delivery = new ResponseDeliveryOperations(prisma);
    this.crud = new ResponseCrudOperations(prisma);
  }

  /** Claims manual generation, reclaims failed/expired work, or returns saved output. */
  async claimGeneration(data: ClaimGenerationData): Promise<ClaimGenerationResult> {
    return this.generation.claimGeneration(data);
  }

  async completeGeneration(
    data: CompleteGenerationData,
  ): Promise<CompleteGenerationResult> {
    return this.generation.completeGeneration(data);
  }

  async failGeneration(
    responseId: string,
    claimToken: string,
    errorCode: string,
  ): Promise<boolean> {
    return this.generation.failGeneration(responseId, claimToken, errorCode);
  }

  async createOrClaimDeliveryRequest(
    userResponseId: string,
    requestKey: string,
    chunks: string[],
  ): Promise<ClaimDeliveryResult> {
    return this.delivery.createOrClaimDeliveryRequest(userResponseId, requestKey, chunks);
  }

  /** Marks a chunk attempted before Telegram I/O and clears the delivery lease. */
  async beginDeliveryChunk(
    requestId: string,
    claimToken: string,
    attemptedAt = new Date(),
  ): Promise<BeginChunkResult> {
    return this.delivery.beginDeliveryChunk(requestId, claimToken, attemptedAt);
  }

  async completeDeliveryChunk(
    requestId: string,
    chunkIndex: number,
    attemptedAt: Date,
  ): Promise<CompleteChunkResult> {
    return this.delivery.completeDeliveryChunk(requestId, chunkIndex, attemptedAt);
  }

  async failDeliveryDefinite(
    requestId: string,
    chunkIndex: number,
    attemptedAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    return this.delivery.failDeliveryDefinite(requestId, chunkIndex, attemptedAt, errorCode);
  }

  async failDeliveryAmbiguous(
    requestId: string,
    chunkIndex: number,
    attemptedAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    return this.delivery.failDeliveryAmbiguous(requestId, chunkIndex, attemptedAt, errorCode);
  }

  async createResponse(data: CreateResponseData): Promise<UserResponse> {
    return this.crud.createResponse(data);
  }

  async updateResponse(id: string, data: UpdateResponseData): Promise<UserResponse> {
    return this.crud.updateResponse(id, data);
  }

  async getResponseById(id: string): Promise<UserResponse | null> {
    return this.crud.getResponseById(id);
  }

  async getResponseByUserPromptId(userPromptId: string): Promise<UserResponse | null> {
    return this.crud.getResponseByUserPromptId(userPromptId);
  }

  async getUserResponses(userId: string): Promise<UserResponse[]> {
    return this.crud.getUserResponses(userId);
  }
}
