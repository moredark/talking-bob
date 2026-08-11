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

function standardFallback(overallScore = 5) {
  return {
    version: 1,
    kind: "fallback",
    summary:
      "Модель не предоставила полный анализ. Показана базовая автоматическая оценка ответа.",
    improvementPoints: [
      "Добавьте больше деталей: причина, пример, сравнение.",
      "Используйте связки: because, however, for example, in my opinion.",
    ],
    overallScore,
  };
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

test("LLM marks valid JSON with an invalid analysis schema as fallback", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return analysisResponse(
      JSON.stringify({
        summary: "Schema was invalid.",
        improvementPoints: [],
        overallScore: 11,
      }),
    );
  };

  try {
    assert.deepEqual(await service.analyzeSpeech("Short answer", "Travel"), {
      version: 1,
      kind: "fallback",
      summary: "Schema was invalid.",
      improvementPoints: [],
      overallScore: 5,
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});

test("LLM marks malformed non-empty analysis content as fallback", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return analysisResponse(
      '{"summary":"Partial analysis","improvementPoints":["Use articles"],"overallScore":',
    );
  };

  try {
    assert.deepEqual(await service.analyzeSpeech("Short answer", "Travel"), {
      version: 1,
      kind: "fallback",
      summary: "Partial analysis",
      improvementPoints: ["Use articles"],
      overallScore: 5,
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});

test("LLM retries empty analysis content twice before returning fallback", async () => {
  const service = new LLMService(config(), new AiRequestLimiterService(1));
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return analysisResponse("   ");
  };

  try {
    assert.deepEqual(
      await service.analyzeSpeech("This is a short answer", "Travel"),
      standardFallback(),
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 2);
});

test("LLM converts non-lifecycle provider errors to speech analysis fallback", async (t) => {
  const cases = [
    {
      name: "transport error",
      fetch: async () => {
        throw new Error("network unavailable");
      },
    },
    {
      name: "provider HTTP error",
      fetch: async () => new Response("unavailable", { status: 503 }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const service = new LLMService(config(), new AiRequestLimiterService(1));
      const originalFetch = global.fetch;
      let calls = 0;
      global.fetch = async (...args) => {
        calls += 1;
        return scenario.fetch(...args);
      };

      try {
        assert.deepEqual(
          await service.analyzeSpeech("This is a short answer", "Travel"),
          standardFallback(),
        );
      } finally {
        global.fetch = originalFetch;
      }
      assert.equal(calls, 1);
    });
  }
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
