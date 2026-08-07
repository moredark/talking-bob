import { randomUUID } from "node:crypto";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  Prisma,
  Prompt,
  User,
  UserPromptDeliveryStatus,
  UserPromptSource,
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  latestSlotAtOrBefore,
  nextSlotAtOrAfter,
  nextSlotStrictlyAfter,
  resolveEffectiveTimeZone,
  validateScheduleTime,
} from "../../shared/time";
import { DeliveryClaim } from "./message-dispatcher.interface";

const DEFAULT_PROMPT_HOUR = 13;
const DEFAULT_PROMPT_MINUTE = 0;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 100;
const CLAIM_LEASE_MS = 2 * 60 * 1000;

interface RepairRow {
  id: string;
  timezone: string;
  dailyPromptHour: number;
  dailyPromptMinute: number;
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

interface DueUserRow extends RepairRow {
  telegramId: bigint;
}

interface ReclaimRow {
  userPromptId: string;
  userId: string;
  telegramId: bigint;
  promptId: string;
  topic: string;
  audioFileId: string | null;
}

export interface ScheduleSettings {
  dailyPromptEnabled?: boolean;
  dailyPromptHour?: number;
  dailyPromptMinute?: number;
  timezone?: string | null;
}

@Injectable()
export class ScheduleService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const normalized = await this.normalizeAllSchedules();
    if (normalized > 0) {
      this.logger.log(`Normalized ${normalized} user schedules`);
    }
  }

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
          "dailyPromptMinute"
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
        const nextPromptAt = nextSlotAtOrAfter(
          now,
          hour,
          minute,
          timezone,
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
        } else if (row.dailyPromptEnabled && row.nextPromptAt === null) {
          data.nextPromptAt = nextSlotAtOrAfter(
            now,
            hour,
            minute,
            timezone,
          ).instant;
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

      const timezone = resolveEffectiveTimeZone(
        settings.timezone === undefined ? locked.timezone : settings.timezone,
      ).timeZone;
      const enabled =
        settings.dailyPromptEnabled ?? locked.dailyPromptEnabled;
      const nextPromptAt = enabled
        ? nextSlotAtOrAfter(now, hour, minute, timezone).instant
        : null;

      return tx.user.update({
        where: { id: userId },
        data: {
          dailyPromptEnabled: enabled,
          dailyPromptHour: hour,
          dailyPromptMinute: minute,
          timezone,
          nextPromptAt,
        },
      });
    });
  }

  async initializeSchedule(
    userId: string,
    hour: number,
    minute: number,
    timezone: string,
  ): Promise<User> {
    return this.updateScheduleSettings(userId, {
      dailyPromptHour: hour,
      dailyPromptMinute: minute,
      timezone,
    });
  }

  async disableSchedule(userId: string): Promise<User> {
    return this.updateScheduleSettings(userId, {
      dailyPromptEnabled: false,
    });
  }

  async enableSchedule(userId: string): Promise<User> {
    return this.updateScheduleSettings(userId, {
      dailyPromptEnabled: true,
    });
  }

  async claimScheduledBatch(
    limit = DEFAULT_BATCH_SIZE,
    now = new Date(),
  ): Promise<DeliveryClaim[]> {
    const batchSize = this.normalizeBatchSize(limit);

    return this.prisma.$transaction(async (tx) => {
      const claims = await this.reclaimExpiredScheduledClaims(
        tx,
        batchSize,
        now,
      );
      const remaining = batchSize - claims.length;
      if (remaining === 0) return claims;

      const prompts = await tx.prompt.findMany({
        where: { isActive: true },
        select: {
          id: true,
          topic: true,
          audioFileId: true,
        },
      });
      if (prompts.length === 0) return claims;

      const dueUsers = await tx.$queryRaw<DueUserRow[]>(Prisma.sql`
        SELECT
          "id",
          "telegramId",
          "timezone",
          "dailyPromptHour",
          "dailyPromptMinute"
        FROM "users"
        WHERE "dailyPromptEnabled" = true
          AND "nextPromptAt" <= ${now}
        ORDER BY "nextPromptAt", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${remaining}
      `);

      for (const user of dueUsers) {
        const hour = this.validHour(user.dailyPromptHour)
          ? user.dailyPromptHour
          : DEFAULT_PROMPT_HOUR;
        const minute = this.validMinute(user.dailyPromptMinute)
          ? user.dailyPromptMinute
          : DEFAULT_PROMPT_MINUTE;
        const timezone = resolveEffectiveTimeZone(user.timezone).timeZone;
        const occurrence = latestSlotAtOrBefore(
          now,
          hour,
          minute,
          timezone,
        );
        const nextPromptAt = nextSlotStrictlyAfter(
          now,
          hour,
          minute,
          timezone,
        ).instant;
        const occurrenceKey = `scheduled:${user.id}:${occurrence.localDate}`;
        const prompt = prompts[Math.floor(Math.random() * prompts.length)];
        const claimToken = randomUUID();
        const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);

        const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "user_prompts" (
            "id",
            "userId",
            "promptId",
            "source",
            "deliveryStatus",
            "createdAt",
            "scheduledFor",
            "scheduledOccurrenceKey",
            "scheduledLocalDate",
            "timezoneSnapshot",
            "claimToken",
            "claimExpiresAt"
          )
          VALUES (
            ${randomUUID()},
            ${user.id},
            ${prompt.id},
            'scheduled'::"UserPromptSource",
            'pending'::"UserPromptDeliveryStatus",
            ${now},
            ${occurrence.instant},
            ${occurrenceKey},
            CAST(${occurrence.localDate} AS date),
            ${timezone},
            ${claimToken}::uuid,
            ${claimExpiresAt}
          )
          ON CONFLICT ("scheduledOccurrenceKey")
            WHERE "scheduledOccurrenceKey" IS NOT NULL
          DO NOTHING
          RETURNING "id"
        `);

        await tx.user.update({
          where: { id: user.id },
          data: {
            dailyPromptHour: hour,
            dailyPromptMinute: minute,
            timezone,
            nextPromptAt,
          },
        });

        if (inserted[0]) {
          claims.push({
            userPromptId: inserted[0].id,
            claimToken,
            user: {
              id: user.id,
              telegramId: user.telegramId,
            },
            prompt,
          });
        }
      }

      return claims;
    });
  }

  async createManualClaim(
    user: Pick<User, "id" | "telegramId">,
    prompt: Pick<Prompt, "id" | "topic" | "audioFileId">,
    now = new Date(),
  ): Promise<DeliveryClaim> {
    const claimToken = randomUUID();
    const record = await this.prisma.userPrompt.create({
      data: {
        userId: user.id,
        promptId: prompt.id,
        source: UserPromptSource.manual,
        deliveryStatus: UserPromptDeliveryStatus.pending,
        claimToken,
        claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      },
      select: { id: true },
    });

    return {
      userPromptId: record.id,
      claimToken,
      user: { id: user.id, telegramId: user.telegramId },
      prompt: {
        id: prompt.id,
        topic: prompt.topic,
        audioFileId: prompt.audioFileId,
      },
    };
  }

  async beginDeliveryAttempt(
    claim: DeliveryClaim,
    attemptedAt = new Date(),
  ): Promise<Date | null> {
    const result = await this.prisma.userPrompt.updateMany({
      where: {
        id: claim.userPromptId,
        claimToken: claim.claimToken,
        deliveryStatus: UserPromptDeliveryStatus.pending,
        deliveryAttemptedAt: null,
      },
      data: {
        deliveryAttemptedAt: attemptedAt,
        lastDeliveryErrorCode: "telegram_outcome_unknown",
        lastDeliveryErrorAt: attemptedAt,
        claimToken: null,
        claimExpiresAt: null,
      },
    });

    return result.count === 1 ? attemptedAt : null;
  }

  async completeDeliverySuccess(
    claim: DeliveryClaim,
    attemptedAt: Date,
    sentAt = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.userPrompt.updateMany({
        where: {
          id: claim.userPromptId,
          deliveryStatus: UserPromptDeliveryStatus.pending,
          deliveryAttemptedAt: attemptedAt,
        },
        data: {
          deliveryStatus: UserPromptDeliveryStatus.sent,
          sentAt,
          lastDeliveryErrorCode: null,
          lastDeliveryErrorAt: null,
          claimToken: null,
          claimExpiresAt: null,
        },
      });

      if (result.count === 1) {
        await tx.user.update({
          where: { id: claim.user.id },
          data: { lastPromptSentAt: sentAt },
        });
      }

      return result.count === 1;
    });
  }

  async completeDeliveryDefiniteFailure(
    claim: DeliveryClaim,
    attemptedAt: Date,
    failedAt = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.userPrompt.updateMany({
      where: {
        id: claim.userPromptId,
        deliveryStatus: UserPromptDeliveryStatus.pending,
        deliveryAttemptedAt: attemptedAt,
      },
      data: {
        deliveryStatus: UserPromptDeliveryStatus.failed,
        sentAt: null,
        lastDeliveryErrorCode: "telegram_api_rejected",
        lastDeliveryErrorAt: failedAt,
        claimToken: null,
        claimExpiresAt: null,
      },
    });

    return result.count === 1;
  }

  async completeDeliveryAmbiguousFailure(
    claim: DeliveryClaim,
    attemptedAt: Date,
    failedAt = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.userPrompt.updateMany({
      where: {
        id: claim.userPromptId,
        deliveryStatus: UserPromptDeliveryStatus.pending,
        deliveryAttemptedAt: attemptedAt,
      },
      data: {
        lastDeliveryErrorCode: "telegram_transport_unknown",
        lastDeliveryErrorAt: failedAt,
        claimToken: null,
        claimExpiresAt: null,
      },
    });

    return result.count === 1;
  }

  private async reclaimExpiredScheduledClaims(
    tx: Prisma.TransactionClient,
    limit: number,
    now: Date,
  ): Promise<DeliveryClaim[]> {
    const rows = await tx.$queryRaw<ReclaimRow[]>(Prisma.sql`
      SELECT
        up."id" AS "userPromptId",
        u."id" AS "userId",
        u."telegramId",
        p."id" AS "promptId",
        p."topic",
        p."audioFileId"
      FROM "user_prompts" up
      JOIN "users" u ON u."id" = up."userId"
      JOIN "prompts" p ON p."id" = up."promptId"
      WHERE up."source" = 'scheduled'::"UserPromptSource"
        AND up."deliveryStatus" = 'pending'::"UserPromptDeliveryStatus"
        AND up."deliveryAttemptedAt" IS NULL
        AND up."claimExpiresAt" <= ${now}
      ORDER BY up."claimExpiresAt", up."id"
      FOR UPDATE OF up SKIP LOCKED
      LIMIT ${limit}
    `);

    const claims: DeliveryClaim[] = [];
    for (const row of rows) {
      const claimToken = randomUUID();
      await tx.userPrompt.update({
        where: { id: row.userPromptId },
        data: {
          claimToken,
          claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        },
      });
      claims.push({
        userPromptId: row.userPromptId,
        claimToken,
        user: {
          id: row.userId,
          telegramId: row.telegramId,
        },
        prompt: {
          id: row.promptId,
          topic: row.topic,
          audioFileId: row.audioFileId,
        },
      });
    }

    return claims;
  }

  private normalizeBatchSize(limit: number): number {
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
