import { Injectable, Optional } from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { DEFAULT_USER_TIMEZONE } from "../../config/limits.config";
import { PersonalityService } from "../personality";
import { nextSlotAtOrAfter } from "../../shared/time";

export interface CreateUserData {
  telegramId: bigint;
  username?: string;
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly personalityService?: PersonalityService) {}

  async findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { telegramId },
    });
  }

  async createUser(data: CreateUserData): Promise<User> {
    const now = new Date();
    const create = async (client: Prisma.TransactionClient | PrismaService, agentTone: string) => client.user.create({
      data: { telegramId: data.telegramId, username: data.username, agentTone, dailyPromptEnabled: true, announcementEnabled: true, dailyPromptHour: 13, dailyPromptMinute: 0, timezone: DEFAULT_USER_TIMEZONE, nextPromptAt: nextSlotAtOrAfter(now, 13, 0, DEFAULT_USER_TIMEZONE).instant, currentStreak: 0, longestStreak: 0, streakReminderEnabled: true, streakReminderHour: 21, streakReminderMinute: 0 },
    });
    if (!this.personalityService || typeof (this.prisma as any).$transaction !== "function") return create(this.prisma, await this.defaultPersonalityKey());
    return this.prisma.$transaction(async (tx) => create(tx, await this.lockedDefaultPersonalityKey(tx)));
  }

  private async defaultPersonalityKey(): Promise<string> {
    return this.personalityService ? (await this.personalityService.resolveSelectedOrDefault(null)).key : "friendly";
  }

  private async lockedDefaultPersonalityKey(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ key: string }>>(Prisma.sql`SELECT "key" FROM "agent_personalities" WHERE "isDefault" = true AND "isActive" = true FOR UPDATE`);
    if (!rows[0]) throw new Error("Active default personality is missing");
    return rows[0].key;
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

  async findOrCreateByTelegramId(telegramId: bigint, username?: string): Promise<User> {
    const now = new Date();
    const upsert = (client: Prisma.TransactionClient | PrismaService, agentTone: string) => client.user.upsert({
      where: { telegramId },
      update: {},
      create: { telegramId, username, agentTone, dailyPromptEnabled: true, announcementEnabled: true, dailyPromptHour: 13, dailyPromptMinute: 0, timezone: DEFAULT_USER_TIMEZONE, nextPromptAt: nextSlotAtOrAfter(now, 13, 0, DEFAULT_USER_TIMEZONE).instant, currentStreak: 0, longestStreak: 0, streakReminderEnabled: true, streakReminderHour: 21, streakReminderMinute: 0 },
    });
    try {
      if (!this.personalityService || typeof (this.prisma as any).$transaction !== "function") return await upsert(this.prisma, await this.defaultPersonalityKey());
      return await this.prisma.$transaction(async (tx) => upsert(tx, await this.lockedDefaultPersonalityKey(tx)));
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const existingUser = await this.prisma.user.findUnique({ where: { telegramId } });
      if (existingUser) return existingUser;
      throw error;
    }
  }
}
