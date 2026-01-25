import { User } from "@prisma/client";

/**
 * Interface for message dispatching.
 * Separates the "what to send" logic from the "when to send" logic.
 * This allows different implementations (e.g., different message types)
 * without changing the scheduler.
 */
export interface IMessageDispatcher {
  /**
   * Send a scheduled message to a user.
   * @param user The user to send the message to
   * @returns true if the message was sent successfully, false otherwise
   */
  dispatch(user: User): Promise<boolean>;
}

export const MESSAGE_DISPATCHER = Symbol("MESSAGE_DISPATCHER");
