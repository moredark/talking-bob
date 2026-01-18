import { Injectable, Logger } from "@nestjs/common";
import { IWhisperService, TranscriptionResult } from "../interfaces";

@Injectable()
export class WhisperService implements IWhisperService {
  private readonly logger = new Logger(WhisperService.name);
  private readonly apiUrl =
    "https://foundation-models.api.cloud.ru/v1/audio/transcriptions";
  private readonly model = "openai/whisper-large-v3";

  async transcribe(
    audioBuffer: Buffer,
    language: string = "ru",
  ): Promise<TranscriptionResult> {
    const apiKey = process.env.CLOUD_RU_API_KEY;

    if (!apiKey) {
      throw new Error("CLOUD_RU_API_KEY is not defined");
    }

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" });
    formData.append("file", blob, "audio.ogg");
    formData.append("model", this.model);
    formData.append("response_format", "text");
    formData.append("temperature", "0.5");
    formData.append("language", language);

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Whisper API error: ${response.status} - ${errorText}`,
        );
        throw new Error(`Whisper API error: ${response.status}`);
      }

      const responseText = await response.text();
      const text = this.parseTranscriptionResponse(responseText);

      this.logger.log(`Transcription successful: ${text.substring(0, 50)}...`);

      return {
        text: text.trim(),
        language,
      };
    } catch (error) {
      this.logger.error("Transcription failed:", error);
      throw error;
    }
  }

  private parseTranscriptionResponse(responseText: string): string {
    try {
      const parsed = JSON.parse(responseText);
      if (parsed.text) {
        return parsed.text;
      }
      return responseText;
    } catch {
      return responseText;
    }
  }
}
