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
        announcementEnabled: true,
        dailyPromptHour: 13,
        dailyPromptMinute: 0,
        timezone: DEFAULT_USER_TIMEZONE,
        nextPromptAt: nextSlotAtOrAfter(
          now,
          13,
          0,
          DEFAULT_USER_TIMEZONE,
        ).instant,
        currentStreak: 0,
        longestStreak: 0,
        streakReminderEnabled: true,
        streakReminderHour: 21,
        streakReminderMinute: 0,
      },
    });
  }

  async getAllUsers(): Promise<User[]> {
    return this.prisma.user.findMany();
  }

  async updateAnnouncementEnabled(userId: string, enabled: boolean): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { announcementEnabled: enabled },
    });
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
    const now = new Date();

    try {
      return await this.prisma.user.upsert({
        where: { telegramId },
        update: {},
        create: {
          telegramId,
          username,
          dailyPromptEnabled: true,
        announcementEnabled: true,
          dailyPromptHour: 13,
          dailyPromptMinute: 0,
          timezone: DEFAULT_USER_TIMEZONE,
          nextPromptAt: nextSlotAtOrAfter(
            now,
            13,
            0,
            DEFAULT_USER_TIMEZONE,
          ).instant,
          currentStreak: 0,
          longestStreak: 0,
          streakReminderEnabled: true,
          streakReminderHour: 21,
          streakReminderMinute: 0,
        },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }

      const existingUser = await this.prisma.user.findUnique({
        where: { telegramId },
      });

      if (existingUser) {
        return existingUser;
      }

      throw error;
    }
  }
}
