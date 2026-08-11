export function parseOverallScore(analysis: string | null): number | null {
  try {
    const score = JSON.parse(analysis ?? "{}").overallScore;
    return typeof score === "number" && Number.isFinite(score) ? score : null;
  } catch {
    return null;
  }
}

export function averageScore(analyses: Array<string | null>): number | null {
  const scores = analyses.map(parseOverallScore).filter((score): score is number => score !== null);
  return scores.length === 0 ? null : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10;
}
