import { Injectable } from "@nestjs/common";
import { Prompt, UserPrompt } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";

@Injectable()
export class PromptService {
  constructor(private readonly prisma: PrismaService) {}

  async getActivePrompts(): Promise<Prompt[]> {
    return this.prisma.prompt.findMany({
      where: { isActive: true },
    });
  }

  async getRandomActivePrompt(): Promise<Prompt | null> {
    const prompts = await this.getActivePrompts();

    if (prompts.length === 0) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * prompts.length);
    return prompts[randomIndex];
  }

  async getPromptById(id: string): Promise<Prompt | null> {
    return this.prisma.prompt.findUnique({
      where: { id },
    });
  }

  async recordPromptSent(userId: string, promptId: string): Promise<UserPrompt> {
    return this.prisma.userPrompt.create({
      data: {
        userId,
        promptId,
      },
    });
  }

  async getUserPromptById(id: string): Promise<UserPrompt | null> {
    return this.prisma.userPrompt.findUnique({
      where: { id },
    });
  }

  async getLatestUserPrompt(userId: string): Promise<UserPrompt | null> {
    return this.prisma.userPrompt.findFirst({
      where: { userId },
      orderBy: { sentAt: "desc" },
    });
  }
}
