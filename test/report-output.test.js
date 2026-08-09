const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TELEGRAM_TEXT_MESSAGE_LIMIT,
  chunkReportOutput,
  formatReportOutput,
} = require("../dist/modules/telegram/report-output");

function assertValidChunks(input, chunks) {
  assert.equal(chunks.join(""), input);
  assert.ok(
    chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_MESSAGE_LIMIT),
  );
}

test("formatReportOutput preserves quotes, emoji, and markup characters as literal text", () => {
  const transcript = 'I said "<tag> & *stars* _under_ 😀"\nnext line';
  const feedback = {
    summary: 'Keep "<this>" & that *literal* 💬',
    improvementPoints: [
      'Use <articles> & "quotes".',
      "Keep * and _ unchanged 🎯",
    ],
    overallScore: 8,
  };

  assert.equal(
    formatReportOutput(feedback, transcript),
    [
      "📝 Ваш ответ:",
      `"${transcript}"`,
      "",
      "⭐ Оценка: 8/10",
      "",
      "💬 Комментарий:",
      feedback.summary,
      "",
      "📌 Разбор ошибок и улучшений:",
      `• ${feedback.improvementPoints[0]}`,
      `• ${feedback.improvementPoints[1]}`,
    ].join("\n"),
  );
});

test("formatReportOutput omits the improvement section when there are no points", () => {
  const output = formatReportOutput(
    { summary: "Всё хорошо.", improvementPoints: [], overallScore: 10 },
    "Perfect answer",
  );

  assert.equal(
    output,
    [
      "📝 Ваш ответ:",
      '"Perfect answer"',
      "",
      "⭐ Оценка: 10/10",
      "",
      "💬 Комментарий:",
      "Всё хорошо.",
    ].join("\n"),
  );
});

test("formatReportOutput visibly marks fallback analysis", () => {
  const output = formatReportOutput(
    {
      summary: "Показана базовая оценка.",
      improvementPoints: [],
      overallScore: 5,
      kind: "fallback",
    },
    "Fallback transcript",
  );

  assert.match(output, /базовый автоматический отчёт/i);
  assert.match(output, /полный анализ модели недоступен/i);
});

test("chunkReportOutput handles 4095, 4096, and 4097 code-unit inputs exactly", () => {
  for (const length of [4095, 4096, 4097]) {
    const input = "x".repeat(length);
    const chunks = chunkReportOutput(input);

    assertValidChunks(input, chunks);
    assert.deepEqual(
      chunks.map((chunk) => chunk.length),
      length <= TELEGRAM_TEXT_MESSAGE_LIMIT ? [length] : [4096, 1],
    );
  }
});

test("chunkReportOutput prefers paragraph, then line, then space boundaries", () => {
  const cases = [
    {
      name: "paragraph before a later line and spaces",
      input: `${"a".repeat(3000)}\n\n${"b".repeat(900)}\n${"c ".repeat(200)}`,
      firstChunkLength: 3002,
    },
    {
      name: "line before a later space",
      input: `${"a".repeat(3800)}\n${"b".repeat(200)} ${"c".repeat(200)}`,
      firstChunkLength: 3801,
    },
    {
      name: "space before the hard limit",
      input: `${"a".repeat(4000)} ${"b".repeat(200)}`,
      firstChunkLength: 4001,
    },
  ];

  for (const { name, input, firstChunkLength } of cases) {
    const chunks = chunkReportOutput(input);
    assertValidChunks(input, chunks);
    assert.equal(chunks[0].length, firstChunkLength, name);
  }
});

test("chunkReportOutput hard-splits long unbroken text without changing it", () => {
  const input = "z".repeat(TELEGRAM_TEXT_MESSAGE_LIMIT * 2 + 17);
  const chunks = chunkReportOutput(input);

  assertValidChunks(input, chunks);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [4096, 4096, 17]);
});

test("chunkReportOutput never splits a UTF-16 surrogate pair", () => {
  const input = `${"a".repeat(4095)}😀b`;
  const chunks = chunkReportOutput(input);

  assertValidChunks(input, chunks);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [4095, 3]);
  assert.equal(chunks[1], "😀b");
});
