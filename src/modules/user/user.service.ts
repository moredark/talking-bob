import { Injectable } from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import type { AgentTone } from "../ai";
import { DEFAULT_USER_TIMEZONE } from "../../config/limits.config";
import { nextSlotAtOrAfter } from "../../shared/time";

export interface CreateUserData {
  telegramId: bigint;
  username?: string;
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { telegramId },
    });
  }

  async createUser(data: CreateUserData): Promise<User> {
    const now = new Date();

    return this.prisma.user.create({
      data: {
        telegramId: data.telegramId,
        username: data.username,
        dailyPromptEnabled: true,
        dailyPromptHour: 13,
        dailyPromptMinute: 0,
        timezone: DEFAULT_USER_TIMEZONE,
        nextPromptAt: nextSlotAtOrAfter(
          now,
          13,
          0,
          DEFAULT_USER_TIMEZONE,
        ).instant,
      },
    });
  }

  async getAllUsers(): Promise<User[]> {
    return this.prisma.user.findMany();
  }

  async updateAgentTone(userId: string, tone: AgentTone): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { agentTone: tone },
    });
  }

  async findOrCreateByTelegramId(
    telegramId: bigint,
    username?: string
  ): Promise<User> {
    const existingUser = await this.findByTelegramId(telegramId);

    if (existingUser) {
      return existingUser;
    }

    try {
      return await this.createUser({ telegramId, username });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await this.findByTelegramId(telegramId);
        if (winner) return winner;
      }

      throw error;
    }
  }
}
