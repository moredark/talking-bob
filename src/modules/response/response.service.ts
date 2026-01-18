import { Injectable } from "@nestjs/common";
import { UserResponse } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";

export interface CreateResponseData {
  userId: string;
  userPromptId: string;
  voiceFileId: string;
}

export interface UpdateResponseData {
  transcript?: string;
  analysis?: string;
}

@Injectable()
export class ResponseService {
  constructor(private readonly prisma: PrismaService) {}

  async createResponse(data: CreateResponseData): Promise<UserResponse> {
    return this.prisma.userResponse.create({
      data: {
        userId: data.userId,
        userPromptId: data.userPromptId,
        voiceFileId: data.voiceFileId,
      },
    });
  }

  async updateResponse(
    id: string,
    data: UpdateResponseData
  ): Promise<UserResponse> {
    return this.prisma.userResponse.update({
      where: { id },
      data,
    });
  }

  async getResponseById(id: string): Promise<UserResponse | null> {
    return this.prisma.userResponse.findUnique({
      where: { id },
    });
  }

  async getResponseByUserPromptId(
    userPromptId: string
  ): Promise<UserResponse | null> {
    return this.prisma.userResponse.findUnique({
      where: { userPromptId },
    });
  }

  async getUserResponses(userId: string): Promise<UserResponse[]> {
    return this.prisma.userResponse.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }
}
