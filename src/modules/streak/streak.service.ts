import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  getCalendarDayRange,
  getLocalDateKey,
  nextSlotAtOrAfter,
  resolveEffectiveTimeZone,
  resolveWallClock,
  validateScheduleTime,
} from "../../shared/time";

const REMINDER_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 50;

export interface StreakStatus {
  currentStreak: number;
  longestStreak: number;
  active: boolean;
  expiresAt: Date | null;
  lastLocalDate: Date | null;
}

export interface QualifyConversationData {
  userId: string;
  userPromptId: string;
  qualifiedAt?: Date;
}

export interface StreakQualification {
  currentStreak: number;
  longestStreak: number;
  isNewRecord: boolean;
  localDate: Date;
  expiresAt: Date;
}

export interface StreakReminderClaim {
  reminderId: string;
  claimToken: string;
  userId: string;
}

export interface StreakReminderAttempt {
  reminderId: string;
  claimToken: string;
  userId: string;
  telegramId: bigint;
  currentStreak: number;
  attemptedAt: Date;
}

@Injectable()
export class StreakService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(userId: string, now = new Date()): Promise<StreakStatus | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    const active =
      user.currentStreak > 0 &&
      user.streakExpiresAt !== null &&
      user.streakExpiresAt.getTime() > now.getTime();
    return {
      currentStreak: active ? user.currentStreak : 0,
      longestStreak: user.longestStreak,
      active,
      expiresAt: user.streakExpiresAt,
      lastLocalDate: user.lastStreakLocalDate,
    };
  }

  /**
   * Qualifies a closed conversation inside the caller's transaction.
   * Requiring TransactionClient prevents a nested transaction from splitting
   * the close, response owner, streak day and snapshot guarantees.
   */
  async qualifyConversation(
    data: QualifyConversationData,
    tx: Prisma.TransactionClient,
  ): Promise<StreakQualification> {
    const qualifiedAt = data.qualifiedAt ?? new Date();
    const [user] = await tx.$queryRaw<User[]>(Prisma.sql`
      SELECT *
      FROM "users"
      WHERE "id" = ${data.userId}
      FOR UPDATE
    `);
    if (!user) throw new Error("user_not_found");

    const timezone = resolveEffectiveTimeZone(user.timezone).timeZone;
    const localDateKey = getLocalDateKey(qualifiedAt, timezone);
    const localDate = this.databaseDate(localDateKey);
    const existing = await tx.streakDay.findUnique({
      where: { userId_localDate: { userId: data.userId, localDate } },
    });
    if (existing) {
      const result = {
        currentStreak: existing.streakLength,
        longestStreak: existing.longestStreak,
        isNewRecord: false,
        localDate,
        expiresAt: user.streakExpiresAt ?? qualifiedAt,
      };
      await this.writeResponseSnapshot(tx, data.userPromptId, result);
      return result;
    }

    const previousDateKey = this.databaseDateKey(user.lastStreakLocalDate);
    const nextCurrent =
      previousDateKey !== null &&
      this.dayDifference(previousDateKey, localDateKey) === 1
        ? user.currentStreak + 1
        : 1;
    const nextLongest = Math.max(user.longestStreak, nextCurrent);
    const isNewRecord = nextCurrent > user.longestStreak;
    const todayRange = getCalendarDayRange(timezone, qualifiedAt);
    const rescueRange = getCalendarDayRange(
      timezone,
      new Date(todayRange.end.getTime() + 1),
    );
    const expiresAt = rescueRange.end;
    const reminderSlot = nextSlotAtOrAfter(
      todayRange.end,
      user.streakReminderHour,
      user.streakReminderMinute,
      timezone,
    );
    const rescueDate = this.databaseDate(reminderSlot.localDate);
    const nextReminderAt = user.streakReminderEnabled
      ? reminderSlot.instant
      : null;

    await tx.streakReminder.updateMany({
      where: {
        userId: data.userId,
        localDate,
        status: "pending",
        deliveryAttemptedAt: null,
      },
      data: {
        status: "cancelled",
        nextAttemptAt: null,
        claimToken: null,
        claimExpiresAt: null,
        lastErrorCode: "qualified_today",
        lastErrorAt: qualifiedAt,
      },
    });

    const updated = await tx.user.update({
      where: { id: data.userId },
      data: {
        currentStreak: nextCurrent,
        longestStreak: nextLongest,
        lastStreakLocalDate: localDate,
        streakExpiresAt: expiresAt,
        nextStreakReminderAt: nextReminderAt,
      },
    });

    await tx.streakDay.create({
      data: {
        userId: data.userId,
        localDate,
        qualifiedAt,
        timezoneSnapshot: timezone,
        kind: "activity",
        streakLength: nextCurrent,
        longestStreak: nextLongest,
        sourceUserPromptId: data.userPromptId,
      },
    });

    if (nextReminderAt) {
      await tx.streakReminder.createMany({
        data: [{
          userId: data.userId,
          localDate: rescueDate,
          nextAttemptAt: nextReminderAt,
          expiresAt,
        }],
        skipDuplicates: true,
      });
      await tx.streakReminder.updateMany({
        where: {
          userId: data.userId,
          localDate: rescueDate,
          status: "pending",
          deliveryAttemptedAt: null,
        },
        data: {
          nextAttemptAt: nextReminderAt,
          expiresAt,
          claimToken: null,
          claimExpiresAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
        },
      });
    }

    const result = {
      currentStreak: updated.currentStreak,
      longestStreak: updated.longestStreak,
      isNewRecord,
      localDate,
      expiresAt,
    };
    await this.writeResponseSnapshot(tx, data.userPromptId, result);
    return result;
  }

  async updateReminderEnabled(
    userId: string,
    enabled: boolean,
    now = new Date(),
  ): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, userId);
      if (!user) throw new Error("user_not_found");
      if (!enabled) {
        await tx.streakReminder.updateMany({
          where: { userId, status: "pending", deliveryAttemptedAt: null },
          data: {
            status: "cancelled",
            nextAttemptAt: null,
            claimToken: null,
            claimExpiresAt: null,
            lastErrorCode: "disabled",
            lastErrorAt: now,
          },
        });
        return tx.user.update({
          where: { id: userId },
          data: { streakReminderEnabled: false, nextStreakReminderAt: null },
        });
      }
      const schedule = this.futureSchedule(user, now);
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          streakReminderEnabled: true,
          nextStreakReminderAt: schedule?.reminderAt ?? null,
        },
      });
      if (schedule?.reminderAt) {
        await this.ensurePendingReminder(tx, userId, {
          ...schedule,
          reminderAt: schedule.reminderAt,
        });
      }
      return updated;
    });
  }

  async updateReminderTime(
    userId: string,
    hour: number,
    minute: number,
    now = new Date(),
  ): Promise<User> {
    validateScheduleTime(hour, minute);
    return this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, userId);
      if (!user) throw new Error("user_not_found");
      const configured = { ...user, streakReminderHour: hour, streakReminderMinute: minute };
      const schedule = this.futureSchedule(configured, now);
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          streakReminderHour: hour,
          streakReminderMinute: minute,
          nextStreakReminderAt:
            user.streakReminderEnabled ? schedule?.reminderAt ?? null : null,
        },
      });
      await tx.streakReminder.updateMany({
        where: {
          userId,
          status: "pending",
          deliveryAttemptedAt: null,
          ...(
            schedule?.reminderAt
              ? { localDate: { not: schedule.localDate } }
              : {}
          ),
        },
        data: {
          status: "cancelled",
          nextAttemptAt: null,
          claimToken: null,
          claimExpiresAt: null,
          lastErrorCode: "rescheduled",
          lastErrorAt: now,
        },
      });
      if (user.streakReminderEnabled && schedule?.reminderAt) {
        await this.ensurePendingReminder(tx, userId, {
          ...schedule,
          reminderAt: schedule.reminderAt,
        });
      }
      return updated;
    });
  }

  async rescheduleForTimezone(
    userId: string,
    now = new Date(),
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, userId);
      if (!user) return;
      await this.rescheduleForTimezoneInTransaction(tx, user, now);
    });
  }

  async rescheduleForTimezoneInTransaction(
    tx: Prisma.TransactionClient,
    user: User,
    now = new Date(),
  ): Promise<User> {
    const wasActive =
      user.currentStreak > 0 &&
      user.lastStreakLocalDate !== null &&
      user.streakExpiresAt !== null &&
      user.streakExpiresAt.getTime() > now.getTime();
    const schedule = wasActive
      ? this.futureSchedule(user, now, false)
      : null;

    await tx.streakReminder.updateMany({
      where: {
        userId: user.id,
        status: "pending",
        deliveryAttemptedAt: { not: null },
      },
      data: {
        status: "failed",
        nextAttemptAt: null,
        claimToken: null,
        claimExpiresAt: null,
        lastErrorCode: "timezone_changed_after_io",
        lastErrorAt: now,
      },
    });
    await tx.streakReminder.updateMany({
      where: {
        userId: user.id,
        status: "pending",
        deliveryAttemptedAt: null,
        ...(
          wasActive && schedule?.reminderAt
            ? { localDate: { not: schedule.localDate } }
            : {}
        ),
      },
      data: {
        status: "cancelled",
        nextAttemptAt: null,
        claimToken: null,
        claimExpiresAt: null,
        lastErrorCode: wasActive ? "timezone_changed" : "streak_expired",
        lastErrorAt: now,
      },
    });
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        streakExpiresAt: wasActive ? schedule?.expiresAt ?? user.streakExpiresAt : user.streakExpiresAt,
        nextStreakReminderAt:
          wasActive && user.streakReminderEnabled
            ? schedule?.reminderAt ?? null
            : null,
      },
    });
    if (wasActive && user.streakReminderEnabled && schedule?.reminderAt) {
      await this.ensurePendingReminder(tx, user.id, {
        ...schedule,
        reminderAt: schedule.reminderAt,
      });
    }
    return updated;
  }

  async claimDueReminders(
    limit = DEFAULT_BATCH_SIZE,
    now = new Date(),
  ): Promise<StreakReminderClaim[]> {
    const normalizedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "users" u
        SET "nextStreakReminderAt" = NULL
        WHERE EXISTS (
          SELECT 1
          FROM "streak_reminders" r
          WHERE r."userId" = u."id"
            AND r."status" = 'pending'
            AND r."deliveryAttemptedAt" IS NOT NULL
            AND (
              r."claimExpiresAt" <= ${now}
              OR r."expiresAt" <= ${now}
            )
        )
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "users" u
        SET "nextStreakReminderAt" = NULL
        WHERE u."nextStreakReminderAt" IS NOT NULL
          AND u."nextStreakReminderAt" <= ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM "streak_reminders" r
            WHERE r."userId" = u."id"
              AND r."status" = 'pending'
              AND r."nextAttemptAt" IS NOT NULL
              AND r."expiresAt" > ${now}
          )
      `);
      await tx.streakReminder.updateMany({
        where: {
          status: "pending",
          deliveryAttemptedAt: { not: null },
          OR: [
            { claimExpiresAt: { lte: now } },
            { expiresAt: { lte: now } },
          ],
        },
        data: {
          status: "failed",
          nextAttemptAt: null,
          claimToken: null,
          claimExpiresAt: null,
          lastErrorCode: "lease_expired_after_io",
          lastErrorAt: now,
        },
      });
      await tx.streakReminder.updateMany({
        where: {
          status: "pending",
          deliveryAttemptedAt: null,
          expiresAt: { lte: now },
        },
        data: {
          status: "expired",
          nextAttemptAt: null,
          claimToken: null,
          claimExpiresAt: null,
          lastErrorCode: "deadline_expired",
          lastErrorAt: now,
        },
      });
      const rows = await tx.$queryRaw<Array<{ id: string; userId: string }>>(Prisma.sql`
        SELECT r."id", r."userId"
        FROM "streak_reminders" r
        JOIN "users" u ON u."id" = r."userId"
        WHERE r."status" = 'pending'
          AND r."nextAttemptAt" IS NOT NULL
          AND r."nextAttemptAt" <= ${now}
          AND r."expiresAt" > ${now}
          AND r."deliveryAttemptedAt" IS NULL
          AND (r."claimToken" IS NULL OR r."claimExpiresAt" <= ${now})
          AND u."streakReminderEnabled" = true
          AND u."nextStreakReminderAt" IS NOT NULL
          AND u."nextStreakReminderAt" <= ${now}
        ORDER BY r."nextAttemptAt", r."id"
        FOR UPDATE OF r SKIP LOCKED
        LIMIT ${normalizedLimit}
      `);
      const claims: StreakReminderClaim[] = [];
      for (const row of rows) {
        const claimToken = randomUUID();
        const claimExpiresAt = new Date(now.getTime() + REMINDER_LEASE_MS);
        const claimed = await tx.streakReminder.updateMany({
          where: { id: row.id, status: "pending" },
          data: { claimToken, claimExpiresAt },
        });
        if (claimed.count === 1) {
          claims.push({ reminderId: row.id, userId: row.userId, claimToken });
        }
      }
      return claims;
    });
  }

  async beginReminderAttempt(
    claim: StreakReminderClaim,
    attemptedAt = new Date(),
  ): Promise<StreakReminderAttempt | null> {
    return this.prisma.$transaction(async (tx) => {
      const hint = await tx.streakReminder.findUnique({
        where: { id: claim.reminderId },
        select: { userId: true },
      });
      if (!hint) return null;
      // Keep the global mutation order User -> StreakReminder. Qualification
      // uses the same order, avoiding a close-vs-send deadlock.
      const user = await this.lockUser(tx, hint.userId);
      if (!user) return null;
      const [reminder] = await tx.$queryRaw<Array<{
        id: string; userId: string; localDate: Date; expiresAt: Date;
        status: string; claimToken: string | null; claimExpiresAt: Date | null;
      }>>(Prisma.sql`
        SELECT "id", "userId", "localDate", "expiresAt", "status", "claimToken", "claimExpiresAt"
        FROM "streak_reminders"
        WHERE "id" = ${claim.reminderId}
        FOR UPDATE
      `);
      if (
        !reminder ||
        reminder.userId !== user.id ||
        reminder.status !== "pending" ||
        reminder.claimToken !== claim.claimToken ||
        !reminder.claimExpiresAt ||
        reminder.claimExpiresAt.getTime() <= attemptedAt.getTime()
      ) return null;
      const timezone = resolveEffectiveTimeZone(user.timezone).timeZone;
      const todayKey = getLocalDateKey(attemptedAt, timezone);
      const lastKey = this.databaseDateKey(user.lastStreakLocalDate);
      const eligible =
        user.streakReminderEnabled &&
        user.currentStreak > 0 &&
        user.streakExpiresAt !== null &&
        user.streakExpiresAt.getTime() > attemptedAt.getTime() &&
        reminder.expiresAt.getTime() > attemptedAt.getTime() &&
        this.databaseDateKey(reminder.localDate) === todayKey &&
        lastKey !== null &&
        this.dayDifference(lastKey, todayKey) === 1 &&
        !(await tx.streakDay.findUnique({
          where: {
            userId_localDate: {
              userId: user.id,
              localDate: this.databaseDate(todayKey),
            },
          },
        }));
      if (!eligible) {
        await tx.streakReminder.update({
          where: { id: reminder.id },
          data: {
            status:
              reminder.expiresAt.getTime() <= attemptedAt.getTime()
                ? "expired"
                : "cancelled",
            nextAttemptAt: null,
            claimToken: null,
            claimExpiresAt: null,
            lastErrorCode: "not_eligible",
            lastErrorAt: attemptedAt,
          },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { nextStreakReminderAt: null },
        });
        return null;
      }
      await tx.streakReminder.update({
        where: { id: reminder.id },
        data: {
          attemptCount: { increment: 1 },
          deliveryAttemptedAt: attemptedAt,
          nextAttemptAt: null,
          lastErrorCode: "telegram_outcome_unknown",
          lastErrorAt: attemptedAt,
        },
      });
      return {
        reminderId: reminder.id,
        claimToken: claim.claimToken,
        userId: user.id,
        telegramId: user.telegramId,
        currentStreak: user.currentStreak,
        attemptedAt,
      };
    });
  }

  async completeReminderSuccess(attempt: StreakReminderAttempt, sentAt = new Date()): Promise<boolean> {
    const result = await this.prisma.$transaction(async (tx) => {
      if (!(await this.lockUser(tx, attempt.userId))) return false;
      const updated = await tx.streakReminder.updateMany({
        where: {
          id: attempt.reminderId,
          status: "pending",
          claimToken: attempt.claimToken,
          deliveryAttemptedAt: attempt.attemptedAt,
        },
        data: {
          status: "sent",
          sentAt,
          claimToken: null,
          claimExpiresAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
        },
      });
      if (updated.count === 1) {
        await tx.user.updateMany({
          where: { id: attempt.userId },
          data: { nextStreakReminderAt: null },
        });
      }
      return updated.count === 1;
    });
    return result;
  }

  async completeReminderRetryableFailure(
    attempt: StreakReminderAttempt,
    errorCode: string,
    failedAt = new Date(),
    retryAfterSeconds?: number,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.lockUser(tx, attempt.userId))) return false;
      const reminder = await tx.streakReminder.findUnique({
        where: { id: attempt.reminderId },
      });
      if (
        !reminder ||
        reminder.status !== "pending" ||
        reminder.claimToken !== attempt.claimToken ||
        reminder.deliveryAttemptedAt?.getTime() !== attempt.attemptedAt.getTime()
      ) return false;
      const exponentialBackoffMs = Math.min(
        60 * 60 * 1000,
        60 * 1000 * 2 ** Math.max(0, reminder.attemptCount - 1),
      );
      const retryAfterMs =
        typeof retryAfterSeconds === "number" &&
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds >= 0
          ? Math.ceil(retryAfterSeconds) * 1000
          : 0;
      const backoffMs = Math.max(exponentialBackoffMs, retryAfterMs);
      const remainingMs = reminder.expiresAt.getTime() - failedAt.getTime();
      const expired = remainingMs <= 0 || backoffMs >= remainingMs;
      const nextAttemptAt = expired
        ? null
        : new Date(failedAt.getTime() + backoffMs);
      await tx.streakReminder.update({
        where: { id: reminder.id },
        data: {
          status: expired ? "expired" : "pending",
          deliveryAttemptedAt: null,
          nextAttemptAt,
          claimToken: null,
          claimExpiresAt: null,
          lastErrorCode: this.sanitizeErrorCode(errorCode),
          lastErrorAt: failedAt,
        },
      });
      await tx.user.updateMany({
        where: { id: attempt.userId },
        data: { nextStreakReminderAt: nextAttemptAt },
      });
      return true;
    });
  }

  async completeReminderTerminalFailure(
    attempt: StreakReminderAttempt,
    errorCode: string,
    failedAt = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.lockUser(tx, attempt.userId))) return false;
      const updated = await tx.streakReminder.updateMany({
        where: {
          id: attempt.reminderId,
          status: "pending",
          claimToken: attempt.claimToken,
          deliveryAttemptedAt: attempt.attemptedAt,
        },
        data: {
          status: "failed",
          nextAttemptAt: null,
          claimToken: null,
          claimExpiresAt: null,
          lastErrorCode: this.sanitizeErrorCode(errorCode),
          lastErrorAt: failedAt,
        },
      });
      if (updated.count === 1) {
        await tx.user.updateMany({
          where: { id: attempt.userId },
          data: { nextStreakReminderAt: null },
        });
      }
      return updated.count === 1;
    });
  }

  private async writeResponseSnapshot(
    tx: Prisma.TransactionClient,
    userPromptId: string,
    result: Pick<StreakQualification, "currentStreak" | "longestStreak" | "isNewRecord">,
  ): Promise<void> {
    await tx.userResponse.updateMany({
      where: { userPromptId },
      data: {
        streakCurrentSnapshot: result.currentStreak,
        streakLongestSnapshot: result.longestStreak,
        streakIsNewRecord: result.isNewRecord,
      },
    });
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<User | null> {
    const [user] = await tx.$queryRaw<User[]>(Prisma.sql`
      SELECT * FROM "users" WHERE "id" = ${userId} FOR UPDATE
    `);
    return user ?? null;
  }

  private futureSchedule(
    user: Pick<User, "timezone" | "lastStreakLocalDate" | "streakExpiresAt" | "currentStreak" | "streakReminderHour" | "streakReminderMinute">,
    now: Date,
    requireStoredActive = true,
  ): { localDate: Date; reminderAt: Date | null; expiresAt: Date } | null {
    if (
      user.currentStreak <= 0 ||
      !user.lastStreakLocalDate ||
      (
        requireStoredActive &&
        (
          !user.streakExpiresAt ||
          user.streakExpiresAt.getTime() <= now.getTime()
        )
      )
    ) return null;
    const timezone = resolveEffectiveTimeZone(user.timezone).timeZone;
    const lastDateKey = this.databaseDateKey(user.lastStreakLocalDate);
    if (!lastDateKey) return null;
    const rescueDateKey = this.addDatabaseDays(lastDateKey, 1);
    const expiryDateKey = this.addDatabaseDays(lastDateKey, 2);
    const rescueDate = this.localDateParts(rescueDateKey);
    const reminderAt = resolveWallClock(
      rescueDate,
      user.streakReminderHour,
      user.streakReminderMinute,
      timezone,
    );
    const expiresAt = resolveWallClock(
      this.localDateParts(expiryDateKey),
      0,
      0,
      timezone,
    );
    return {
      localDate: this.databaseDate(rescueDateKey),
      reminderAt:
        reminderAt.getTime() >= now.getTime() &&
        expiresAt.getTime() > now.getTime()
          ? reminderAt
          : null,
      expiresAt,
    };
  }

  private async ensurePendingReminder(
    tx: Prisma.TransactionClient,
    userId: string,
    schedule: { localDate: Date; reminderAt: Date; expiresAt: Date },
  ): Promise<void> {
    await tx.streakReminder.createMany({
      data: [{
        userId,
        localDate: schedule.localDate,
        nextAttemptAt: schedule.reminderAt,
        expiresAt: schedule.expiresAt,
      }],
      skipDuplicates: true,
    });
    await tx.streakReminder.updateMany({
      where: {
        userId,
        localDate: schedule.localDate,
        status: { in: ["pending", "cancelled"] },
        deliveryAttemptedAt: null,
      },
      data: {
        status: "pending",
        nextAttemptAt: schedule.reminderAt,
        expiresAt: schedule.expiresAt,
        claimToken: null,
        claimExpiresAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
      },
    });
  }

  private databaseDate(key: string): Date {
    return new Date(`${key}T00:00:00.000Z`);
  }

  private databaseDateKey(value: Date | null): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
  }

  private addDatabaseDays(key: string, days: number): string {
    return new Date(
      this.databaseDate(key).getTime() + days * 24 * 60 * 60 * 1000,
    ).toISOString().slice(0, 10);
  }

  private localDateParts(key: string): { year: number; month: number; day: number } {
    const [year, month, day] = key.split("-").map(Number);
    return { year, month, day };
  }

  private dayDifference(from: string, to: string): number {
    return Math.round(
      (this.databaseDate(to).getTime() - this.databaseDate(from).getTime()) /
        (24 * 60 * 60 * 1000),
    );
  }

  private sanitizeErrorCode(value: string): string {
    const sanitized = value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
    return sanitized || "unknown_error";
  }
}
