import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { config as loadEnv, parse as parseEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { Api, GrammyError, InputFile } from "grammy";
import { parseRuntimeConfig, RuntimeConfigError } from "../config/runtime.config";
import { AiRequestLimiterService } from "../modules/ai/services/ai-request-limiter.service";
import { YandexTtsService } from "../modules/ai/services/yandex-tts.service";
import { ITtsService } from "../modules/ai/interfaces/tts.interface";
import { buildVoiceCaption } from "../modules/telegram/voice-caption";
import { FilePromptAudioCheckpoints } from "../modules/prompt/prompt-audio-checkpoints";
import { AudioPrompt, planPromptAudio, preparePromptAudio, PromptAudioPreparationError } from "../modules/prompt/prompt-audio-preparation";

const HELP = `Prepare existing active questions with Yandex john (en-US).
Default: dry run. Never starts polling, the HTTP server, seeds or scheduled jobs.

  --dry-run                    List work without synthesis, upload or database writes
  --apply --bot-id ID           Generate/upload and save IDs for this verified bot
  --username USERNAME           Resolve a private chat from the bot's users table
  --chat-id ID                  Alternatively, a positive numeric private chat ID
  --limit N                    Maximum questions (default 1000; max 1000)
  --prompt-id UUID              Prepare only this question if its audio is missing
  --max-characters N            Whole-batch cap (default 50000; max 1000000)
  --cache-dir PATH              Durable checkpoints (default .cache/prompt-audio)
  --speechkit-env PATH          Read only the TTS API key from an ignored env file
  --help                       Show this help

Examples:
  corepack pnpm prompts:audio --dry-run --username moredarkie
  corepack pnpm prompts:audio --apply --username moredarkie --bot-id 123456 --limit 1
Use the same cache directory and bot on subsequent runs. Single-host operation only.
`;

export function parsePreparationArgs(args: string[]) {
  let values;
  try {
    ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
      help: { type: "boolean" }, apply: { type: "boolean" }, "dry-run": { type: "boolean" },
      username: { type: "string" }, "chat-id": { type: "string" }, "bot-id": { type: "string" },
      limit: { type: "string" }, "prompt-id": { type: "string" }, "max-characters": { type: "string" },
      "cache-dir": { type: "string" }, "speechkit-env": { type: "string" },
    } }));
  } catch { throw new PromptAudioPreparationError("invalid_command_arguments_use_help"); }
  const integer = (raw: string | undefined, fallback: number, max: number) => {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new PromptAudioPreparationError("invalid_numeric_argument");
    return value;
  };
  const username = values.username?.replace(/^@/, "");
  if (username !== undefined && !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new PromptAudioPreparationError("invalid_username");
  const chatId = values["chat-id"];
  if (chatId !== undefined && !/^[1-9][0-9]{0,15}$/.test(chatId)) throw new PromptAudioPreparationError("private_numeric_chat_id_required");
  if (chatId && !Number.isSafeInteger(Number(chatId))) throw new PromptAudioPreparationError("invalid_chat_id");
  if (values["cache-dir"] !== undefined && !values["cache-dir"].trim()) throw new PromptAudioPreparationError("invalid_cache_directory");
  const promptId = values["prompt-id"];
  if (promptId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(promptId)) throw new PromptAudioPreparationError("invalid_prompt_id");
  if (values.apply && values["dry-run"]) throw new PromptAudioPreparationError("conflicting_execution_modes");
  if (values.apply && (!values["bot-id"] || (!username && !chatId))) throw new PromptAudioPreparationError("apply_requires_bot_id_and_private_recipient");
  return {
    help: values.help ?? false, apply: values.apply ?? false, username, chatId, promptId,
    botId: values["bot-id"] ? integer(values["bot-id"], 1, Number.MAX_SAFE_INTEGER) : undefined,
    limit: integer(values.limit, 1000, 1000), maxCharacters: integer(values["max-characters"], 50_000, 1_000_000),
    cacheDir: resolve(values["cache-dir"] ?? ".cache/prompt-audio"), speechkitEnv: values["speechkit-env"],
  };
}

export async function resolvePreparationTarget(
  prisma: PrismaClient, api: Api,
  options: Pick<ReturnType<typeof parsePreparationArgs>, "username" | "chatId" | "botId">,
) {
  let chatId = options.chatId;
  if (options.username) {
    const users = await prisma.user.findMany({
      where: { username: { equals: options.username, mode: "insensitive" } },
      select: { telegramId: true }, take: 2,
    });
    if (users.length !== 1) throw new PromptAudioPreparationError("recipient_not_unique_in_database");
    const resolved = users[0].telegramId.toString();
    if (chatId && chatId !== resolved) throw new PromptAudioPreparationError("recipient_id_mismatch");
    chatId = resolved;
  }
  if (!chatId) throw new PromptAudioPreparationError("recipient_required");
  const bot = await api.getMe();
  if (options.botId !== undefined && bot.id !== options.botId) throw new PromptAudioPreparationError("bot_id_mismatch");
  const chat = await api.getChat(chatId);
  if (chat.type !== "private" || String(chat.id) !== chatId
    || (options.username && chat.username?.toLowerCase() !== options.username.toLowerCase())) {
    throw new PromptAudioPreparationError("telegram_recipient_mismatch");
  }
  return { botId: bot.id, botUsername: bot.username, chatId, username: chat.username };
}

export async function uploadPromptAudio(api: Api, chatId: string, audio: Buffer, prompt: AudioPrompt) {
  try {
    const message = await api.sendVoice(chatId, new InputFile(audio, `${prompt.id}.ogg`), {
      ...buildVoiceCaption(prompt.topic)!, disable_notification: true,
    });
    if (!message.voice?.file_id) throw new PromptAudioPreparationError("missing_voice_in_upload_response");
    return { fileId: message.voice.file_id, messageId: message.message_id };
  } catch (error) {
    // A server-side failure or request timeout can occur after the upload was accepted.
    if (error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 && error.error_code !== 408) {
      throw new PromptAudioPreparationError("telegram_rejected");
    }
    throw error;
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parsePreparationArgs(args);
  if (options.help) { process.stdout.write(HELP); return; }
  loadEnv({ quiet: true });
  const env = { ...process.env };
  if (options.speechkitEnv && !env.YANDEX_SPEECHKIT_API_KEY?.trim()) {
    // Never replace the bot token or database URL with credentials from an audition env file.
    env.YANDEX_SPEECHKIT_API_KEY = parseEnv(readFileSync(options.speechkitEnv)).YANDEX_SPEECHKIT_API_KEY;
  }
  const config = parseRuntimeConfig({ ...env, TTS_ENABLED: options.apply ? "true" : "false" });
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const limiter = new AiRequestLimiterService(1, 0);
  try {
    const prompts = await prisma.prompt.findMany({
      where: { isActive: true, OR: [{ audioFileId: null }, { audioFileId: "" }], ...(options.promptId ? { id: options.promptId } : {}) },
      select: { id: true, topic: true, audioFileId: true, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: options.limit,
    });
    const plan = planPromptAudio(prompts, options.maxCharacters, config.tts.maxTextCharacters);
    console.log(JSON.stringify({ mode: options.apply ? "apply" : "dry-run", questions: plan.prompts.length,
      characters: plan.characters, maxCharacters: options.maxCharacters, voice: "john", speed: config.tts.speed,
      promptIds: plan.prompts.map(({ id }) => id) }));
    const api = new Api(config.telegramBotToken, { timeoutSeconds: config.telegram.apiTimeoutMs / 1000 });
    const target = options.username || options.chatId ? await resolvePreparationTarget(prisma, api, options) : undefined;
    if (target) console.log(JSON.stringify({ verifiedTarget: target }));
    if (!options.apply || !plan.prompts.length) return;
    if (!target) throw new PromptAudioPreparationError("recipient_required");
    const tts: ITtsService = new YandexTtsService(config, limiter);
    const checkpoints = new FilePromptAudioCheckpoints(options.cacheDir);
    let lastUploadAt = 0;
    const result = await checkpoints.withLock(() => preparePromptAudio({
      prompts: plan.prompts, botId: target.botId, chatId: target.chatId, speed: config.tts.speed, tts, checkpoints,
      store: {
        get: (id) => prisma.prompt.findUnique({ where: { id }, select: { id: true, topic: true, audioFileId: true, isActive: true } }),
        attach: async (prompt, fileId) => (await prisma.prompt.updateMany({
          where: { id: prompt.id, topic: prompt.topic, audioFileId: prompt.audioFileId, isActive: true },
          data: { audioFileId: fileId },
        })).count === 1,
      },
      upload: async (audio, prompt) => {
        await delay(Math.max(0, 1100 - (Date.now() - lastUploadAt)));
        lastUploadAt = Date.now();
        return uploadPromptAudio(api, target.chatId, audio, prompt);
      },
      onProgress: (event) => console.log(JSON.stringify(event)),
    }));
    console.log(JSON.stringify({ complete: true, ...result }));
  } finally {
    limiter.close();
    await limiter.drain();
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof RuntimeConfigError) console.error(JSON.stringify({ code: "invalid_configuration", issues: error.issues }));
    else if (error instanceof PromptAudioPreparationError) console.error(JSON.stringify({ code: error.code, promptId: error.promptId }));
    else console.error(JSON.stringify({ code: "preparation_failed_check_database_credentials_network_and_cache" }));
    // Raw Prisma/Telegram errors may contain a database URL, bot token or caption.
    process.exitCode = 1;
  });
}
