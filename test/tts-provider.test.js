const assert = require("node:assert/strict");
const test = require("node:test");

const { AiRequestLimiterService } = require("../dist/modules/ai/services/ai-request-limiter.service");
const { YandexTtsService } = require("../dist/modules/ai/services/yandex-tts.service");

function config(overrides = {}) {
  return {
    tts: {
      enabled: true,
      apiKey: "tts-secret",
      speed: 1,
      maxTextCharacters: 5000,
      request: { timeoutMs: 100, maxResponseBytes: 2 * 1024 * 1024 },
      ...overrides,
    },
  };
}

// A minimal valid Ogg/Opus payload is sufficient: provider validation must
// reject arbitrary bytes while tests remain independent of the network.
function opusFixture() {
  const page = (payload, serial, sequence, headerType, granule = 0n) => {
    const header = Buffer.alloc(27);
    header.write("OggS", 0, "ascii"); header[4] = 0; header[5] = headerType;
    header.writeBigUInt64LE(granule, 6); header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(sequence, 18); header.writeUInt32LE(0, 22); header[26] = 1;
    return Buffer.concat([header, Buffer.from([payload.length]), payload]);
  };
  const opusHead = Buffer.alloc(19); opusHead.write("OpusHead", 0, "ascii"); opusHead[8] = 1; opusHead[9] = 1; opusHead.writeUInt32LE(48000, 12);
  const opusTags = Buffer.from("OpusTags\x04\0\0\0test", "binary");
  return Buffer.concat([page(opusHead, 7, 0, 2), page(opusTags, 7, 1, 4, 960n)]);
}

test("disabled TTS does not perform HTTP", async () => {
  const service = new YandexTtsService(config({ enabled: false }), new AiRequestLimiterService(1));
  const original = global.fetch; let calls = 0; global.fetch = async () => { calls += 1; return new Response(); };
  try { await assert.rejects(service.synthesize("hello"), /disabled/i); } finally { global.fetch = original; }
  assert.equal(calls, 0); assert.equal(service.enabled, false);
});

test("Yandex request uses English john Ogg/Opus and does not retry", async () => {
  const service = new YandexTtsService(config(), new AiRequestLimiterService(1));
  const original = global.fetch; let calls = 0; let request;
  global.fetch = async (...args) => { calls += 1; request = args; return new Response(opusFixture(), { status: 200 }); };
  try { assert.deepEqual(await service.synthesize("Where? & café"), opusFixture()); } finally { global.fetch = original; }
  assert.equal(calls, 1); assert.equal(request[0], "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize");
  assert.equal(request[1].headers.Authorization, "Api-Key tts-secret");
  assert.equal(request[1].redirect, "error");
  const body = new URLSearchParams(request[1].body);
  assert.equal(body.get("voice"), "john"); assert.equal(body.get("lang"), "en-US"); assert.equal(body.get("format"), "oggopus"); assert.equal(body.get("text"), "Where? & café");
  assert.equal(body.get("folderId"), null);
});

test("Yandex TTS rejects oversized text and invalid audio", async () => {
  const service = new YandexTtsService(config({ maxTextCharacters: 4 }), new AiRequestLimiterService(1));
  await assert.rejects(service.synthesize("hello"), /character|length|long/i);
  const original = global.fetch; global.fetch = async () => new Response("not ogg");
  try { await assert.rejects(service.synthesize("hi"), /audio|ogg|opus|invalid/i); } finally { global.fetch = original; }
});

test("TTS rejects blank and encoded-oversized input before making a paid request", async () => {
  const service = new YandexTtsService(config(), new AiRequestLimiterService(1));
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("unexpected request"); };
  try {
    await assert.rejects(service.synthesize(" \n\t"), /empty/);
    await assert.rejects(service.synthesize("界".repeat(2000)), /encoded body limit/);
  } finally { global.fetch = originalFetch; }
  assert.equal(calls, 0);
});

test("HTTP failures are not retried and stored TTS diagnostics omit text, key and response body", async () => {
  const { ErrorLogService } = require("../dist/modules/error-log/error-log.service");
  for (const status of [401, 429, 503]) {
    const creates = [];
    const errorLog = new ErrorLogService({
      errorLog: { create: async (query) => { creates.push(query); return query.data; } },
    });
    const service = new YandexTtsService(config(), new AiRequestLimiterService(1), errorLog);
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response("private-provider-body", { status });
    };
    try {
      await assert.rejects(service.synthesize("private-conversation-text"), (error) => {
        assert.equal(error.name, "TtsProviderStatusError");
        assert.equal(error.statusCode, status);
        assert.equal(error.message.includes("private"), false);
        return true;
      });
    } finally { global.fetch = originalFetch; }
    assert.equal(calls, 1);
    assert.equal(creates.length, 1);
    const data = creates[0].data;
    assert.equal(data.service, "tts");
    assert.equal(data.operation, "synthesize");
    assert.equal(data.errorKind, "TtsProviderStatusError");
    assert.equal(data.statusCode, status);
    assert.equal(data.retryable, status !== 401);
    for (const secret of ["private-conversation-text", "private-provider-body", "tts-secret"]) {
      assert.equal(JSON.stringify(data).includes(secret), false);
    }
  }
});

test("TTS timeout aborts the HTTP request without retrying", async () => {
  const limiter = new AiRequestLimiterService(1);
  const service = new YandexTtsService(config(), limiter);
  const originalFetch = global.fetch;
  let calls = 0;
  let requestSignal;
  global.fetch = async (_url, options) => {
    calls += 1;
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  try {
    await assert.rejects(service.synthesize("hello"), (error) => error.code === "timeout");
    await limiter.drain();
  } finally { global.fetch = originalFetch; }
  assert.equal(calls, 1);
  assert.equal(requestSignal.aborted, true);
  assert.equal(limiter.active, 0);
});

test("runtime shutdown aborts a pending TTS request", async () => {
  const limiter = new AiRequestLimiterService(1);
  const service = new YandexTtsService(config(), limiter);
  const originalFetch = global.fetch;
  let started;
  const startedRequest = new Promise((resolve) => { started = resolve; });
  global.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("shutdown")), { once: true });
    started();
  });
  try {
    const request = service.synthesize("hello");
    const rejected = assert.rejects(request, (error) => error.code === "aborted");
    await startedRequest;
    limiter.abort();
    await rejected;
    await limiter.drain();
    assert.equal(limiter.active, 0);
  } finally { global.fetch = originalFetch; }
});

test("TTS bounds response size with and without Content-Length", async () => {
  for (const headers of [{ "content-length": "128" }, {}]) {
    const service = new YandexTtsService(
      config({ request: { timeoutMs: 100, maxResponseBytes: 64 } }),
      new AiRequestLimiterService(1),
    );
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls += 1; return new Response(Buffer.alloc(128), { headers }); };
    try {
      await assert.rejects(service.synthesize("hello"), (error) => error.code === "response_too_large");
    } finally { global.fetch = originalFetch; }
    assert.equal(calls, 1);
  }
});

test("production modules wire SpeechKit through TTS_SERVICE into the voice handler", () => {
  const { MODULE_METADATA, SELF_DECLARED_DEPS_METADATA } = require("@nestjs/common/constants");
  const { AiModule } = require("../dist/modules/ai/ai.module");
  const { TTS_SERVICE } = require("../dist/modules/ai/interfaces/tts.interface");
  const { TelegramModule } = require("../dist/modules/telegram/telegram.module");
  const { SpokenReplyService } = require("../dist/modules/telegram/spoken-reply.service");
  const { VoiceHandler } = require("../dist/modules/telegram/handlers/voice.handler");
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AiModule);
  assert.equal(providers.find((provider) => provider.provide === TTS_SERVICE).useClass, YandexTtsService);
  assert.ok(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AiModule).includes(TTS_SERVICE));
  assert.ok(Reflect.getMetadata(MODULE_METADATA.IMPORTS, TelegramModule).includes(AiModule));
  assert.ok(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TelegramModule).includes(SpokenReplyService));
  assert.ok(Reflect.getMetadata("design:paramtypes", VoiceHandler).includes(SpokenReplyService));
  assert.deepEqual(Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, SpokenReplyService), [{ index: 0, param: TTS_SERVICE }]);
});
