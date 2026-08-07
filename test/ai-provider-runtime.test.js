const assert = require("node:assert/strict");
const test = require("node:test");

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
