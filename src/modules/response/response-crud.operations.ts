import { randomUUID } from "node:crypto";
import { Prisma, UserResponse } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { CreateResponseData, UpdateResponseData } from "./response.types";

const GENERATION_LEASE_MS = 30 * 60 * 1000;

export class ResponseCrudOperations {
  constructor(private readonly prisma: PrismaService) {}

  async createResponse(data: CreateResponseData): Promise<UserResponse> {
    const now = new Date();
    return this.prisma.userResponse.create({
      data: {
        ...data,
        generationRequestKey: `crud:${randomUUID()}`,
        generationClaimToken: randomUUID(),
        generationClaimExpiresAt: new Date(now.getTime() + GENERATION_LEASE_MS),
        generationAttemptedAt: now,
      },
    });
  }

  async updateResponse(id: string, data: UpdateResponseData): Promise<UserResponse> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockResponse(tx, id);
      const current = await tx.userResponse.findUniqueOrThrow({ where: { id } });
      const completesLegacy =
        current.generationStatus === "generating" &&
        Boolean(data.transcript?.trim()) &&
        Boolean(data.analysis?.trim());
      return tx.userResponse.update({
        where: { id },
        data: completesLegacy
          ? {
              ...data,
              generationStatus: "generated",
              generatedAt: new Date(),
              analysisVersion: 0,
              analysisKind: "legacy",
              generationClaimToken: null,
              generationClaimExpiresAt: null,
            }
          : data,
      });
    });
  }

  async getResponseById(id: string): Promise<UserResponse | null> {
    return this.prisma.userResponse.findUnique({ where: { id } });
  }

  async getResponseByUserPromptId(userPromptId: string): Promise<UserResponse | null> {
    return this.prisma.userResponse.findUnique({ where: { userPromptId } });
  }

  async getUserResponses(userId: string): Promise<UserResponse[]> {
    return this.prisma.userResponse.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  private async lockResponse(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "user_responses" WHERE "id" = ${id} FOR UPDATE`;
  }
}
