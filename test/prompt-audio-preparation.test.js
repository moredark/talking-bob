const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { planPromptAudio, preparePromptAudio, promptAudioKey, PromptAudioPreparationError } = require("../dist/modules/prompt/prompt-audio-preparation");
const { FilePromptAudioCheckpoints } = require("../dist/modules/prompt/prompt-audio-checkpoints");
const { parsePreparationArgs, resolvePreparationTarget } = require("../dist/scripts/prepare-prompt-audio");

const p=(id,topic="Question?")=>({id,topic,audioFileId:null,isActive:true});
const base=(overrides={})=>({prompts:[p("p1")],botId:42,chatId:"100",speed:.95,tts:{enabled:true,synthesize:async()=>Buffer.from("audio")},store:{get:async(id)=>p(id),attach:async()=>true},checkpoints:{read:async()=>null,write:async()=>{}},upload:async()=>({fileId:"file",messageId:1}),...overrides});

test("plan filters inactive/cached prompts, enforces limit and caption length",()=>{
  assert.deepEqual(planPromptAudio([p("a"),{...p("b"),isActive:false},{...p("c"),audioFileId:"old"}],100,5000).prompts.map(x=>x.id),["a"]);
  assert.throws(()=>planPromptAudio([p("a","x".repeat(101))],100,100),/question_does_not_fit/);
  assert.throws(()=>planPromptAudio([p("a","123"),p("b","456")],5,5000),/batch_exceeds/);
});

test("successful preparation synthesizes exact topic and uploads",async()=>{let text, uploaded; const prompt=p("p1","Exact <b>текст</b> 😀"); const o=base({prompts:[prompt],store:{get:async()=>prompt,attach:async()=>true},tts:{enabled:true,synthesize:async(x)=>{text=x;return Buffer.from("audio")}},upload:async(a,x)=>{uploaded=[a,x];return {fileId:"fid",messageId:3}}}); const r=await preparePromptAudio(o); assert.equal(text,o.prompts[0].topic); assert.equal(uploaded[1],o.prompts[0]); assert.deepEqual(r,{saved:1,skipped:0});});

test("ready and uploaded checkpoints resume without TTS/upload",async()=>{for(const phase of ["ready","uploaded"]){let t=0,u=0; const prompt=p("p1"); const key=promptAudioKey(prompt,42,.95); const checkpoint=phase==="ready"?{version:1,key,promptId:"p1",phase,audioBase64:Buffer.from("a").toString("base64")}:{version:1,key,promptId:"p1",phase,fileId:"old",messageId:1}; const r=await preparePromptAudio(base({checkpoints:{read:async()=>checkpoint,write:async()=>{}},tts:{enabled:true,synthesize:async()=>{t++;return Buffer.from("x")}},upload:async()=>{u++;return {fileId:"new",messageId:2}}})); assert.equal(t,0); assert.equal(u,phase==="ready"?1:0); assert.equal(r.saved,1);}}
);

test("in-progress checkpoints block paid repeat",async()=>{const prompt=p("p1"), key=promptAudioKey(prompt,42,.95); for(const phase of ["synthesizing","uploading"]){await assert.rejects(preparePromptAudio(base({checkpoints:{read:async()=>({version:1,key,promptId:"p1",phase,audioBase64:"YQ=="}),write:async()=>{}}})),/uncertain_previous/);}});

test("uploaded checkpoint is written before failed database attach",async()=>{const writes=[]; const prompt=p("p1"); const key=promptAudioKey(prompt,42,.95); await assert.rejects(preparePromptAudio(base({checkpoints:{read:async()=>null,write:async x=>writes.push(x)},store:{get:async()=>prompt,attach:async()=>{throw new Error("db")}}})),/database_write_failed/); assert.equal(writes.at(-1).phase,"uploaded");});

test("stale prompt is skipped and key binds bot/text/speed",async()=>{let t=0; const prompt=p("p1","old"); const result=await preparePromptAudio(base({prompts:[prompt],store:{get:async()=>({...prompt,topic:"new"}),attach:async()=>true},tts:{enabled:true,synthesize:async()=>{t++;return Buffer.from("a")}}})); assert.deepEqual(result,{saved:0,skipped:1}); assert.equal(t,0); assert.notEqual(promptAudioKey(prompt,1,.95),promptAudioKey(prompt,2,.95)); assert.notEqual(promptAudioKey(prompt,1,.95),promptAudioKey({...prompt,topic:"new"},1,.95)); assert.notEqual(promptAudioKey(prompt,1,.95),promptAudioKey(prompt,1,1));});

test("file checkpoints validate keys, lock and survive atomic write/read",async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),"bob-audio-")); try{const cache=new FilePromptAudioCheckpoints(dir); const key="a".repeat(64); const value={version:1,key,promptId:"p",phase:"uploaded",fileId:"f",messageId:1}; await cache.write(value); assert.deepEqual(await cache.read(key),value); await assert.rejects(cache.read("bad"),/invalid_checkpoint_key/); await cache.withLock(async()=>assert.rejects(cache.withLock(async()=>{}),/cache_locked/));} finally{await fs.rm(dir,{recursive:true,force:true});}});

test("CLI defaults to dry run and requires apply identity",()=>{assert.equal(parsePreparationArgs([]).apply,false); assert.equal(parsePreparationArgs([]).limit,1000); assert.throws(()=>parsePreparationArgs(["--apply"]),/apply_requires/); assert.throws(()=>parsePreparationArgs(["--apply","--dry-run"]),/conflicting/);});

test("target resolver verifies private chat and bot id",async()=>{const prisma={user:{findMany:async()=>[{telegramId:123n}]}}; const api={getMe:async()=>({id:42,username:"bob"}),getChat:async()=>({id:123,type:"private",username:"User"})}; const target=await resolvePreparationTarget(prisma,api,{username:"user",botId:42}); assert.equal(target.chatId,"123"); await assert.rejects(resolvePreparationTarget(prisma,{...api,getMe:async()=>({id:7})},{chatId:"123",botId:42}),/bot_id_mismatch/);});




test("uncertain phases never call synth, upload, or attach", async () => {
  for (const phase of ["synthesizing", "uploading"]) {
    let synth = 0; let upload = 0; let attach = 0;
    const prompt = p("p1"); const key = promptAudioKey(prompt, 42, .95);
    await assert.rejects(preparePromptAudio(base({
      checkpoints: { read: async () => ({ version: 1, key, promptId: "p1", phase, audioBase64: "YQ==" }), write: async () => {} },
      tts: { enabled: true, synthesize: async () => { synth += 1; return Buffer.from("x"); } },
      upload: async () => { upload += 1; return { fileId: "f", messageId: 1 }; },
      store: { get: async () => prompt, attach: async () => { attach += 1; return true; } },
    })), /uncertain_previous/);
    assert.deepEqual([synth, upload, attach], [0, 0, 0]);
  }
});

test("stale active/audio/topic changes never overwrite after synthesis", async () => {
  let synth = 0; let upload = 0; let attach = 0;
  const prompt = p("p1", "old"); let current = { ...prompt };
  const result = await preparePromptAudio(base({
    prompts: [prompt],
    store: { get: async () => current, attach: async () => { attach += 1; return true; } },
    tts: { enabled: true, synthesize: async () => { synth += 1; current = { ...current, topic: "changed" }; return Buffer.from("x"); } },
    upload: async () => { upload += 1; return { fileId: "f", messageId: 1 }; },
  }));
  assert.deepEqual(result, { saved: 0, skipped: 1 });
  assert.deepEqual([synth, upload, attach], [1, 0, 0]);

  current = { ...prompt, isActive: false };
  const inactive = await preparePromptAudio(base({
    prompts: [prompt],
    store: { get: async () => current, attach: async () => { attach += 1; return true; } },
    tts: { enabled: true, synthesize: async () => { synth += 1; return Buffer.from("x"); } },
    upload: async () => { upload += 1; return { fileId: "f", messageId: 1 }; },
  }));
  assert.deepEqual(inactive, { saved: 0, skipped: 1 });
});

test("checkpoint write precedes external calls and synthesis failure preserves synthesizing", async () => {
  const prompt = p("p1"); const phases = []; let calls = 0;
  await assert.rejects(preparePromptAudio(base({
    checkpoints: { read: async () => null, write: async (value) => { phases.push(value.phase); }, },
    tts: { enabled: true, synthesize: async () => { calls += 1; throw new Error("fail"); } },
  })), /synthesis_failed/);
  assert.deepEqual(phases, ["synthesizing"]); assert.equal(calls, 1);
  let external = 0;
  await assert.rejects(preparePromptAudio(base({
    checkpoints: { read: async () => null, write: async () => { throw new Error("disk"); } },
    tts: { enabled: true, synthesize: async () => { external += 1; return Buffer.from("x"); } },
    upload: async () => { external += 1; return { fileId: "f", messageId: 1 }; },
  })), /database_write_failed|disk/);
  assert.equal(external, 0);
});

test("telegram rejection restores ready; unknown upload stays uploading", async () => {
  const prompt = p("p1"); const key = promptAudioKey(prompt, 42, .95);
  for (const error of [new PromptAudioPreparationError("telegram_rejected", "p1"), new Error("network")]) {
    const phases = [];
    await assert.rejects(preparePromptAudio(base({
      checkpoints: { read: async () => ({ version: 1, key, promptId: "p1", phase: "ready", audioBase64: "YQ==" }), write: async (value) => phases.push(value.phase) },
      upload: async () => { throw error; },
    })));
    assert.equal(phases.at(-1), error.code === "telegram_rejected" ? "ready" : "uploading");
  }
});

test("attach false skips without regeneration", async () => {
  let synth = 0; let upload = 0;
  const result = await preparePromptAudio(base({
    store: { get: async () => p("p1"), attach: async () => false },
    tts: { enabled: true, synthesize: async () => { synth += 1; return Buffer.from("x"); } },
    upload: async () => { upload += 1; return { fileId: "f", messageId: 1 }; },
  }));
  assert.deepEqual(result, { saved: 0, skipped: 1 });
  assert.deepEqual([synth, upload], [1, 1]);
});

test("CLI rejects unknown flags and invalid limits", () => {
  assert.throws(() => parsePreparationArgs(["--unknown"]), /invalid_command_arguments/);
  assert.throws(() => parsePreparationArgs(["--limit", "0"]), /invalid_numeric_argument/);
  assert.throws(() => parsePreparationArgs(["--max-characters", "1000001"]), /invalid_numeric_argument/);
});

test("recipient resolution rejects duplicates, missing user, username mismatch and non-private chat", async () => {
  const api = { getMe: async () => ({ id: 42 }), getChat: async () => ({ id: 123, type: "private", username: "other" }) };
  await assert.rejects(resolvePreparationTarget({ user: { findMany: async () => [{ telegramId: 1n }, { telegramId: 2n }] } }, api, { username: "person", botId: 42 }), /recipient_not_unique/);
  await assert.rejects(resolvePreparationTarget({ user: { findMany: async () => [] } }, api, { username: "person", botId: 42 }), /recipient_not_unique/);
  await assert.rejects(resolvePreparationTarget({ user: { findMany: async () => [{ telegramId: 123n }] } }, api, { username: "person", botId: 42 }), /telegram_recipient_mismatch/);
  await assert.rejects(resolvePreparationTarget({ user: { findMany: async () => [{ telegramId: 123n }] } }, { ...api, getChat: async () => ({ id: 123, type: "group" }) }, { chatId: "123", botId: 42 }), /telegram_recipient_mismatch/);
});

test("recipient resolution rejects supplied id mismatch", async () => {
  const api = { getMe: async () => ({ id: 42 }), getChat: async () => ({ id: 123, type: "private", username: "person" }) };
  await assert.rejects(resolvePreparationTarget({ user: { findMany: async () => [{ telegramId: 123n }] } }, api, { username: "person", chatId: "999", botId: 42 }), /recipient_id_mismatch/);
});

test("Telegram upload uses hidden caption and only explicit client rejection is retryable", async () => {
  const { GrammyError, HttpError } = require("grammy");
  const { uploadPromptAudio } = require("../dist/scripts/prepare-prompt-audio");
  const prompt = p("p1", "Exact question?");
  let request;
  const result = await uploadPromptAudio({
    sendVoice: async (...args) => {
      request = args;
      return { message_id: 7, voice: { file_id: "reusable", file_unique_id: "not-for-reuse" } };
    },
  }, "123", Buffer.from("audio"), prompt);
  assert.deepEqual(result, { fileId: "reusable", messageId: 7 });
  assert.equal(request[0], "123");
  assert.equal(request[2].disable_notification, true);
  const [entity] = request[2].caption_entities;
  assert.equal(entity.type, "spoiler");
  assert.equal(request[2].caption.slice(entity.offset, entity.offset + entity.length), prompt.topic);
  for (const code of [400, 403, 429, 408, 500, 502]) {
    const failure = new GrammyError("Rejected", { ok: false, error_code: code, description: "error" }, "sendVoice", {});
    await assert.rejects(uploadPromptAudio({ sendVoice: async () => { throw failure; } }, "123", Buffer.from("audio"), prompt),
      (error) => code < 500 && code !== 408 ? error.code === "telegram_rejected" : error === failure);
  }
  const network = new HttpError("transport", new Error("timeout"));
  await assert.rejects(uploadPromptAudio({ sendVoice: async () => { throw network; } }, "123", Buffer.from("audio"), prompt),
    (error) => error === network);
});

test("an empty prompt selector cannot silently expand to the whole catalog", () => {
  assert.throws(() => parsePreparationArgs(["--prompt-id", ""]), /invalid_prompt_id/);
  assert.throws(() => parsePreparationArgs(["--cache-dir", ""]), /invalid_cache_directory/);
});
