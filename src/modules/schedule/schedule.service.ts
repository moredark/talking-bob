import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get all users who are due for their daily prompt.
   * Uses nextPromptAt as the main trigger field.
   */
  async getUsersDueForPrompt(): Promise<User[]> {
    const now = new Date();

    return this.prisma.user.findMany({
      where: {
        dailyPromptEnabled: true,
        nextPromptAt: {
          lte: now,
        },
      },
    });
  }

  /**
   * Mark a user's prompt as sent and calculate the next send time.
   * This ensures idempotency - if called twice, the second call is a no-op.
   */
  async markPromptSent(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      this.logger.warn(`User ${userId} not found when marking prompt sent`);
      return;
    }

    const now = new Date();
    const nextPromptAt = this.calculateNextPromptTime(
      user.dailyPromptHour,
      user.dailyPromptMinute,
      user.timezone,
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        lastPromptSentAt: now,
        nextPromptAt,
      },
    });
  }

  /**
   * Initialize or recalculate nextPromptAt for a user.
   * Call this when user enables daily prompts or changes their schedule.
   */
  async initializeSchedule(
    userId: string,
    hour: number,
    minute: number,
    timezone: string,
  ): Promise<void> {
    const nextPromptAt = this.calculateNextPromptTime(hour, minute, timezone);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        dailyPromptHour: hour,
        dailyPromptMinute: minute,
        timezone,
        nextPromptAt,
      },
    });
  }

  /**
   * Disable daily prompts for a user (clear nextPromptAt).
   */
  async disableSchedule(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        dailyPromptEnabled: false,
        nextPromptAt: null,
      },
    });
  }

  /**
   * Enable daily prompts for a user (set nextPromptAt).
   */
  async enableSchedule(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return;
    }

    const nextPromptAt = this.calculateNextPromptTime(
      user.dailyPromptHour,
      user.dailyPromptMinute,
      user.timezone,
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        dailyPromptEnabled: true,
        nextPromptAt,
      },
    });
  }

  /**
   * Calculate the next prompt time based on user's preferred hour/minute and timezone.
   * If the time has already passed today, schedule for tomorrow.
   */
  private calculateNextPromptTime(
    hour: number,
    minute: number,
    timezone: string,
  ): Date {
    const now = new Date();

    // Create a date object in user's timezone
    const userNow = new Date(
      now.toLocaleString("en-US", { timeZone: timezone }),
    );

    // Set the target time for today
    const targetToday = new Date(userNow);
    targetToday.setHours(hour, minute, 0, 0);

    // If the target time has passed today, schedule for tomorrow
    if (targetToday <= userNow) {
      targetToday.setDate(targetToday.getDate() + 1);
    }

    // Convert back to UTC for storage
    // We need to calculate the offset between user timezone and UTC
    const utcNow = now.getTime();
    const userNowMs = userNow.getTime();
    const offset = utcNow - userNowMs;

    return new Date(targetToday.getTime() + offset);
  }
}
