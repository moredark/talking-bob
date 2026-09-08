import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { RUNTIME_CONFIG } from "../../../config/runtime-config.module";
import { RuntimeConfig } from "../../../config/runtime.config";
import { boundedFetch, BoundedHttpError } from "../../../infrastructure/http";
import { ErrorLogService } from "../../error-log";
import { ITtsService } from "../interfaces";
import { AiRequestLimiterService } from "./ai-request-limiter.service";

const YANDEX_TTS_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";
const MAX_ENCODED_BODY_BYTES = 15 * 1024;
const MAX_TEXT_CHARACTERS = 5_000;

class TtsProviderStatusError extends Error {
  constructor(readonly statusCode: number) {
    super("TTS provider rejected the request");
    this.name = "TtsProviderStatusError";
  }
}

@Injectable()
export class YandexTtsService implements ITtsService {
  private readonly logger = new Logger(YandexTtsService.name);
  readonly enabled: boolean;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly runtimeConfig: RuntimeConfig,
    private readonly requestLimiter: AiRequestLimiterService,
    @Optional() private readonly errorLog?: ErrorLogService,
  ) {
    const config = runtimeConfig.tts;
    this.enabled = config.enabled;
    if (this.enabled && config.apiKey.trim().length === 0) {
      throw new RangeError("TTS API key must be configured when TTS is enabled");
    }
    if (!Number.isSafeInteger(config.maxTextCharacters) || config.maxTextCharacters <= 0 || config.maxTextCharacters > MAX_TEXT_CHARACTERS) {
      throw new RangeError("TTS max text characters must be between 1 and 5000");
    }
    if (!Number.isFinite(config.speed) || config.speed < 0.1 || config.speed > 3) {
      throw new RangeError("TTS speed must be between 0.1 and 3");
    }
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!this.enabled) throw new Error("TTS is disabled");
    if (typeof text !== "string") throw new TypeError("TTS text must be a string");
    if (text.trim().length === 0) throw new RangeError("TTS text must not be empty");
    if (text.length > this.runtimeConfig.tts.maxTextCharacters) throw new RangeError("TTS text exceeds the configured character limit");

    const form = new URLSearchParams({ text, lang: "en-US", voice: "john", format: "oggopus", speed: String(this.runtimeConfig.tts.speed) });
    if (Buffer.byteLength(form.toString(), "utf8") > MAX_ENCODED_BODY_BYTES) throw new RangeError("TTS request exceeds the encoded body limit");

    const startedAt = Date.now();
    try {
      const response = await this.requestLimiter.run((signal) => boundedFetch(YANDEX_TTS_URL, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Api-Key ${this.runtimeConfig.tts.apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(), signal,
        timeoutMs: this.runtimeConfig.tts.request.timeoutMs,
        maxResponseBytes: this.runtimeConfig.tts.request.maxResponseBytes,
        safeToRetry: false,
      }));
      if (!response.ok) throw new TtsProviderStatusError(response.status);
      const audio = Buffer.from(await response.arrayBuffer());
      validateOggOpus(audio);
      return audio;
    } catch (error) {
      this.logger.error(`TTS synthesis failed (${this.errorKind(error)})`);
      await this.errorLog?.capture({ type: "ai", service: "tts", operation: "synthesize", latencyMs: Date.now() - startedAt, statusCode: error instanceof TtsProviderStatusError ? error.statusCode : undefined, retryable: this.isRetryable(error), error, code: error instanceof BoundedHttpError ? error.code : undefined });
      throw error;
    }
  }

  private errorKind(error: unknown): string { return error instanceof Error ? error.name : "UnknownError"; }
  private isRetryable(error: unknown): boolean {
    if (error instanceof TtsProviderStatusError) return error.statusCode === 429 || error.statusCode >= 500;
    return error instanceof BoundedHttpError && (error.code === "network" || error.code === "timeout");
  }
}

function validateOggOpus(audio: Buffer): void {
  if (audio.length < 47 || audio.toString("ascii", 0, 4) !== "OggS") throw new Error("TTS response is not a valid Ogg container");
  const packetStart = 27 + audio[26];
  const opusHeadOffset = audio.indexOf("OpusHead", 0, "ascii");
  if (opusHeadOffset < packetStart || opusHeadOffset > Math.min(packetStart + 255, audio.length - 19) || audio.length < opusHeadOffset + 19) throw new Error("TTS response is not an Opus stream");
}
