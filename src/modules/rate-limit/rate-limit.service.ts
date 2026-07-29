import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  DEFAULT_USER_TIMEZONE,
  RATE_LIMITS,
} from "../../config/limits.config";

export interface RateLimitConfig {
  maxRequests: number;
  windowMinutes: number;
}

export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  voice_response: RATE_LIMITS.voice_response,
  command: RATE_LIMITS.command,
};

export interface CalendarDayRange {
  start: Date;
  end: Date;
}

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

export function getCalendarDayRange(
  timeZone: string,
  now: Date = new Date(),
): CalendarDayRange {
  const safeTimeZone = isValidTimeZone(timeZone)
    ? timeZone
    : DEFAULT_USER_TIMEZONE;
  const currentLocalDate = getLocalDateParts(now, safeTimeZone);
  const nextLocalDate = new Date(
    Date.UTC(
      currentLocalDate.year,
      currentLocalDate.month - 1,
      currentLocalDate.day + 1,
    ),
  );

  return {
    start: findFirstInstantOfLocalDate(currentLocalDate, safeTimeZone),
    end: findFirstInstantOfLocalDate(
      {
        year: nextLocalDate.getUTCFullYear(),
        month: nextLocalDate.getUTCMonth() + 1,
        day: nextLocalDate.getUTCDate(),
      },
      safeTimeZone,
    ),
  };
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function getLocalDateParts(date: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
  };
}

function findFirstInstantOfLocalDate(
  desired: LocalDateParts,
  timeZone: string,
): Date {
  const desiredOrdinal = getDateOrdinal(desired);
  const approximateUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
  );
  const searchMarginMs = 36 * 60 * 60 * 1000;
  let low = approximateUtc - searchMarginMs;
  let high = approximateUtc + searchMarginMs;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const middleOrdinal = getDateOrdinal(
      getLocalDateParts(new Date(middle), timeZone),
    );

    if (middleOrdinal < desiredOrdinal) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return new Date(low);
}

function getDateOrdinal(parts: LocalDateParts): number {
  return parts.year * 10_000 + parts.month * 100 + parts.day;
}
