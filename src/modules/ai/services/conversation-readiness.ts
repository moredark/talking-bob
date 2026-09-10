import { ConversationMessage, ConversationReadiness } from "../interfaces";

/** Assess the same speech sample that analysis will receive, without grading it. */
export async function assessConversationReadiness(
  history: ConversationMessage[],
  initialQuestion: string,
  topic: string,
  readinessPrompt: string,
  request: (
    messages: Array<{ role: string; content: string }>,
  ) => Promise<string | null>,
): Promise<ConversationReadiness> {
  const lastQuestion =
    [...history].reverse().find((message) => message.role === "assistant")
      ?.content ||
    initialQuestion;
  const content = await request([
    {
      role: "system",
      content: readinessPrompt,
    },
    {
      role: "user",
      content: JSON.stringify({
        topic,
        initialQuestion,
        lastQuestion,
        // Keep the evidence aligned with the bounded transcript used by analyzeSpeech.
        studentSpeech: history
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join(" ")
          .trim()
          .slice(0, 1800),
        recentConversation: history.slice(-6).map((message) => ({
          role: message.role,
          content: message.content.slice(0, 400),
        })),
      }),
    },
  ]);
  let result: unknown;
  try {
    result = JSON.parse(
      (content ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
    );
  } catch {
    throw new Error("invalid_conversation_readiness");
  }
  if (!result || typeof result !== "object")
    throw new Error("invalid_conversation_readiness");
  const value = result as Partial<ConversationReadiness>;
  if (
    typeof value.ready !== "boolean" ||
    typeof value.lastQuestionAnswered !== "boolean" ||
    (!value.ready &&
      (value.lastQuestionAnswered || !lastQuestion) &&
      (typeof value.question !== "string" || !value.question.trim()))
  ) {
    throw new Error("invalid_conversation_readiness");
  }
  return {
    ready: value.ready,
    lastQuestionAnswered: value.lastQuestionAnswered,
    question: value.ready
      ? ""
      : value.lastQuestionAnswered || !lastQuestion
        ? value.question!.trim()
        : lastQuestion,
  };
}
