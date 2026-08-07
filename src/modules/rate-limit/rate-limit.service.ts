import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  RATE_LIMITS,
} from "../../config/limits.config";
import {
  CalendarDayRange,
  getCalendarDayRange,
} from "../../shared/time/timezone";

export { CalendarDayRange, getCalendarDayRange };

export interface RateLimitConfig {
  maxRequests: number;
  windowMinutes: number;
}

export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  voice_response: RATE_LIMITS.voice_response,
  command: RATE_LIMITS.command,
};

export type RateLimitAdmission =
  | { allowed: true; requestId: string }
  | { allowed: false };

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

  async checkCalendarDayLimit(
    userId: string,
    action: string,
    timeZone: string,
    maxRequests: number,
  ): Promise<boolean> {
    const count = await this.getCalendarDayActionCount(
      userId,
      action,
      timeZone,
    );

    return count < maxRequests;
  }

  async consumeCalendarDayLimit(
    userId: string,
    action: string,
    timeZone: string,
    maxRequests: number,
  ): Promise<RateLimitAdmission> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptedAt = new Date();
      const { start, end } = getCalendarDayRange(timeZone, attemptedAt);

      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const count = await transaction.userRequest.count({
              where: {
                userId,
                action,
                createdAt: {
                  gte: start,
                  lt: end,
                },
              },
            });

            if (count >= maxRequests) {
              return { allowed: false } as const;
            }

            const request = await transaction.userRequest.create({
              data: { userId, action, createdAt: attemptedAt },
            });

            return { allowed: true, requestId: request.id } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        const isWriteConflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";

        if (!isWriteConflict || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw new Error("Failed to consume rate limit");
  }

  async releaseAction(requestId: string): Promise<void> {
    await this.prisma.userRequest.delete({ where: { id: requestId } });
  }

  async getCalendarDayActionCount(
    userId: string,
    action: string,
    timeZone: string,
    now: Date = new Date(),
  ): Promise<number> {
    const { start, end } = getCalendarDayRange(timeZone, now);

    return this.prisma.userRequest.count({
      where: {
        userId,
        action,
        createdAt: {
          gte: start,
          lt: end,
        },
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
