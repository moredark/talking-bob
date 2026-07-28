const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DailyPromptDispatcher,
} = require("../dist/modules/schedule/daily-prompt.dispatcher");

function createSubject(audioFileId, sendVoice = async () => undefined) {
  const calls = {
    recordPromptSent: [],
    sendMessage: [],
    sendVoice: [],
  };
  const prompt = {
    id: "prompt-1",
    topic: "Travel",
    audioFileId,
  };
  const promptService = {
    getRandomActivePrompt: async () => prompt,
    recordPromptSent: async (...args) => {
      calls.recordPromptSent.push(args);
    },
  };
  const dispatcher = new DailyPromptDispatcher(promptService);

  dispatcher.setBot({
    api: {
      sendVoice: async (...args) => {
        calls.sendVoice.push(args);
        return sendVoice(...args);
      },
      sendMessage: async (...args) => {
        calls.sendMessage.push(args);
      },
    },
  });

  return { calls, dispatcher };
}

const user = {
  id: "user-1",
  telegramId: 123456789n,
};

test("sends a text prompt when audioFileId is null", async () => {
  const { calls, dispatcher } = createSubject(null);

  assert.equal(await dispatcher.dispatch(user), true);
  assert.deepEqual(calls.recordPromptSent, [["user-1", "prompt-1"]]);
  assert.equal(calls.sendVoice.length, 0);
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0][0], 123456789);
  assert.match(calls.sendMessage[0][1], /Travel/);
});

test("sends voice without text fallback when audio is available", async () => {
  const { calls, dispatcher } = createSubject("telegram-file-id");

  assert.equal(await dispatcher.dispatch(user), true);
  assert.equal(calls.sendVoice.length, 1);
  assert.equal(calls.sendVoice[0][1], "telegram-file-id");
  assert.equal(calls.sendMessage.length, 0);
});

test("falls back to text when Telegram voice delivery fails", async () => {
  const { calls, dispatcher } = createSubject(
    "telegram-file-id",
    async () => {
      throw new Error("Telegram unavailable");
    },
  );

  assert.equal(await dispatcher.dispatch(user), true);
  assert.equal(calls.sendVoice.length, 1);
  assert.equal(calls.sendMessage.length, 1);
  assert.match(calls.sendMessage[0][1], /Travel/);
});
