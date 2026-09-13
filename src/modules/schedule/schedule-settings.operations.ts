import { Prisma, User } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  nextWeeklySlotAtOrAfter,
  weeklySlotOnDate,
  getLocalDateParts,
  validatePromptWeekdaysMask,
  resolveEffectiveTimeZone,
  validateScheduleTime,
} from "../../shared/time";

export const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PROMPT_HOUR = 13;
const DEFAULT_PROMPT_MINUTE = 0;
const MAX_BATCH_SIZE = 100;

interface RepairRow {
  id: string;
  timezone: string;
  dailyPromptHour: number;
  dailyPromptMinute: number;
  promptWeekdaysMask: number;
}

interface NormalizationRow extends RepairRow {
  dailyPromptEnabled: boolean;
  nextPromptAt: Date | null;
}

interface NormalizationBatchResult {
  scanned: number;
  updated: number;
  lastId: string | null;
}

export interface ScheduleSettings {
  dailyPromptEnabled?: boolean;
  promptWeekdaysMask?: number;
  dailyPromptHour?: number;
  dailyPromptMinute?: number;
  timezone?: string | null;
}

export type TimezoneTransition = (
  tx: Prisma.TransactionClient,
  user: User,
  now: Date,
) => Promise<User>;

export class ScheduleSettingsOperations {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timezoneTransition?: TimezoneTransition,
  ) {}

  async normalizeAllSchedules(
    batchSize = DEFAULT_BATCH_SIZE,
    now = new Date(),
  ): Promise<number> {
    const normalizedBatchSize = this.normalizeBatchSize(batchSize);
    let afterId: string | null = null;
    let totalUpdated = 0;

    while (true) {
      const batch = await this.normalizeScheduleBatch(
        afterId,
        normalizedBatchSize,
        now,
      );
      totalUpdated += batch.updated;

      if (batch.scanned < normalizedBatchSize || !batch.lastId) {
        return totalUpdated;
      }

      afterId = batch.lastId;
    }
  }

  async repairAllSchedules(
    batchSize = DEFAULT_BATCH_SIZE,
    now = new Date(),
  ): Promise<number> {
    let total = 0;
    let repaired: number;

    do {
      repaired = await this.repairSchedules(batchSize, now);
      total += repaired;
    } while (repaired === this.normalizeBatchSize(batchSize));

    return total;
  }

  async repairSchedules(
    limit = DEFAULT_BATCH_SIZE,
    now = new Date(),
  ): Promise<number> {
    const batchSize = this.normalizeBatchSize(limit);

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RepairRow[]>(Prisma.sql`
        SELECT
          "id",
          "timezone",
          "dailyPromptHour",
          "dailyPromptMinute",
          "promptWeekdaysMask"
        FROM "users"
        WHERE "dailyPromptEnabled" = true
          AND "nextPromptAt" IS NULL
        ORDER BY "createdAt", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      `);

      for (const row of rows) {
        const hour = this.validHour(row.dailyPromptHour)
          ? row.dailyPromptHour
          : DEFAULT_PROMPT_HOUR;
        const minute = this.validMinute(row.dailyPromptMinute)
          ? row.dailyPromptMinute
          : DEFAULT_PROMPT_MINUTE;
        const timezone = resolveEffectiveTimeZone(row.timezone).timeZone;
        const nextPromptAt = nextWeeklySlotAtOrAfter(
          now,
          hour,
          minute,
          timezone,
          row.promptWeekdaysMask,
        ).instant;

        await tx.user.update({
          where: { id: row.id },
          data: {
            dailyPromptHour: hour,
            dailyPromptMinute: minute,
            timezone,
            nextPromptAt,
          },
        });
      }

      return rows.length;
    });
  }

  private async normalizeScheduleBatch(
    afterId: string | null,
    limit: number,
    now: Date,
  ): Promise<NormalizationBatchResult> {
    return this.prisma.$transaction(async (tx) => {
      const cursorCondition = afterId
        ? Prisma.sql`WHERE "id" > ${afterId}`
        : Prisma.empty;
      const rows = await tx.$queryRaw<NormalizationRow[]>(Prisma.sql`
        SELECT
          "id",
          "timezone",
          "dailyPromptHour",
          "dailyPromptMinute",
          "promptWeekdaysMask",
          "dailyPromptEnabled",
          "nextPromptAt"
        FROM "users"
        ${cursorCondition}
        ORDER BY "id"
        FOR UPDATE
        LIMIT ${limit}
      `);
      let updated = 0;

      for (const row of rows) {
        const hour = this.validHour(row.dailyPromptHour)
          ? row.dailyPromptHour
          : DEFAULT_PROMPT_HOUR;
        const minute = this.validMinute(row.dailyPromptMinute)
          ? row.dailyPromptMinute
          : DEFAULT_PROMPT_MINUTE;
        const timezone = resolveEffectiveTimeZone(row.timezone).timeZone;
        const data: Prisma.UserUpdateInput = {};

        if (hour !== row.dailyPromptHour) {
          data.dailyPromptHour = hour;
        }
        if (minute !== row.dailyPromptMinute) {
          data.dailyPromptMinute = minute;
        }
        if (timezone !== row.timezone) {
          data.timezone = timezone;
        }
        if (!row.dailyPromptEnabled && row.nextPromptAt !== null) {
          data.nextPromptAt = null;
        } else if (row.dailyPromptEnabled) {
          const cursorSlot = row.nextPromptAt
            ? weeklySlotOnDate(getLocalDateParts(row.nextPromptAt, timezone), hour, minute, timezone, row.promptWeekdaysMask)
            : null;
          if (!cursorSlot || cursorSlot.instant.getTime() !== row.nextPromptAt?.getTime()) {
            // Keep today's overdue work recoverable while never creating a past-day occurrence.
            const today = weeklySlotOnDate(getLocalDateParts(now, timezone), hour, minute, timezone, row.promptWeekdaysMask);
            data.nextPromptAt = row.nextPromptAt && row.nextPromptAt <= now && today && today.instant <= now
              ? today.instant
              : nextWeeklySlotAtOrAfter(now, hour, minute, timezone, row.promptWeekdaysMask).instant;
          }
        }

        if (Object.keys(data).length > 0) {
          await tx.user.update({
            where: { id: row.id },
            data,
          });
          updated += 1;
        }
      }

      return {
        scanned: rows.length,
        updated,
        lastId: rows.length > 0 ? rows[rows.length - 1].id : null,
      };
    });
  }

  async updateScheduleSettings(
    userId: string,
    settings: ScheduleSettings,
    now = new Date(),
  ): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<User[]>(Prisma.sql`
        SELECT *
        FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE
      `);

      if (!locked) {
        throw new Error("User not found");
      }

      const hour = settings.dailyPromptHour ?? locked.dailyPromptHour;
      const minute = settings.dailyPromptMinute ?? locked.dailyPromptMinute;
      validateScheduleTime(hour, minute);
      const mask = settings.promptWeekdaysMask ?? locked.promptWeekdaysMask;
      validatePromptWeekdaysMask(mask);

      const timezone = resolveEffectiveTimeZone(
        settings.timezone === undefined ? locked.timezone : settings.timezone,
      ).timeZone;
      const enabled =
        settings.dailyPromptEnabled ?? locked.dailyPromptEnabled;
      const nextPromptAt = enabled
        ? nextWeeklySlotAtOrAfter(now, hour, minute, timezone, mask).instant
        : null;

      let updated = await tx.user.update({
        where: { id: userId },
        data: {
          dailyPromptEnabled: enabled,
          promptWeekdaysMask: mask,
          dailyPromptHour: hour,
          dailyPromptMinute: minute,
          timezone,
          nextPromptAt,
        },
      });
      if (
        this.timezoneTransition &&
        resolveEffectiveTimeZone(locked.timezone).timeZone !== timezone
      ) {
        updated = await this.timezoneTransition(tx, updated, now);
      }
      return updated;
    });
  }

  normalizeBatchSize(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) return DEFAULT_BATCH_SIZE;
    return Math.min(limit, MAX_BATCH_SIZE);
  }

  private validHour(hour: number): boolean {
    return Number.isInteger(hour) && hour >= 0 && hour <= 23;
  }

  private validMinute(minute: number): boolean {
    return Number.isInteger(minute) && minute >= 0 && minute <= 59;
  }
}
