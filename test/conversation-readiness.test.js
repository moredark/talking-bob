const readinessPrompt = "Readiness rules";
const assert = require("node:assert/strict");
const test = require("node:test");
const { assessConversationReadiness } = require("../dist/modules/ai/services/conversation-readiness");
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
  const result = await assessConversationReadiness([], "Question?", "Travel", readinessPrompt,
    answer({ ready: true, lastQuestionAnswered: false, question: "Ignored?" }));
  assert.deepEqual(result, { ready: true, lastQuestionAnswered: false, question: "" });
});

test("without any stored question the model-provided DB-guided question is used", async () => {
  const result = await assessConversationReadiness([{ role: "user", content: "Sorry?" }],
    "", "Daily life", readinessPrompt, answer({ ready: false, lastQuestionAnswered: false, question: "Could you give one example?" }));
  assert.equal(result.question, "Could you give one example?");
});

test("malformed readiness never silently completes the conversation", async () => {
  for (const result of [null, {}, { ready: "yes", lastQuestionAnswered: true }, { ready: false, lastQuestionAnswered: true, question: " " }]) {
    await assert.rejects(assessConversationReadiness([], "Question?", "Travel", readinessPrompt, answer(result)), /invalid_conversation_readiness/);
  }
});
