const assert = require("node:assert/strict");
const test = require("node:test");

const { installRuntimeSettings } = require("./support/runtime-settings-test-harness");
const {
  BoundedHttpError,
} = require("../dist/infrastructure/http/bounded-http");
const {
  AiRequestLimiterClosedError,
  AiRequestLimiterOverloadedError,
  AiRequestLimiterService,
} = require("../dist/modules/ai/services/ai-request-limiter.service");
const {
  LLMService,
} = require("../dist/modules/ai/services/llm.service");
const {
  WhisperService,
} = require("../dist/modules/ai/services/whisper.service");
installRuntimeSettings(LLMService);

function config({ whisper = {}, llm = {} } = {}) {
  return {
    cloudRuApiKey: "cloud-secret",
    llm: {
      apiUrl: "https://provider.invalid/chat",
      model: "test-model",
      analysisMaxTokens: 256,
      followUpMaxTokens: 128,
    },
    externalRequests: {
      whisper: { timeoutMs: 50, maxResponseBytes: 256, ...whisper },
      llm: { timeoutMs: 50, maxResponseBytes: 256, ...llm },
    },
  };
}

const READINESS_PERSONALITY = { key: "friendly", followUpPrompt: "Follow-up", analysisPrompt: "Analysis", readinessPrompt: "DB readiness prompt" };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function analysisResponse(content) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { headers: { "content-type": "application/json" } },
  );
}

async function eventually(predicate, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

test("Whisper and LLM provider calls share one injected concurrency limiter", async () => {
  const limiter = new AiRequestLimiterService(1);
  const whisper = new WhisperService(config(), limiter);
  const llm = new LLMService(config(), limiter);
  const gates = [deferred(), deferred()];
  const methods = [];
  let calls = 0;
  let active = 0;
  let peak = 0;
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const call = calls;
    calls += 1;
    methods.push(init.method);
    active += 1;
    peak = Math.max(peak, active);
    await gates[call].promise;
    active -= 1;
    if (String(input).includes("transcriptions")) {
      return new Response("hello");
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "What happened next?" } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

  try {
    const transcription = whisper.transcribe(Buffer.from("audio"), "en");
    const followUp = llm.generateFollowUp([], "Travel");
    await eventually(() => calls === 1);
    assert.equal(active, 1);
    assert.equal(limiter.pending, 1);

    gates[0].resolve();
    await eventually(() => calls === 2);
    assert.equal(active, 1);
    gates[1].resolve();

    assert.deepEqual(await Promise.all([transcription, followUp]), [
      { text: "hello", language: "en" },
      "What happened next?",
    ]);
  } finally {
    global.fetch = originalFetch;
  }

  assert.deepEqual(methods, ["POST", "POST"]);
  assert.equal(peak, 1);
});

test("Whisper rejects an oversized provider response without retrying POST", async () => {
  const service = new WhisperService(
    config({ whisper: { maxResponseBytes: 4 } }),
    new AiRequestLimiterService(1),
  );
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response("12345");
  };

  try {
    await assert.rejects(
      service.transcribe(Buffer.from("audio"), "en"),
      (error) =>
        error instanceof BoundedHttpError &&
        error.code === "response_too_large",
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});

test("LLM times out an aborted provider POST without transport retry", async () => {
  const service = new LLMService(
    config({ llm: { timeoutMs: 5 } }),
    new AiRequestLimiterService(1),
  );
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = (_input, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  };

  let result;
  try {
    result = await service.generateFollowUp([], "Travel");
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls, 1);
  assert.match(result, /specific example/i);
});

test("LLM marks a valid speech analysis response as model output", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return analysisResponse(
      JSON.stringify({
        summary: "  Clear answer.  ",
        improvementPoints: [" Use articles. ", "Use articles.", ""],
        overallScore: 8,
      }),
    );
  };

  try {
    assert.deepEqual(await service.analyzeSpeech("I visited London", "Travel"), {
      version: 1,
      kind: "model",
      summary: "Clear answer.",
      improvementPoints: ["Use articles."],
      overallScore: 8,
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});

test("LLM forwards one complete personality analysis snapshot unchanged across retry", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  const payloads = [];
  let tokenReads = 0;
  service.settings = {
    productNumber: (key) => { assert.equal(key, "LLM_ANALYSIS_MAX_TOKENS"); tokenReads += 1; return 256; },
  };
  service.requestTracedCompletion = async (payload) => {
    payloads.push(payload);
    return { content: null };
  };
  service.sleep = async () => {};

  const personality = {
    key: "third",
    followUpPrompt: "THIRD FOLLOW-UP PROMPT\nKeep its exact formatting.",
    analysisPrompt: "THIRD ANALYSIS PROMPT\nReturn only the configured schema.",
  };
  await assert.rejects(service.analyzeSpeech("I went there by train", "Weekend travel", "en", personality), /empty/);

  assert.equal(tokenReads, 1);
  assert.equal(payloads.length, 3);
  assert.deepEqual(payloads[0].messages, payloads[1].messages);
  assert.deepEqual(payloads[1].messages, payloads[2].messages);
  assert.deepEqual(payloads[0].messages, [
    { role: "system", content: personality.analysisPrompt },
    { role: "user", content: "Topic: \"Weekend travel\"\nStudent: \"I went there by train\"\nAnalyze this English speech." },
  ]);
});

test("LLM forwards the complete personality follow-up snapshot and preserves topic/history ordering", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  let tokenReads = 0;
  let payload;
  service.settings = {
    productNumber: (key) => { assert.equal(key, "LLM_FOLLOWUP_MAX_TOKENS"); tokenReads += 1; return 128; },
  };
  service.requestTracedCompletion = async (candidate) => {
    payload = candidate;
    return { content: "What happened next?" };
  };
  const history = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`,
  }));

  const personality = {
    key: "third",
    followUpPrompt: "THIRD FOLLOW-UP PROMPT\nUse the entire stored prompt.",
    analysisPrompt: "THIRD ANALYSIS PROMPT",
  };
  assert.equal(await service.generateFollowUp(history, "City life", personality), "What happened next?");

  assert.equal(tokenReads, 1);
  assert.equal(payload.messages[0].content, `${personality.followUpPrompt}\n\nConversation topic: "City life"`);
  assert.deepEqual(payload.messages.slice(1), [
    { role: "user", content: "message-2" },
    { role: "assistant", content: "message-3" },
    { role: "user", content: "message-4" },
    { role: "assistant", content: "message-5" },
    { role: "user", content: "message-6" },
    { role: "assistant", content: "message-7" },
  ]);
});
test("LLM retries invalid analysis content and then rejects", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  service.sleep = async () => {};
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return analysisResponse(JSON.stringify({ summary: "bad", improvementPoints: [], overallScore: 11 }));
  };
  try {
    await assert.rejects(service.analyzeSpeech("Short answer", "Travel"), /invalid/);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 3);
});

test("LLM retries malformed analysis content and then rejects", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  service.sleep = async () => {};
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return analysisResponse('{"summary":"Partial analysis","improvementPoints":["Use articles"],"overallScore":');
  };
  try {
    await assert.rejects(service.analyzeSpeech("Short answer", "Travel"), /invalid/);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 3);
});

test("LLM retries empty analysis content three times before rejecting", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  service.sleep = async () => {};
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return analysisResponse("   ");
  };
  try {
    await assert.rejects(service.analyzeSpeech("This is a short answer", "Travel"), /empty/);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 3);
});

test("LLM retries transient provider errors and recovers", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  service.sleep = async () => {};
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response("unavailable", { status: 503 });
    return analysisResponse(JSON.stringify({ summary: "Recovered", improvementPoints: [], overallScore: 7 }));
  };
  try {
    assert.equal((await service.analyzeSpeech("Answer", "Travel")).summary, "Recovered");
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 3);
});

test("LLM records sequential trace attempts without multiplying retries", async () => {
  const traces = [];
  const service = new LLMService(
    config(),
    new AiRequestLimiterService(1),
    undefined,
    { write: (trace) => traces.push(trace) },
  );
  service.sleep = async () => {};
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response("unavailable", { status: 503 });
    return analysisResponse(JSON.stringify({ summary: "Recovered", improvementPoints: [], overallScore: 7 }));
  };
  try {
    await service.analyzeSpeech("Answer", "Travel", "en", undefined, {
      userId: "user-1", userPromptId: "prompt-1",
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 3);
  assert.deepEqual(traces.map(({ attempt, outcome }) => ({ attempt, outcome })), [
    { attempt: 1, outcome: "failed" },
    { attempt: 2, outcome: "failed" },
    { attempt: 3, outcome: "succeeded" },
  ]);
});

test("LLM rejects permanent provider errors without retry", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  service.sleep = async () => {};
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  };
  try {
    await assert.rejects(service.analyzeSpeech("Answer", "Travel"), /rejected/);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});

test("LLM limiter lifecycle errors escape both fallback paths", async () => {
  for (const error of [
    new AiRequestLimiterOverloadedError(),
    new AiRequestLimiterClosedError(),
  ]) {
    const limiter = {
      run: () => Promise.reject(error),
    };
    const service = new LLMService(config(), limiter);

    await assert.rejects(
      service.generateFollowUp([], "Travel"),
      (received) => received === error,
    );
    await assert.rejects(
      service.analyzeSpeech("I visited London", "Travel"),
      (received) => received === error,
    );
  }
});


test("conversation readiness retries transient failure silently and repeats the exact last question", async (t) => {
  const traces = [];
  const service = new LLMService(config(), new AiRequestLimiterService(1), undefined, { write: (trace) => traces.push(trace) });
  const delays = [];
  service.sleep = async (delay) => delays.push(delay);
  let attempts = 0;
  const systemPrompts = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    attempts += 1;
    systemPrompts.push(JSON.parse(options.body).messages[0].content);
    if (attempts === 1) throw new TypeError("network");
    return analysisResponse(JSON.stringify({ ready: false, lastQuestionAnswered: false, question: "Different?" }));
  });
  const result = await service.assessConversation([
    { role: "assistant", content: "What did you enjoy?" },
    { role: "user", content: "Sorry?" },
  ], "Where did you travel?", "Travel", { userId: "user-1", userPromptId: "prompt-1" }, READINESS_PERSONALITY);
  assert.equal(result.question, "What did you enjoy?");
  assert.equal(attempts, 2);
  assert.deepEqual(systemPrompts, ["DB readiness prompt", "DB readiness prompt"]);
  assert.deepEqual(traces.map(({ operation, attempt }) => ({ operation, attempt })), [
    { operation: "readiness", attempt: 1 }, { operation: "readiness", attempt: 2 },
  ]);
  assert.deepEqual(delays, [1000]);
});

test("conversation readiness exhaustion throws without a false readiness result", async (t) => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  service.sleep = async () => {};
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts += 1; return analysisResponse("{}"); });
  await assert.rejects(service.assessConversation([], "Question?", "Travel", undefined, READINESS_PERSONALITY), /invalid_conversation_readiness/);
  assert.equal(attempts, 3);
});


test("analysis recovers from the exact bounded HTTP timeout without returning fallback", async (t) => {
  const service = new LLMService(config({ llm: { timeoutMs: 5, maxResponseBytes: 4096 } }), new AiRequestLimiterService(1));
  service.sleep = async () => {};
  let attempts = 0;
  let aborted = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    attempts += 1;
    if (attempts === 1) return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal.reason); }, { once: true });
    });
    return analysisResponse(JSON.stringify({ summary: "Good answer", improvementPoints: [], overallScore: 8 }));
  });
  assert.equal((await service.analyzeSpeech("I visited Rome last summer.", "Travel")).kind, "model");
  assert.equal(aborted, true);
  assert.equal(attempts, 2);
});


test("conversation readiness retries a malformed provider JSON envelope", async (t) => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  service.sleep = async () => {};
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return attempts === 1 ? new Response("not json") : analysisResponse(JSON.stringify({ ready: true, lastQuestionAnswered: true }));
  });
  assert.equal((await service.assessConversation([], "Question?", "Travel", undefined, READINESS_PERSONALITY)).ready, true);
  assert.equal(attempts, 2);
});
