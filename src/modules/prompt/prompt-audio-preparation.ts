import { createHash } from "node:crypto";
import { ITtsService } from "../ai/interfaces/tts.interface";
import { buildVoiceCaption } from "../telegram/voice-caption";

export interface AudioPrompt {
  id: string;
  topic: string;
  audioFileId: string | null;
  isActive: boolean;
}

export interface PromptAudioStore {
  get(id: string): Promise<AudioPrompt | null>;
  attach(prompt: AudioPrompt, fileId: string): Promise<boolean>;
}

export interface AudioCheckpoint {
  version: 1;
  key: string;
  promptId: string;
  phase: "synthesizing" | "ready" | "uploading" | "uploaded";
  audioBase64?: string;
  fileId?: string;
  messageId?: number;
  chatId?: string;
}

export interface PromptAudioCheckpointStore {
  read(key: string): Promise<AudioCheckpoint | null>;
  write(checkpoint: AudioCheckpoint): Promise<void>;
}

export class PromptAudioPreparationError extends Error {
  constructor(readonly code: string, readonly promptId?: string) {
    super(code);
    this.name = "PromptAudioPreparationError";
  }
}

export function planPromptAudio(prompts: AudioPrompt[], maxCharacters: number, maxTextCharacters: number) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 1_000_000) {
    throw new PromptAudioPreparationError("invalid_character_budget");
  }
  const selected = prompts.filter((prompt) => prompt.isActive && !prompt.audioFileId?.trim());
  for (const prompt of selected) {
    // Exactly the same source text and caption constraints as the dispatcher.
    if (prompt.topic.length > maxTextCharacters || !buildVoiceCaption(prompt.topic)) {
      throw new PromptAudioPreparationError("question_does_not_fit_voice_caption", prompt.id);
    }
    const form = new URLSearchParams({ text: prompt.topic, lang: "en-US", voice: "john", format: "oggopus", speed: "1" });
    if (Buffer.byteLength(form.toString(), "utf8") > 15 * 1024) {
      throw new PromptAudioPreparationError("question_exceeds_encoded_body_limit", prompt.id);
    }
  }
  const characters = selected.reduce((total, prompt) => total + prompt.topic.length, 0);
  if (characters > maxCharacters) throw new PromptAudioPreparationError("batch_exceeds_character_budget");
  return { prompts: selected, characters };
}

export function promptAudioKey(prompt: AudioPrompt, botId: number, speed: number): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1, botId, promptId: prompt.id, text: prompt.topic,
    provider: "yandex-v1", voice: "john", lang: "en-US", format: "oggopus", speed,
  })).digest("hex");
}

export async function preparePromptAudio(options: {
  prompts: AudioPrompt[];
  botId: number;
  chatId: string;
  speed: number;
  tts: ITtsService;
  store: PromptAudioStore;
  checkpoints: PromptAudioCheckpointStore;
  upload: (audio: Buffer, prompt: AudioPrompt) => Promise<{ fileId: string; messageId: number }>;
  onProgress?: (event: { promptId: string; outcome: "saved" | "skipped"; key: string }) => void;
}) {
  const { store, checkpoints } = options;
  const result = { saved: 0, skipped: 0 };
  const stillEligible = async (prompt: AudioPrompt) => {
    const current = await store.get(prompt.id);
    return current?.isActive && current.topic === prompt.topic && current.audioFileId === prompt.audioFileId;
  };
  for (const prompt of options.prompts) {
    const key = promptAudioKey(prompt, options.botId, options.speed);
    if (!prompt.isActive || prompt.audioFileId?.trim() || !await stillEligible(prompt)) {
      result.skipped += 1;
      options.onProgress?.({ promptId: prompt.id, outcome: "skipped", key });
      continue;
    }
    let checkpoint = await checkpoints.read(key);
    if (checkpoint && checkpoint.promptId !== prompt.id) throw new PromptAudioPreparationError("checkpoint_mismatch", prompt.id);
    if (checkpoint?.phase === "synthesizing" || checkpoint?.phase === "uploading") {
      throw new PromptAudioPreparationError("uncertain_previous_request_check_checkpoint", prompt.id);
    }
    if (!checkpoint) {
      checkpoint = { version: 1, key, promptId: prompt.id, phase: "synthesizing" };
      // Mark BEFORE a potentially billable request. An interrupted request is not retried automatically.
      await checkpoints.write(checkpoint);
      let audio: Buffer;
      try { audio = await options.tts.synthesize(prompt.topic); }
      catch { throw new PromptAudioPreparationError("synthesis_failed_check_checkpoint", prompt.id); }
      checkpoint = { ...checkpoint, phase: "ready", audioBase64: audio.toString("base64") };
      await checkpoints.write(checkpoint);
    }
    if (checkpoint.phase === "ready") {
      if (!await stillEligible(prompt)) {
        result.skipped += 1;
        options.onProgress?.({ promptId: prompt.id, outcome: "skipped", key });
        continue;
      }
      if (!checkpoint.audioBase64) throw new PromptAudioPreparationError("invalid_checkpoint", prompt.id);
      const audio = Buffer.from(checkpoint.audioBase64, "base64");
      checkpoint = { ...checkpoint, phase: "uploading", chatId: options.chatId };
      await checkpoints.write(checkpoint);
      let uploaded: { fileId: string; messageId: number };
      try { uploaded = await options.upload(audio, prompt); }
      catch (error) {
        // Only an explicit Telegram rejection establishes that no message was delivered.
        if (error instanceof PromptAudioPreparationError && error.code === "telegram_rejected") {
          await checkpoints.write({ ...checkpoint, phase: "ready" });
          throw new PromptAudioPreparationError("telegram_rejected", prompt.id);
        }
        throw new PromptAudioPreparationError("upload_outcome_unknown_check_checkpoint", prompt.id);
      }
      if (!uploaded.fileId || !Number.isSafeInteger(uploaded.messageId)) {
        throw new PromptAudioPreparationError("upload_response_invalid_check_checkpoint", prompt.id);
      }
      checkpoint = { ...checkpoint, ...uploaded, phase: "uploaded" };
      // A later database failure can resume from this file_id without re-synthesis or another upload.
      await checkpoints.write(checkpoint);
    }
    if (!checkpoint.fileId) throw new PromptAudioPreparationError("invalid_checkpoint", prompt.id);
    let saved: boolean;
    try { saved = await store.attach(prompt, checkpoint.fileId); }
    catch { throw new PromptAudioPreparationError("database_write_failed_resume_checkpoint", prompt.id); }
    const outcome = saved ? "saved" : "skipped";
    result[outcome] += 1;
    options.onProgress?.({ promptId: prompt.id, outcome, key });
  }
  return result;
}
