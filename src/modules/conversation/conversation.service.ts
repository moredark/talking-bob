import { Injectable } from "@nestjs/common";
import { ConversationMessage as PrismaConversationMessage } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async addMessage(
    userPromptId: string,
    role: string,
    content: string,
    voiceFileId?: string,
  ): Promise<PrismaConversationMessage> {
    return this.prisma.conversationMessage.create({
      data: {
        userPromptId,
        role,
        content,
        voiceFileId,
      },
    });
  }

  async getMessages(
    userPromptId: string,
  ): Promise<PrismaConversationMessage[]> {
    return this.prisma.conversationMessage.findMany({
      where: { userPromptId },
      orderBy: { createdAt: "asc" },
    });
  }

  async hasMessages(userPromptId: string): Promise<boolean> {
    const count = await this.prisma.conversationMessage.count({
      where: { userPromptId },
    });
    return count > 0;
  }
}
