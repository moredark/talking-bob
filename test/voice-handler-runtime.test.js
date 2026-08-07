const assert = require("node:assert/strict");
const test = require("node:test");

const {
  VoiceHandler,
} = require("../dist/modules/telegram/handlers/voice.handler");

function runtimeConfig(download = {}, voice = {}) {
  return {
    telegramBotToken: "123456:test-token",
    voice: {
      maxDurationSeconds: 300,
      maxFileSizeBytes: 20 * 1024 * 1024,
      ...voice,
    },
    externalRequests: {
      telegramFileDownload: {
        timeoutMs: 25,
        maxResponseBytes: 32,
        ...download,
      },
    },
  };
}

function createSubject({ voice = {}, config = runtimeConfig() } = {}) {
  const calls = {
    findUser: 0,
    checkLimit: 0,
    recordAction: 0,
    latestPrompt: 0,
    getFile: 0,
    whisper: 0,
    llm: 0,
    replies: [],
  };
  const handler = new VoiceHandler(
    {
      findByTelegramId: async () => {
        calls.findUser += 1;
        return { id: "user-1", agentTone: "friendly" };
      },
    },
    {
      getLatestUserPrompt: async () => {
        calls.latestPrompt += 1;
        return { id: "user-prompt-1", promptId: "prompt-1" };
      },
      getPromptById: async () => ({ id: "prompt-1", topic: "Travel" }),
    },
    {
      addMessage: async () => undefined,
      getMessages: async () => [],
    },
    {
      checkLimit: async () => {
        calls.checkLimit += 1;
        return true;
      },
      recordAction: async () => {
        calls.recordAction += 1;
      },
    },
    {
      transcribe: async () => {
        calls.whisper += 1;
        return { text: "I visited Rome", language: "en" };
      },
    },
    {
      generateFollowUp: async () => {
        calls.llm += 1;
        return "What did you enjoy most?";
      },
    },
    { generateReport: async () => undefined },
    config,
  );
  const context = {
    from: { id: 123 },
    chat: { id: 123 },
    message: {
      voice: { file_id: "voice-1", duration: 5, ...voice },
    },
    api: {
      getFile: async () => {
        calls.getFile += 1;
        return { file_path: "voice/file.ogg" };
      },
      sendChatAction: async () => undefined,
    },
    reply: async (message) => calls.replies.push(message),
  };
  return { calls, context, handler };
}

function assertNoDownstreamWork(calls) {
  for (const name of [
    "findUser",
    "checkLimit",
    "recordAction",
    "latestPrompt",
    "getFile",
    "whisper",
    "llm",
  ]) {
    assert.equal(calls[name], 0, name);
  }
}

test("VoiceHandler rejects overlong voice before user, quota, download, or AI work", async () => {
  const { calls, context, handler } = createSubject({
    voice: { duration: 301 },
  });
  await handler.handle(context);
  assertNoDownstreamWork(calls);
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0], /слишком длинное/i);
});

test("VoiceHandler rejects known oversized voice before user, quota, download, or AI work", async () => {
  const { calls, context, handler } = createSubject({
    voice: { file_size: 20 * 1024 * 1024 + 1 },
  });
  await handler.handle(context);
  assertNoDownstreamWork(calls);
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0], /слишком большое/i);
});

test("VoiceHandler accepts missing file_size and clears typing indicator on success", async () => {
  const { calls, context, handler } = createSubject();
  const originalFetch = global.fetch;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const timer = { fake: true };
  const cleared = [];
  global.fetch = async () => new Response("audio");
  global.setInterval = () => timer;
  global.clearInterval = (value) => cleared.push(value);
  try {
    await handler.handle(context);
  } finally {
    global.fetch = originalFetch;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
  assert.equal(calls.getFile, 1);
  assert.equal(calls.whisper, 1);
  assert.equal(calls.llm, 1);
  assert.deepEqual(cleared, [timer]);
  assert.match(calls.replies.at(-1), /enjoy most/i);
});

test("VoiceHandler reports bounded download overflow and clears typing indicator", async () => {
  const { calls, context, handler } = createSubject({
    config: runtimeConfig({ maxResponseBytes: 4 }),
  });
  const originalFetch = global.fetch;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const timer = { fake: true };
  const cleared = [];
  global.fetch = async () => new Response("12345");
  global.setInterval = () => timer;
  global.clearInterval = (value) => cleared.push(value);
  try {
    await handler.handle(context);
  } finally {
    global.fetch = originalFetch;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
  assert.equal(calls.getFile, 1);
  assert.equal(calls.whisper, 0);
  assert.deepEqual(cleared, [timer]);
  assert.match(calls.replies.at(-1), /ошибка при обработке/i);
});

test("VoiceHandler bounds an undeclared file size by the configured voice limit", async () => {
  const { calls, context, handler } = createSubject({
    config: runtimeConfig(
      { maxResponseBytes: 32 },
      { maxFileSizeBytes: 4 },
    ),
  });
  const originalFetch = global.fetch;
  global.fetch = async () => new Response("12345");
  try {
    await handler.handle(context);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(context.message.voice.file_size, undefined);
  assert.equal(calls.getFile, 1);
  assert.equal(calls.whisper, 0);
  assert.match(calls.replies.at(-1), /ошибка при обработке/i);
});

test("VoiceHandler aborts a stalled bounded download and gives a user-facing error", async () => {
  const { calls, context, handler } = createSubject({
    config: runtimeConfig({ timeoutMs: 5 }),
  });
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (_input, init) => {
    fetchCalls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  };
  try {
    await handler.handle(context);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 2);
  assert.equal(calls.whisper, 0);
  assert.match(calls.replies.at(-1), /ошибка при обработке/i);
});
