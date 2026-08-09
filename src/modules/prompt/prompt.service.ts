import { Injectable } from "@nestjs/common";
import { Prompt, UserPrompt, UserPromptDeliveryStatus } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";

@Injectable()
export class PromptService {
  constructor(private readonly prisma: PrismaService) {}

  async hasActivePrompt(): Promise<boolean> {
    const prompt = await this.prisma.prompt.findFirst({
      where: { isActive: true },
      select: { id: true },
    });

    return prompt !== null;
  }

  async getPromptById(id: string): Promise<Prompt | null> {
    return this.prisma.prompt.findUnique({
      where: { id },
    });
  }

  async getUserPromptById(id: string): Promise<UserPrompt | null> {
    return this.prisma.userPrompt.findUnique({
      where: { id },
    });
  }

  async getLatestUserPrompt(userId: string): Promise<UserPrompt | null> {
    return this.prisma.userPrompt.findFirst({
      where: {
        userId,
        deliveryStatus: UserPromptDeliveryStatus.sent,
      },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    });
  }
}
