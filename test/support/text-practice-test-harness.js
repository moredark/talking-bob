const { createInMemoryPrisma } = require("../../testing/in-memory-prisma");
const { UserService } = require("../../dist/modules/user/user.service");
const { PromptService } = require("../../dist/modules/prompt/prompt.service");
const { ConversationService } = require("../../dist/modules/conversation/conversation.service");
const { ResponseService } = require("../../dist/modules/response/response.service");
const { ReportHandler } = require("../../dist/modules/telegram/handlers/report.handler");
const { ReportWorkflowService } = require("../../dist/modules/telegram/report-workflow.service");
const { PracticeReplyWorkflowService } = require("../../dist/modules/telegram/practice-reply-workflow.service");
const { TextHandler } = require("../../dist/modules/telegram/handlers/text.handler");
const { VoiceHandler } = require("../../dist/modules/telegram/handlers/voice.handler");
const { installRuntimeSettings } = require("./runtime-settings-test-harness");
installRuntimeSettings(VoiceHandler);

function createTextPractice({ readiness, readinessError, analysisError, followUpError, errorLog, spokenReply, limit = 10 } = {}) {
  const prisma = createInMemoryPrisma({ prompts: [{ id: "p", topic: "Travel" }, { id: "next", topic: "Food" }] });
  prisma.state.users.push({ id: "u", telegramId: 123n, agentTone: "friendly", lastUserMessageAt: null, lastVoiceMessageAt: null });
  prisma.state.userPrompts.push({ id: "up", userId: "u", promptId: "p", deliveryStatus: "sent", sentAt: new Date(), conversationStatus: "open" });
  const calls = { quota: [], followUp: [], readiness: [], analyses: [], qualified: 0, whisper: 0, downloads: 0 };
  const streak = { qualifyConversation: async () => { calls.qualified++; return { currentStreak: 1, longestStreak: 1, isNewRecord: true }; } };
  const conversation = new ConversationService(prisma, streak);
  const user = new UserService(prisma), prompt = new PromptService(prisma), response = new ResponseService(prisma, streak);
  const quota = { consumeLimit: async (_userId, action) => {
    const used = calls.quota.filter(value => value === action).length;
    if (action === "voice_response" && used >= limit) return { allowed: false };
    calls.quota.push(action); return { allowed: true, requestId: "quota" };
  } };
  const llm = {
    assessConversation: async (...args) => { calls.readiness.push(args); if (readinessError) throw readinessError; return readiness ?? { ready: true, lastQuestionAnswered: true, question: "" }; },
    generateFollowUp: async (...args) => { calls.followUp.push(args); if (followUpError) throw followUpError; return "What did you enjoy most?"; },
    analyzeSpeech: async (...args) => { calls.analyses.push(args); if (analysisError) throw analysisError; return { version: 1, kind: "model", summary: "Хороший рассказ", improvementPoints: [], overallScore: 8 }; },
  };
  const reportWorkflow = new ReportWorkflowService(response, conversation, llm, errorLog);
  const personality = { resolveSelectedOrDefault: async () => ({ key: "friendly" }) };
  const workflow = new PracticeReplyWorkflowService(user, prompt, conversation, quota, llm, reportWorkflow, errorLog, undefined, personality, spokenReply);
  const text = new TextHandler(workflow);
  const report = new ReportHandler(user, prompt, response, conversation, quota, llm, errorLog, undefined, reportWorkflow, personality);
  const voice = new VoiceHandler(workflow, { transcribe: async () => { calls.whisper++; return { text: "I visited Rome. I liked the food." }; } }, {
    telegramBotToken: "test", externalRequests: { telegramFileDownload: { timeoutMs: 100, maxResponseBytes: 100 } },
  });
  const replies = [];
  function context(id, content = "I visited Rome. I liked the food.") {
    const ctx = {
      from: { id: 123 }, chat: { id: 123 },
      message: { message_id: id, chat: { id: 123 }, text: content }, update: { update_id: id },
      api: { sendChatAction: async () => {}, getFile: async () => { calls.downloads++; return { file_path: "voice.ogg" }; } },
      reply: async (message, options) => { replies.push({ message, options }); },
    };
    return ctx;
  }
  return { prisma, calls, conversation, user, prompt, response, workflow, text, voice, report, reportWorkflow, replies, context };
}
module.exports = { createTextPractice };
