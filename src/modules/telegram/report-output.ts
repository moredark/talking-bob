import type { FeedbackResult } from "../ai";

export const TELEGRAM_TEXT_MESSAGE_LIMIT = 4096;

export type ReportOutputFeedback = FeedbackResult & {
  kind?: "model" | "fallback" | "legacy";
};

export interface ReportStreakSnapshot {
  current: number;
  longest: number;
  isNewRecord: boolean;
}

/** Formats report content as literal Telegram-safe plain text. */
export function formatReportOutput(
  feedback: ReportOutputFeedback,
  transcript: string,
  streak?: ReportStreakSnapshot | null,
): string {
  const lines = [
    "📝 Ваш ответ:",
    `"${transcript}"`,
    "",
    `⭐ Оценка: ${feedback.overallScore}/10`,
    "",
    "💬 Комментарий:",
    feedback.summary,
  ];

  if (feedback.kind === "fallback") {
    lines.push(
      "",
      "ℹ️ Это базовый автоматический отчёт: полный анализ модели недоступен.",
    );
  }

  if (feedback.improvementPoints.length > 0) {
    lines.push("", "📌 Разбор ошибок и улучшений:");
    for (const point of feedback.improvementPoints) {
      lines.push(`• ${point}`);
    }
  }

  if (streak && streak.current > 0) {
    lines.push(
      "",
      streak.isNewRecord
        ? `🔥 Стрик: ${streak.current} дней — новый рекорд!`
        : `🔥 Стрик: ${streak.current} дней`,
    );
  }

  return lines.join("\n");
}

/**
 * Splits text without changing it. Paragraph, line, and word boundaries are
 * preferred in that order; a UTF-16 surrogate pair is never divided.
 */
export function chunkReportOutput(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;

  while (text.length - offset > TELEGRAM_TEXT_MESSAGE_LIMIT) {
    const windowEnd = offset + TELEGRAM_TEXT_MESSAGE_LIMIT;
    const window = text.slice(offset, windowEnd);
    let relativeCut = preferredCut(window);

    if (relativeCut === 0) {
      relativeCut = TELEGRAM_TEXT_MESSAGE_LIMIT;
    }

    let cut = offset + relativeCut;
    if (splitsSurrogatePair(text, cut)) {
      cut -= 1;
    }

    chunks.push(text.slice(offset, cut));
    offset = cut;
  }

  if (offset < text.length) {
    chunks.push(text.slice(offset));
  }

  return chunks;
}

function preferredCut(window: string): number {
  const paragraphBoundary = window.lastIndexOf("\n\n");
  if (paragraphBoundary >= 0) {
    return paragraphBoundary + 2;
  }

  const lineBoundary = window.lastIndexOf("\n");
  if (lineBoundary >= 0) {
    return lineBoundary + 1;
  }

  const spaceBoundary = window.lastIndexOf(" ");
  if (spaceBoundary >= 0) {
    return spaceBoundary + 1;
  }

  return 0;
}

function splitsSurrogatePair(text: string, cut: number): boolean {
  if (cut <= 0 || cut >= text.length) {
    return false;
  }

  const before = text.charCodeAt(cut - 1);
  const after = text.charCodeAt(cut);
  return (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
}
