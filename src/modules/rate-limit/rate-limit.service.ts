import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  RATE_LIMITS,
} from "../../config/limits.config";
import {
  CalendarDayRange,
  getCalendarDayRange,
  resolveEffectiveTimeZone,
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

  async consumeLimit(
    userId: string,
    action: string,
    config?: RateLimitConfig,
  ): Promise<RateLimitAdmission> {
    const { maxRequests, windowMinutes } =
      config ?? DEFAULT_RATE_LIMITS[action] ?? DEFAULT_RATE_LIMITS.command;

    return this.retrySerializable(async (transaction, attemptedAt) => {
      const windowStart = new Date(
        attemptedAt.getTime() - windowMinutes * 60 * 1000,
      );
      const count = await transaction.userRequest.count({
        where: {
          userId,
          action,
          createdAt: { gte: windowStart },
        },
      });

      if (count >= maxRequests) {
        return { allowed: false } as const;
      }

      const request = await transaction.userRequest.create({
        data: { userId, action, createdAt: attemptedAt },
      });

      return { allowed: true, requestId: request.id } as const;
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
    return this.retrySerializable(async (transaction, attemptedAt) => {
      const lockedUsers = await transaction.$queryRaw<
        Array<{ timezone: string }>
      >`SELECT "timezone" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
      const timezoneSnapshot = resolveEffectiveTimeZone(
        lockedUsers[0]?.timezone ?? timeZone,
      ).timeZone;

      let window = await transaction.quotaWindow.findFirst({
        where: {
          userId,
          action,
          windowStart: { lte: attemptedAt },
          windowEnd: { gt: attemptedAt },
        },
        orderBy: { windowEnd: "desc" },
      });

      if (!window) {
        const { start, end } = getCalendarDayRange(
          timezoneSnapshot,
          attemptedAt,
        );
        window = await transaction.quotaWindow.create({
          data: {
            userId,
            action,
            timezoneSnapshot,
            windowStart: start,
            windowEnd: end,
          },
        });
      }

      const count = await transaction.userRequest.count({
        where: { userId, action, quotaWindowId: window.id },
      });

      if (count >= maxRequests) {
        return { allowed: false } as const;
      }

      const request = await transaction.userRequest.create({
        data: {
          userId,
          action,
          quotaWindowId: window.id,
          createdAt: attemptedAt,
        },
      });

      return { allowed: true, requestId: request.id } as const;
    });
  }

  async releaseAction(requestId: string): Promise<void> {
    await this.retrySerializable(async (transaction) => {
      const candidate = await transaction.userRequest.findUnique({
        where: { id: requestId },
        select: { userId: true },
      });
      if (!candidate) return;

      await transaction.$queryRaw`
        SELECT "id" FROM "users" WHERE "id" = ${candidate.userId} FOR UPDATE
      `;

      const request = await transaction.userRequest.findUnique({
        where: { id: requestId },
        select: { quotaWindowId: true },
      });
      if (!request) return;

      await transaction.userRequest.deleteMany({ where: { id: requestId } });

      if (request.quotaWindowId) {
        await transaction.quotaWindow.deleteMany({
          where: {
            id: request.quotaWindowId,
            userRequests: { none: {} },
          },
        });
      }
    });
  }

  async getCalendarDayActionCount(
    userId: string,
    action: string,
    _timeZone: string,
    now: Date = new Date(),
  ): Promise<number> {
    const activeWindow = await this.prisma.quotaWindow?.findFirst({
      where: {
        userId,
        action,
        windowStart: { lte: now },
        windowEnd: { gt: now },
      },
      orderBy: { windowEnd: "desc" },
    });

    if (activeWindow) {
      return this.prisma.userRequest.count({
        where: { userId, action, quotaWindowId: activeWindow.id },
      });
    }

    return 0;
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

  private async retrySerializable<T>(
    operation: (
      transaction: Prisma.TransactionClient,
      attemptedAt: Date,
    ) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (transaction) => operation(transaction, new Date()),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        const isRetryableConflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2034" || error.code === "P2002");

        if (!isRetryableConflict || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw new Error("Failed to consume rate limit");
  }
}
