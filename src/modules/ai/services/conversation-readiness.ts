import { ConversationMessage, ConversationReadiness } from "../interfaces";

type ReadinessCandidate = {
  ready: boolean;
  lastQuestionAnswered: boolean;
  question?: string;
};

/** Count meaningful sentence-like units in learner messages without trusting Whisper punctuation. */
export function countMeaningfulSentenceUnits(history: ConversationMessage[]): number {
  return history.filter((message) => message.role === "user").reduce((count, message) => {
    const text = message.content.trim();
    if (!text) return count;
    const units = text.split(/[.!?]+/).map((unit) => unit.trim()).filter(Boolean);
    const candidates = units.length > 0 ? units : [text];
    return count + candidates.filter((unit) => (unit.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length >= 2).length;
  }, 0);
}

function isValidReadiness(
  value: unknown,
  lastQuestion: string,
): value is ReadinessCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReadinessCandidate>;
  if (
    typeof candidate.ready !== "boolean" ||
    typeof candidate.lastQuestionAnswered !== "boolean"
  ) {
    return false;
  }
  return (
    candidate.ready ||
    (!candidate.lastQuestionAnswered && !!lastQuestion) ||
    (typeof candidate.question === "string" && !!candidate.question.trim())
  );
}

function parseReadinessResponse(
  content: string | null,
  lastQuestion: string,
): unknown {
  let normalized = (content ?? "").trim();
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) normalized = fenced[1].trim();

  const tryCandidate = (candidate: string): unknown | undefined => {
    try {
      const parsed = JSON.parse(candidate);
      return isValidReadiness(parsed, lastQuestion) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const whole = tryCandidate(normalized);
  if (whole !== undefined) return whole;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = tryCandidate(normalized.slice(start, index + 1));
        if (candidate !== undefined) return candidate;
        start = -1;
      }
    }
  }

  throw new Error("invalid_conversation_readiness");
}

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
        meaningfulSentenceCount: countMeaningfulSentenceUnits(history),
      }),
    },
  ]);
  const result = parseReadinessResponse(content, lastQuestion);
  if (!isValidReadiness(result, lastQuestion))
    throw new Error("invalid_conversation_readiness");
  const value = result;
  const meaningfulSentenceCount = countMeaningfulSentenceUnits(history);
  const ready = meaningfulSentenceCount >= 2 && value.ready;
  const question = !value.lastQuestionAnswered && lastQuestion
    ? lastQuestion.trim()
    : value.question?.trim() || lastQuestion.trim();
  if (!ready && !question) throw new Error("invalid_conversation_readiness");
  return {
    ready,
    lastQuestionAnswered: value.lastQuestionAnswered,
    question: ready ? "" : question,
    ...(ready ? {} : { insufficiencyReason: meaningfulSentenceCount < 2 ? "too_short" as const : "needs_detail" as const }),
  };
}
