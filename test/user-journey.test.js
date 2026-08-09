const assert = require("node:assert/strict");
const test = require("node:test");

const { UserService } = require("../dist/modules/user/user.service");
const { PromptService } = require("../dist/modules/prompt/prompt.service");
const { ScheduleService } = require("../dist/modules/schedule/schedule.service");
const {
  DailyPromptDispatcher,
} = require("../dist/modules/schedule/daily-prompt.dispatcher");
const {
  ConversationService,
} = require("../dist/modules/conversation/conversation.service");
const { ResponseService } = require("../dist/modules/response/response.service");
const { StartHandler } = require("../dist/modules/telegram/handlers/start.handler");
const { VoiceHandler } = require("../dist/modules/telegram/handlers/voice.handler");
const { ReportHandler } = require("../dist/modules/telegram/handlers/report.handler");
const {
  SettingsHandler,
} = require("../dist/modules/telegram/handlers/settings.handler");
const { createInMemoryPrisma } = require("../testing/in-memory-prisma");

function voiceContext(updateId, transcriptIndex, replies, telegram) {
  return {
    from: { id: 4242, username: "alice" },
    chat: { id: 4242 },
    message: {
      message_id: 100 + transcriptIndex,
      chat: { id: 4242 },
      voice: { file_id: `voice-${transcriptIndex}`, duration: 12, file_size: 5 },
    },
    update: { update_id: updateId },
    api: {
      getFile: async (fileId) => ({ file_path: `journey/${fileId}.ogg` }),
      sendChatAction: async (...args) => telegram.chatActions.push(args),
    },
    reply: async (message, options) => replies.push({ message, options }),
  };
}

test("deterministic user journey reaches an automatic report and a non-repeating next question", async () => {
  const prisma = createInMemoryPrisma({
    prompts: [
      { id: "prompt-a", topic: "Travel", audioFileId: null },
      { id: "prompt-b", topic: "Food", audioFileId: "food-voice" },
    ],
  });
  const userService = new UserService(prisma);
  const promptService = new PromptService(prisma);
  const scheduleService = new ScheduleService(prisma);
  const conversationService = new ConversationService(prisma);
  const responseService = new ResponseService(prisma);

  const telegram = { messages: [], voices: [], chatActions: [] };
  const dispatcher = new DailyPromptDispatcher(scheduleService);
  dispatcher.setBot({
    api: {
      sendMessage: async (...args) => telegram.messages.push(args),
      sendVoice: async (...args) => telegram.voices.push(args),
    },
  });

  const quota = {
    calendar: [],
    rolling: [],
    released: [],
    async consumeCalendarDayLimit(...args) {
      this.calendar.push(args);
      return { allowed: true, requestId: `calendar-${this.calendar.length}` };
    },
    async consumeLimit(...args) {
      this.rolling.push(args);
      return { allowed: true, requestId: `rolling-${this.rolling.length}` };
    },
    async releaseAction(id) {
      this.released.push(id);
    },
  };
  const transcripts = [
    "I visited Rome last summer.",
    "I enjoyed the old streets and museums.",
    "Next time I want to speak with more local people.",
  ];
  const whisperCalls = [];
  const whisper = {
    async transcribe(audio, language) {
      whisperCalls.push({ audio: audio.toString(), language });
      return { text: transcripts[whisperCalls.length - 1], language: "en" };
    },
  };
  const llmCalls = { followUps: [], analyses: [] };
  const llm = {
    async generateFollowUp(history, topic, tone) {
      llmCalls.followUps.push({ history, topic, tone });
      return llmCalls.followUps.length === 1
        ? "What did you like most about Rome?"
        : "Who would you travel with next time?";
    },
    async analyzeSpeech(transcript, topic, language, tone) {
      llmCalls.analyses.push({ transcript, topic, language, tone });
      return {
        version: 1,
        kind: "model",
        summary: "Clear story with useful details.",
        improvementPoints: ["Use the past tense consistently."],
        overallScore: 8,
      };
    },
  };

  const reportHandler = new ReportHandler(
    userService,
    promptService,
    responseService,
    conversationService,
    quota,
    llm,
  );
  const runtimeConfig = {
    telegramBotToken: "123:test",
    voice: { maxDurationSeconds: 300, maxFileSizeBytes: 1024 },
    externalRequests: {
      telegramFileDownload: { timeoutMs: 100, maxResponseBytes: 1024 },
    },
  };
  const voiceHandler = new VoiceHandler(
    userService,
    promptService,
    conversationService,
    quota,
    whisper,
    llm,
    reportHandler,
    runtimeConfig,
  );
  const startHandler = new StartHandler(
    userService,
    quota,
    promptService,
    scheduleService,
    dispatcher,
  );
  const settingsHandler = new SettingsHandler(userService, scheduleService);

  const startReplies = [];
  const startContext = {
    from: { id: 4242, username: "alice" },
    update: { update_id: 1 },
    reply: async (message, options) => startReplies.push({ message, options }),
  };
  await startHandler.handle(startContext);

  assert.equal(prisma.state.users.length, 1, "registration is persisted once");
  assert.equal(prisma.state.users[0].telegramId, 4242n);
  assert.equal(startReplies.length, 1);
  assert.match(startReplies[0].message, /Talking Bob/);
  assert.equal(telegram.messages.length, 1);
  assert.match(telegram.messages[0][1], /Travel/);
  assert.deepEqual(
    prisma.state.userPrompts.map(({ promptId, deliveryStatus }) => ({ promptId, deliveryStatus })),
    [{ promptId: "prompt-a", deliveryStatus: "sent" }],
  );

  const settingsReplies = [];
  await settingsHandler.handle({
    from: { id: 4242, username: "alice" },
    update: { update_id: 2 },
    reply: async (message, options) => settingsReplies.push({ message, options }),
  });

  assert.equal(settingsReplies.length, 1);
  assert.match(settingsReplies[0].message, /<b>Настройки<\/b>/);
  assert.match(settingsReplies[0].message, /Рассылка: <b>включена<\/b>/);
  assert.match(settingsReplies[0].message, /Europe\/Moscow/);
  assert.match(settingsReplies[0].message, /<b>13:00<\/b>/);
  assert.match(settingsReplies[0].message, /Дружелюбный учитель/);
  assert.equal(settingsReplies[0].options.parse_mode, "HTML");
  const settingsCallbacks = settingsReplies[0].options.reply_markup.inline_keyboard
    .flat()
    .map(({ callback_data: callbackData }) => callbackData);
  assert.ok(settingsCallbacks.includes("toggle_daily"));
  assert.ok(settingsCallbacks.includes("set_time_13_0"));
  assert.ok(settingsCallbacks.includes("set_tone_playful"));
  assert.deepEqual(
    {
      dailyPromptEnabled: prisma.state.users[0].dailyPromptEnabled,
      dailyPromptHour: prisma.state.users[0].dailyPromptHour,
      dailyPromptMinute: prisma.state.users[0].dailyPromptMinute,
      timezone: prisma.state.users[0].timezone,
      agentTone: prisma.state.users[0].agentTone,
    },
    {
      dailyPromptEnabled: true,
      dailyPromptHour: 13,
      dailyPromptMinute: 0,
      timezone: "Europe/Moscow",
      agentTone: "friendly",
    },
    "/settings renders the persisted defaults without mutating them",
  );

  const voiceReplies = [];
  const originalFetch = global.fetch;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.fetch = async () => new Response("audio");
  global.setInterval = () => ({ journeyTimer: true });
  global.clearInterval = () => undefined;
  try {
    for (let index = 0; index < transcripts.length; index += 1) {
      await voiceHandler.handle(
        voiceContext(10 + index, index + 1, voiceReplies, telegram),
      );
    }
  } finally {
    global.fetch = originalFetch;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }

  assert.equal(whisperCalls.length, 3);
  assert.equal(llmCalls.followUps.length, 2, "only the first two turns get follow-ups");
  assert.deepEqual(
    voiceReplies.slice(0, 2).map(({ message }) => message),
    ["What did you like most about Rome?", "Who would you travel with next time?"],
  );
  assert.equal(llmCalls.analyses.length, 1);
  assert.deepEqual(llmCalls.analyses[0], {
    transcript: transcripts.join(" "),
    topic: "Travel",
    language: "en",
    tone: "friendly",
  });
  assert.equal(prisma.state.conversationMessages.length, 5);
  assert.deepEqual(
    prisma.state.conversationMessages.map(({ role }) => role),
    ["user", "assistant", "user", "assistant", "user"],
  );
  assert.equal(prisma.state.userPrompts[0].conversationStatus, "closed");
  assert.equal(prisma.state.userResponses.length, 1);
  assert.equal(prisma.state.userResponses[0].generationStatus, "generated");
  assert.equal(prisma.state.userResponses[0].voiceFileId, "voice-1");
  assert.equal(prisma.state.userResponses[0].transcript, transcripts.join(" "));
  assert.equal(prisma.state.reportDeliveryRequests.length, 1);
  assert.equal(prisma.state.reportDeliveryRequests[0].status, "delivered");
  assert.match(voiceReplies.at(-1).message, /8\/10/);
  assert.equal(
    voiceReplies.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data,
    "new_question",
  );

  const automaticReport = voiceReplies.at(-1).message;
  const explicitReportReplies = [];
  await reportHandler.handle({
    from: { id: 4242, username: "alice" },
    chat: { id: 4242 },
    message: { message_id: 200, chat: { id: 4242 }, text: "/report" },
    update: { update_id: 19 },
    reply: async (message, options) =>
      explicitReportReplies.push({ message, options }),
  });

  assert.equal(
    llmCalls.analyses.length,
    1,
    "explicit /report reuses the generated analysis instead of calling the LLM",
  );
  assert.equal(explicitReportReplies.length, 1);
  assert.equal(
    explicitReportReplies[0].message,
    automaticReport,
    "explicit /report sends the persisted report",
  );
  assert.equal(prisma.state.reportDeliveryRequests.length, 2);
  assert.deepEqual(
    prisma.state.reportDeliveryRequests.map(({ requestKey, status }) => ({
      requestKey,
      status,
    })),
    [
      { requestKey: "message:4242:103", status: "delivered" },
      { requestKey: "message:4242:200", status: "delivered" },
    ],
  );

  const newQuestionReplies = [];
  await startHandler.handleNewQuestion({
    from: { id: 4242, username: "alice" },
    update: { update_id: 20 },
    callbackQuery: { id: "callback-1", data: "new_question" },
    reply: async (message, options) => newQuestionReplies.push({ message, options }),
  });

  assert.deepEqual(newQuestionReplies, [], "new_question does not repeat the welcome");
  assert.equal(telegram.voices.length, 1);
  assert.equal(telegram.voices[0][1], "food-voice");
  assert.match(telegram.voices[0][2].caption, /Food/);
  assert.deepEqual(
    prisma.state.userPrompts.map(({ promptId, deliveryStatus }) => ({ promptId, deliveryStatus })),
    [
      { promptId: "prompt-a", deliveryStatus: "sent" },
      { promptId: "prompt-b", deliveryStatus: "sent" },
    ],
    "the recent prompt is excluded while the alternate prompt is available",
  );
  assert.equal(prisma.state.users.length, 1, "new_question reuses the registered user");
  assert.equal(quota.calendar.length, 2);
  assert.equal(quota.rolling.length, 4);
  assert.deepEqual(quota.released, []);
});
