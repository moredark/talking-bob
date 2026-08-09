import { UserPromptDeliveryStatus } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { DeliveryClaim } from "./message-dispatcher.interface";

export class ScheduleDeliveryOperations {
  constructor(private readonly prisma: PrismaService) {}

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
}
