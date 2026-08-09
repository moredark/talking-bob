import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { RUNTIME_CONFIG } from "../../../config/runtime-config.module";
import { RuntimeConfig } from "../../../config/runtime.config";
import { boundedFetch, BoundedHttpError } from "../../../infrastructure/http";
import { IWhisperService, TranscriptionResult } from "../interfaces";
import { AiRequestLimiterService } from "./ai-request-limiter.service";
import { ErrorLogService } from "../../error-log";

class WhisperProviderStatusError extends Error {
  constructor(readonly statusCode: number) {
    super("Whisper provider rejected the request");
    this.name = "WhisperProviderStatusError";
  }
}

@Injectable()
export class WhisperService implements IWhisperService {
  private readonly logger = new Logger(WhisperService.name);
  private readonly apiUrl =
    "https://foundation-models.api.cloud.ru/v1/audio/transcriptions";
  private readonly model = "openai/whisper-large-v3";

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly runtimeConfig: RuntimeConfig,
    private readonly requestLimiter: AiRequestLimiterService,
    @Optional() private readonly errorLog?: ErrorLogService,
  ) {}

  async transcribe(
    audioBuffer: Buffer,
    language: string = "ru",
  ): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" });
    formData.append("file", blob, "audio.ogg");
    formData.append("model", this.model);
    formData.append("response_format", "text");
    formData.append("temperature", "0.5");
    formData.append("language", language);

    try {
      const response = await this.requestLimiter.run((signal) =>
        boundedFetch(this.apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.runtimeConfig.cloudRuApiKey}`,
          },
          body: formData,
          signal,
          timeoutMs: this.runtimeConfig.externalRequests.whisper.timeoutMs,
          maxResponseBytes:
            this.runtimeConfig.externalRequests.whisper.maxResponseBytes,
        }),
      );

      if (!response.ok) {
        this.logger.error(`Whisper API returned status ${response.status}`);
        throw new WhisperProviderStatusError(response.status);
      }

      const responseText = await response.text();
      const text = this.parseTranscriptionResponse(responseText);
      this.logger.log("Transcription completed");

      return {
        text: text.trim(),
        language,
      };
    } catch (error) {
      this.logger.error(`Transcription failed (${this.errorKind(error)})`);
      await this.errorLog?.capture({
        type: "ai",
        service: "whisper",
        operation: "transcribe",
        latencyMs: Date.now() - startedAt,
        statusCode: error instanceof WhisperProviderStatusError ? error.statusCode : undefined,
        retryable: this.isRetryable(error),
        error,
        code: error instanceof BoundedHttpError ? error.code : undefined,
      });
      throw error;
    }
  }

  private parseTranscriptionResponse(responseText: string): string {
    try {
      const parsed = JSON.parse(responseText);
      if (parsed.text) return parsed.text;
      return responseText;
    } catch {
      return responseText;
    }
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof WhisperProviderStatusError) return error.statusCode === 429 || error.statusCode >= 500;
    return error instanceof BoundedHttpError && (error.code === "network" || error.code === "timeout");
  }
}
