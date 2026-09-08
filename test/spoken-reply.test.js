const assert = require("node:assert/strict");
const test = require("node:test");
const { GrammyError, HttpError } = require("grammy");
const {
  SpokenReplyService,
  AmbiguousSpokenReplyDeliveryError,
} = require("../dist/modules/telegram/spoken-reply.service");
const { VOICE_TRANSCRIPT_HINT } = require("../dist/modules/telegram/voice-caption");

function ctx() {
  const calls = { voice: [], text: [] };
  return {
    calls,
    reply: async (...args) => calls.text.push(args),
    replyWithVoice: async (...args) => calls.voice.push(args),
  };
}
const keyboard = { inline_keyboard: [[{ text: "Report", callback_data: "report" }]] };

test("voice caption preserves exact Unicode/HTML text, spoiler offsets and report keyboard", async () => {
  const context = ctx();
  const text = "Hi <b>мир</b> 👋 & café";
  const synthesized = [];
  const tts = {
    enabled: true,
    synthesize: async (input) => { synthesized.push(input); return Buffer.from("ogg"); },
  };
  await new SpokenReplyService(tts).send(context, text, keyboard);

  assert.deepEqual(synthesized, [text]);
  assert.equal(context.calls.text.length, 0);
  assert.equal(context.calls.voice.length, 1);
  const options = context.calls.voice[0][1];
  assert.equal(options.caption, VOICE_TRANSCRIPT_HINT + text);
  assert.deepEqual(options.caption_entities, [{
    type: "spoiler", offset: VOICE_TRANSCRIPT_HINT.length, length: text.length,
  }]);
  assert.equal(options.parse_mode, undefined);
  assert.equal(options.reply_markup, keyboard);
});

test("disabled TTS sends original readable text without synthesis", async () => {
  const context = ctx();
  let syntheses = 0;
  await new SpokenReplyService({
    enabled: false,
    synthesize: async () => { syntheses += 1; return Buffer.from("ogg"); },
  }).send(context, "Original text", keyboard);

  assert.equal(syntheses, 0);
  assert.equal(context.calls.voice.length, 0);
  assert.deepEqual(context.calls.text, [["Original text", { reply_markup: keyboard }]]);
});

test("synthesis failure falls back to original readable text with report keyboard", async () => {
  const context = ctx();
  await new SpokenReplyService({
    enabled: true,
    synthesize: async () => { throw new Error("provider"); },
  }).send(context, "Original text", keyboard);

  assert.equal(context.calls.voice.length, 0);
  assert.deepEqual(context.calls.text, [["Original text", { reply_markup: keyboard }]]);
});

test("caption is voice at 1024 UTF-16 units and plain fallback above it without synthesis", async () => {
  const exact = "x".repeat(1024 - VOICE_TRANSCRIPT_HINT.length);
  let syntheses = 0;
  const service = new SpokenReplyService({
    enabled: true,
    synthesize: async () => { syntheses += 1; return Buffer.from("ogg"); },
  });
  const fits = ctx();
  await service.send(fits, exact, keyboard);
  assert.equal(fits.calls.voice[0][1].caption.length, 1024);
  assert.equal(syntheses, 1);

  const longer = ctx();
  await service.send(longer, exact + "x", keyboard);
  assert.equal(longer.calls.voice.length, 0);
  assert.equal(syntheses, 1);
  assert.deepEqual(longer.calls.text, [[exact + "x", { reply_markup: keyboard }]]);
});

test("long fallback keeps all content without splitting emoji and leaves keyboard on last chunk", async () => {
  const text = "a".repeat(4095) + "😀" + "b".repeat(4200);
  const context = ctx();
  let syntheses = 0;
  await new SpokenReplyService({
    enabled: true,
    synthesize: async () => { syntheses += 1; return Buffer.from("ogg"); },
  }).send(context, text, keyboard);

  assert.equal(syntheses, 0);
  const chunks = context.calls.text;
  assert.equal(chunks.map(([chunk]) => chunk).join(""), text);
  assert.ok(chunks.every(([chunk]) => chunk.length <= 4096));
  assert.ok(chunks.every(([chunk]) => !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.ok(chunks.every(([chunk]) => !/^[\uDC00-\uDFFF]/.test(chunk)));
  assert.ok(chunks.slice(0, -1).every((args) => args.length === 1));
  assert.equal(chunks.at(-1)[1].reply_markup, keyboard);
});

test("definite Telegram rejection falls back to readable text exactly once", async () => {
  const context = ctx();
  context.replyWithVoice = async () => {
    throw new GrammyError(
      "Telegram rejected request",
      { ok: false, error_code: 400, description: "Bad Request" },
      "sendVoice",
      {},
    );
  };
  await new SpokenReplyService({
    enabled: true, synthesize: async () => Buffer.from("ogg"),
  }).send(context, "Original text", keyboard);
  assert.deepEqual(context.calls.text, [["Original text", { reply_markup: keyboard }]]);
});

test("HttpError and unknown delivery failures do not create a text duplicate", async () => {
  for (const error of [new HttpError("network", new Error("timeout")), new Error("unknown")]) {
    const context = ctx();
    context.replyWithVoice = async () => { throw error; };
    await assert.rejects(
      new SpokenReplyService({
        enabled: true, synthesize: async () => Buffer.from("ogg"),
      }).send(context, "Original text", keyboard),
      (deliveryError) => deliveryError instanceof AmbiguousSpokenReplyDeliveryError && deliveryError.cause === error,
    );
    assert.equal(context.calls.text.length, 0);
  }
});

test("failed fallback send is propagated without another delivery attempt", async () => {
  const context = ctx();
  const failure = new HttpError("network", new Error("timeout"));
  let sends = 0;
  context.reply = async () => { sends += 1; throw failure; };
  await assert.rejects(
    new SpokenReplyService({
      enabled: true, synthesize: async () => { throw new Error("provider"); },
    }).send(context, "Original text", keyboard),
    (error) => error === failure,
  );
  assert.equal(sends, 1);
});
