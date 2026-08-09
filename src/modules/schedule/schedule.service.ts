import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { User } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { DeliveryClaim } from "./message-dispatcher.interface";
import { ScheduleClaimsOperations } from "./schedule-claims.operations";
import { ScheduleDeliveryOperations } from "./schedule-delivery.operations";
import {
  DEFAULT_BATCH_SIZE,
  ScheduleSettings,
  ScheduleSettingsOperations,
} from "./schedule-settings.operations";

export { PROMPT_REPEAT_WINDOW } from "./schedule-claims.operations";
export type { ScheduleSettings } from "./schedule-settings.operations";

@Injectable()
export class ScheduleService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleService.name);
  private readonly settingsOperations: ScheduleSettingsOperations;
  private readonly claimsOperations: ScheduleClaimsOperations;
  private readonly deliveryOperations: ScheduleDeliveryOperations;

  constructor(prisma: PrismaService) {
    this.settingsOperations = new ScheduleSettingsOperations(prisma);
    this.claimsOperations = new ScheduleClaimsOperations(prisma);
    this.deliveryOperations = new ScheduleDeliveryOperations(prisma);
  }

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
    return this.settingsOperations.normalizeAllSchedules(batchSize, now);
  }

  async repairAllSchedules(
    batchSize = DEFAULT_BATCH_SIZE,
    now = new Date(),
  ): Promise<number> {
    return this.settingsOperations.repairAllSchedules(batchSize, now);
  }

  async repairSchedules(
    limit = DEFAULT_BATCH_SIZE,
    now = new Date(),
  ): Promise<number> {
    return this.settingsOperations.repairSchedules(limit, now);
  }

  async updateScheduleSettings(
    userId: string,
    settings: ScheduleSettings,
    now = new Date(),
  ): Promise<User> {
    return this.settingsOperations.updateScheduleSettings(userId, settings, now);
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
    return this.claimsOperations.claimScheduledBatch(limit, now);
  }

  async createManualClaim(
    user: Pick<User, "id" | "telegramId">,
    now = new Date(),
  ): Promise<DeliveryClaim | null> {
    return this.claimsOperations.createManualClaim(user, now);
  }

  async beginDeliveryAttempt(
    claim: DeliveryClaim,
    attemptedAt = new Date(),
  ): Promise<Date | null> {
    return this.deliveryOperations.beginDeliveryAttempt(claim, attemptedAt);
  }

  async completeDeliverySuccess(
    claim: DeliveryClaim,
    attemptedAt: Date,
    sentAt = new Date(),
  ): Promise<boolean> {
    return this.deliveryOperations.completeDeliverySuccess(
      claim,
      attemptedAt,
      sentAt,
    );
  }

  async completeDeliveryDefiniteFailure(
    claim: DeliveryClaim,
    attemptedAt: Date,
    failedAt = new Date(),
  ): Promise<boolean> {
    return this.deliveryOperations.completeDeliveryDefiniteFailure(
      claim,
      attemptedAt,
      failedAt,
    );
  }

  async completeDeliveryAmbiguousFailure(
    claim: DeliveryClaim,
    attemptedAt: Date,
    failedAt = new Date(),
  ): Promise<boolean> {
    return this.deliveryOperations.completeDeliveryAmbiguousFailure(
      claim,
      attemptedAt,
      failedAt,
    );
  }
}
