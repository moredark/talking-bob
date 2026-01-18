import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database";

export interface RateLimitConfig {
  maxRequests: number;
  windowMinutes: number;
}

export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  voice_response: { maxRequests: 10, windowMinutes: 60 },
  command: { maxRequests: 30, windowMinutes: 60 },
};

@Injectable()
export class RateLimitService {
  constructor(private readonly prisma: PrismaService) {}

  async checkLimit(
    userId: string,
    action: string,
    config?: RateLimitConfig
  ): Promise<boolean> {
    const { maxRequests, windowMinutes } =
      config ?? DEFAULT_RATE_LIMITS[action] ?? DEFAULT_RATE_LIMITS.command;

    const count = await this.getActionCount(userId, action, windowMinutes);
    return count < maxRequests;
  }

  async recordAction(userId: string, action: string): Promise<void> {
    await this.prisma.userRequest.create({
      data: {
        userId,
        action,
      },
    });
  }

  async getActionCount(
    userId: string,
    action: string,
    windowMinutes: number
  ): Promise<number> {
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

    return this.prisma.userRequest.count({
      where: {
        userId,
        action,
        createdAt: {
          gte: windowStart,
        },
      },
    });
  }
}
