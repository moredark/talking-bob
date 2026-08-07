export interface DeliveryClaim {
  userPromptId: string;
  claimToken: string;
  user: {
    id: string;
    telegramId: bigint;
  };
  prompt: {
    id: string;
    topic: string;
    audioFileId: string | null;
  };
}

export type DeliveryOutcome = "sent" | "failed" | "pending" | "not_attempted";

/**
 * Interface for message dispatching.
 * Separates the "what to send" logic from the "when to send" logic.
 * This allows different implementations (e.g., different message types)
 * without changing the scheduler.
 */
export interface IMessageDispatcher {
  /**
   * Attempt a previously persisted manual or scheduled delivery claim.
   * The outcome describes the durable state after the attempt.
   */
  dispatch(claim: DeliveryClaim): Promise<DeliveryOutcome>;
}

export const MESSAGE_DISPATCHER = Symbol("MESSAGE_DISPATCHER");
