import type { ConversationReadiness } from "../ai/interfaces";

export const READINESS_EXPLANATION = "Пока недостаточно материала для полезного разбора. Добавьте, пожалуйста, немного деталей:";
export const READINESS_DUPLICATE_EXPLANATION = "Для отчёта нужен более подробный ответ. Ответьте, пожалуйста, на последний вопрос выше.";

export function readinessExplanation(readiness?: Partial<Pick<ConversationReadiness, "insufficiencyReason" | "lastQuestionAnswered">>): string {
  if (readiness?.insufficiencyReason === "too_short") return "Одного предложения пока недостаточно для отчёта. Расскажите, пожалуйста, подробнее:";
  if (readiness?.insufficiencyReason === "needs_detail" && readiness.lastQuestionAnswered === false) return "Пожалуйста, ответьте на последний вопрос, чтобы добавить деталей:";
  return READINESS_EXPLANATION;
}

export function readinessReply(question: string, readiness?: Pick<ConversationReadiness, "insufficiencyReason" | "lastQuestionAnswered">): string {
  return `${readinessExplanation(readiness)}\n\n${question}`;
}
