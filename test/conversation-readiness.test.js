const readinessPrompt = "Readiness rules";
const assert = require("node:assert/strict");
const test = require("node:test");
const { assessConversationReadiness, countMeaningfulSentenceUnits } = require("../dist/modules/ai/services/conversation-readiness");
const answer = (result) => async () => JSON.stringify(result);

test("insufficient speech repeats the exact unanswered last question", async () => {
  const result = await assessConversationReadiness([
    { role: "assistant", content: "Where did you go?" },
    { role: "user", content: "Could you repeat?" },
  ], "Tell me about travel.", "Travel", readinessPrompt, answer({ ready: false, lastQuestionAnswered: false, question: "Invented question?" }));
  assert.equal(result.question, "Where did you go?");
  const emptyModelQuestion = await assessConversationReadiness([
    { role: "assistant", content: "Where did you go?" },
    { role: "user", content: "Could you repeat?" },
  ], "Tell me about travel.", "Travel", readinessPrompt, answer({ ready: false, lastQuestionAnswered: false, question: "" }));
  assert.equal(emptyModelQuestion.question, "Where did you go?");
});

test("without a follow-up the original prompt is repeated", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "Sorry?" }],
    "What did you do yesterday?", "Daily life", readinessPrompt, answer({ ready: false, lastQuestionAnswered: false, question: "Invented?" }));
  assert.equal(result.question, "What did you do yesterday?");
});

test("insufficient but answered speech receives a relevant additional question", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I like it." }],
    "Do you like travelling?", "Travel", readinessPrompt, answer({ ready: false, lastQuestionAnswered: true, question: " Why do you like it? " }));
  assert.equal(result.question, "Why do you like it?");
});

test("sufficient speech permits analysis even if the latest optional question is unanswered", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt,
    answer({ ready: true, lastQuestionAnswered: false, question: "Ignored?" }));
  assert.deepEqual(result, { ready: true, lastQuestionAnswered: false, question: "" });
});

test("without any stored question the model-provided DB-guided question is used", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "Sorry?" }],
    "", "Daily life", readinessPrompt, answer({ ready: false, lastQuestionAnswered: false, question: "Could you give one example?" }));
  assert.equal(result.question, "Could you give one example?");
});

test("punctuationless speech uses one unit per user message", () => {
  assert.equal(countMeaningfulSentenceUnits([{ role: "user", content: "I spoke for a very long time without punctuation" }]), 1);
  assert.equal(countMeaningfulSentenceUnits([{ role: "user", content: "I spoke without punctuation" }, { role: "user", content: "I added another thought" }]), 2);
});

test("one meaningful sentence is never ready even if the model says ready", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I visited Rome" }], "Question?", "Travel", readinessPrompt, answer({ ready: true, lastQuestionAnswered: true, question: "Tell me more?" }));
  assert.equal(result.ready, false);
  assert.equal(result.question, "Tell me more?");
});

test("forced false falls back to the stored question when model omits its question", async () => {
  const result = await assessConversationReadiness([{ role: "assistant", content: "Where did you go?" }, { role: "user", content: "I visited Rome" }], "Question?", "Travel", readinessPrompt, answer({ ready: true, lastQuestionAnswered: true, question: "" }));
  assert.deepEqual(result, { ready: false, lastQuestionAnswered: true, question: "Where did you go?", insufficiencyReason: "too_short" });
});

test("multiple meaningful utterances can be ready when latest question is unanswered", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }, { role: "assistant", content: "What happened next?" }], "Question?", "Travel", readinessPrompt, answer({ ready: true, lastQuestionAnswered: false, question: "Ignored?" }));
  assert.deepEqual(result, { ready: true, lastQuestionAnswered: false, question: "" });
});

test("readiness request includes deterministic meaningful sentence evidence", async () => {
  let payload;
  await assessConversationReadiness([{ role: "user", content: "I visited Rome. The food was great" }, { role: "user", content: "I walked a lot" }], "Question?", "Travel", readinessPrompt, async (messages) => { payload = JSON.parse(messages[1].content); return JSON.stringify({ ready: true, lastQuestionAnswered: true, question: "" }); });
  assert.equal(payload.meaningfulSentenceCount, 3);
});

test("malformed readiness never silently completes the conversation", async () => {
  for (const result of [null, {}, { ready: "yes", lastQuestionAnswered: true }, { ready: false, lastQuestionAnswered: true, question: " " }]) {
    await assert.rejects(assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt, answer(result)), /invalid_conversation_readiness/);
  }
});


test("readiness accepts JSON surrounded by provider explanation", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt,
    async () => 'Here is the result:\n{"ready":true,"lastQuestionAnswered":true,"question":""}\nDone.');
  assert.deepEqual(result, { ready: true, lastQuestionAnswered: true, question: "" });
});

test("readiness accepts fenced JSON", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt,
    async () => '```json\n{"ready":true,"lastQuestionAnswered":true,"question":""}\n```');
  assert.deepEqual(result, { ready: true, lastQuestionAnswered: true, question: "" });
});

test("malformed JSON surrounded by text is rejected", async () => {
  await assert.rejects(
    assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt,
      async () => 'The result is {"ready":true,"lastQuestionAnswered":true,}.'),
    /invalid_conversation_readiness/,
  );
});


test("readiness does not accept a nested contract-like object inside an invalid outer object", async () => {
  await assert.rejects(
    assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt,
      async () => 'Wrapper: {"payload":{"ready":true,"lastQuestionAnswered":true,"question":""},"broken":}'),
    /invalid_conversation_readiness/,
  );
});

test("readiness continues after a rejected balanced top-level object", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt,
    async () => 'First: {"payload":{"ready":true},"broken":}. Then: {"ready":true,"lastQuestionAnswered":true,"question":""}');
  assert.deepEqual(result, { ready: true, lastQuestionAnswered: true, question: "" });
});
test("readiness skips malformed JSON before a valid candidate", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt,
    async () => 'First: {"ready":true,"lastQuestionAnswered":true,}. Then: {"ready":true,"lastQuestionAnswered":true,"question":""}');
  assert.deepEqual(result, { ready: true, lastQuestionAnswered: true, question: "" });
});

test("readiness skips an invalid contract object before a valid candidate", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "I visited Rome" }, { role: "user", content: "I liked the food" }], "Question?", "Travel", readinessPrompt,
    async () => 'First: {}. Then: {"ready":true,"lastQuestionAnswered":true,"question":""}');
  assert.deepEqual(result, { ready: true, lastQuestionAnswered: true, question: "" });
});

test("readiness preserves braces and escaped quotes in a follow-up question", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "Sorry?" }], "", "Travel", readinessPrompt,
    async () => 'Result: {"ready":false,"lastQuestionAnswered":true,"question":"Ask about {topic} and say \\"why\\"?"}');
  assert.equal(result.question, 'Ask about {topic} and say "why"?');
});
