const assert = require("node:assert/strict");
const test = require("node:test");
const { createTextPractice } = require("./support/text-practice-test-harness");

for (const content of ["", " \n ", "x".repeat(4097), "😀".repeat(2049)]) {
  test(`reject invalid text of UTF-16 length ${content.length} before admission`, async () => {
    const s = createTextPractice(); await s.text.handle(s.context(1, content));
    assert.equal(s.prisma.state.conversationMessages.length, 0);
    assert.deepEqual(s.calls.quota, []); assert.equal(s.calls.followUp.length, 0); assert.equal(s.replies.length, 1);
  });
}
for (const content of ["x".repeat(4096), "😀".repeat(2048), "  <b>I walk</b>\n*every day* 😀  "]) {
  test(`preserve valid literal text of UTF-16 length ${content.trim().length}`, async () => {
    const s = createTextPractice(); await s.text.handle(s.context(1, content));
    const message = s.prisma.state.conversationMessages.find(m => m.role === "user");
    assert.equal(message.content, content.trim()); assert.equal(message.voiceFileId, null);
    assert.equal(s.calls.downloads, 0); assert.equal(s.calls.whisper, 0); assert.equal(s.calls.followUp.length, 1);
    assert.equal(s.prisma.state.users[0].lastVoiceMessageAt, null);
    assert.ok(s.prisma.state.users[0].lastUserMessageAt instanceof Date);
    assert.equal(s.prisma.state.userActivityDays[0].messageCount, 1);
    assert.equal(s.prisma.state.userActivityDays[0].textMessageCount, 1);
    assert.equal(s.prisma.state.userActivityDays[0].voiceMessageCount, 0);
  });
}
test("commands, captions and edited messages do not enter practice", async () => {
  const s = createTextPractice();
  for (const command of ["/report", "/time 08:45", "  /unknown"]) await s.text.handle(s.context(1, command));
  const caption = s.context(2); delete caption.message.text; caption.message.caption = "My photo";
  await s.text.handle(caption);
  const edited = s.context(3); edited.editedMessage = edited.message; delete edited.message;
  await s.text.handle(edited); assert.deepEqual(s.calls.quota, []);
});
for (const state of ["unknown", "missing", "pending", "closed"]) {
  test(`${state} conversation refuses text before quota and AI`, async () => {
    const s = createTextPractice();
    if (state === "unknown") s.prisma.state.users.length = 0;
    if (state === "missing") s.prisma.state.userPrompts.length = 0;
    if (state === "pending") s.prisma.state.userPrompts[0].deliveryStatus = "pending";
    if (state === "closed") s.prisma.state.userPrompts[0].conversationStatus = "closed";
    await s.text.handle(s.context(1)); assert.deepEqual(s.calls.quota, []);
    assert.equal(s.calls.followUp.length, 0); assert.equal(s.replies.length, 1);
  });
}
test("duplicate text consumes no extra quota, activity, follow-up or report", async () => {
  const s = createTextPractice(); const ctx = s.context(1);
  await s.text.handle(ctx); await s.text.handle(ctx);
  assert.equal(s.calls.quota.length, 1); assert.equal(s.calls.followUp.length, 1);
  assert.equal(s.prisma.state.userActivityDays[0].messageCount, 1);
    assert.equal(s.prisma.state.userActivityDays[0].textMessageCount, 1);
    assert.equal(s.prisma.state.userActivityDays[0].voiceMessageCount, 0); assert.equal(s.calls.qualified, 0);
});
test("voice and text exhaust the same allowance", async (t) => {
  t.mock.method(global, "fetch", async () => new Response("audio"));
  const s = createTextPractice({ limit: 2 });
  await s.text.handle(s.context(1));
  const voice = s.context(2); delete voice.message.text; voice.message.voice = { file_id: "v", duration: 1 };
  await s.voice.handle(voice); await s.text.handle(s.context(3));
  assert.deepEqual(s.calls.quota, ["voice_response", "voice_response"]);
  assert.equal(s.calls.whisper, 1); assert.equal(s.calls.analyses.length, 0);
  assert.match(s.replies.at(-1).message, /лимит ответов/);
});
test("insufficient third text stays open and sends the readiness question", async () => {
  const s = createTextPractice({ readiness: { ready: false, lastQuestionAnswered: false, question: "What did you enjoy most?", insufficiencyReason: "too_short" } });
  for (let id = 1; id <= 3; id++) await s.text.handle(s.context(id, "Yes"));
  assert.equal(s.prisma.state.userPrompts[0].conversationStatus, "open");
  assert.equal(s.calls.qualified, 0); assert.equal(s.calls.analyses.length, 0);
  assert.equal(s.replies.at(-1).message, "What did you enjoy most?");
});
test("readiness failure saves the third reply once and manual report recovers", async () => {
  const s = createTextPractice({ readinessError: new Error("provider failure") });
  for (let id = 1; id <= 3; id++) await s.text.handle(s.context(id));
  await s.text.handle(s.context(3));
  assert.equal(s.prisma.state.conversationMessages.filter(m => m.role === "user").length, 3);
  assert.equal(s.prisma.state.userPrompts[0].conversationStatus, "open"); assert.equal(s.calls.qualified, 0);
  assert.match(s.replies.at(-1).message, /сохранён.*\/report/);
  s.report.llmService.assessConversation = async () => ({ ready: true, lastQuestionAnswered: true, question: "" });
  await s.report.handle(s.context(4, "/report")); assert.equal(s.calls.analyses.length, 1); assert.equal(s.calls.qualified, 1);
});
test("analysis failure preserves text and a new report retries without requalifying", async () => {
  const s = createTextPractice({ analysisError: new Error("provider failure") });
  for (let id = 1; id <= 3; id++) await s.text.handle(s.context(id));
  assert.equal(s.prisma.state.userResponses[0].generationStatus, "failed"); assert.equal(s.calls.qualified, 1);
  s.reportWorkflow.llmService.analyzeSpeech = async () => ({ version: 1, kind: "model", summary: "Хорошо", improvementPoints: [], overallScore: 8 });
  await s.report.handle(s.context(4, "/report"));
  assert.equal(s.prisma.state.userResponses[0].generationStatus, "generated"); assert.equal(s.calls.qualified, 1);
});
test("stale readiness and stale follow-up never insert obsolete history", async () => {
  for (const result of ["stale", "closed"]) {
    const s = createTextPractice(); s.conversation.acceptReplyAndMaybeClaimGeneration = async () => ({ outcome: result });
    await s.text.handle(s.context(1)); assert.equal(s.calls.followUp.length, 0); assert.equal(s.calls.qualified, 0);
  }
  const s = createTextPractice(); s.conversation.addAssistantMessageIfOpen = async () => ({ outcome: "stale" });
  await s.text.handle(s.context(1)); assert.equal(s.replies.length, 0);
});
test("typed input uses the configured spoken reply and clears typing after failure", async (t) => {
  const events = []; const timer = {};
  t.mock.method(global, "setInterval", () => timer); t.mock.method(global, "clearInterval", value => events.push(value));
  const s = createTextPractice({ spokenReply: { send: async (_ctx, text) => { assert.equal(s.prisma.state.conversationMessages.at(-1).role, "assistant"); events.push(text); throw new Error("send failure"); } } });
  await s.text.handle(s.context(1)); assert.equal(events.at(-1), timer); assert.match(events[0], /What/);
});

test("report after text retention explains unavailable content through the real generation service", async () => {
  const s = createTextPractice();
  for (let id = 1; id <= 3; id++) await s.text.handle(s.context(id));
  const response = s.prisma.state.userResponses[0];
  Object.assign(response, { sensitiveDataPurgedAt: new Date(), transcript: null, analysis: null });
  s.prisma.state.conversationMessages.length = 0;
  s.prisma.state.reportDeliveryRequests.length = 0;
  const count = s.replies.length;
  await s.report.handle(s.context(4, "/report"));
  assert.equal(s.replies.length, count + 1);
  assert.match(s.replies.at(-1).message, /сроку хранения.*\/start/);
  assert.equal(s.calls.analyses.length, 1); assert.equal(s.calls.qualified, 1);
  assert.equal(s.prisma.state.reportDeliveryRequests.length, 0);
});
