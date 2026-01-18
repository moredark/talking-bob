import { Injectable, Logger } from "@nestjs/common";
import { ITTSService, TTSResult } from "../interfaces";

@Injectable()
export class TTSService implements ITTSService {
  private readonly logger = new Logger(TTSService.name);
  private readonly apiBaseUrl = "https://api.elevenlabs.io/v1/text-to-speech";
  private readonly model = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
  private readonly voiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
  private readonly outputFormat = "mp3_44100_128";

  async synthesize(
    text: string,
    language: string = "ru"
  ): Promise<TTSResult> {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not defined");
    }

    const url = `${this.apiBaseUrl}/${this.voiceId}?output_format=${this.outputFormat}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
          language_code: language,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0,
            speed: 1,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`ElevenLabs API error: ${response.status} - ${errorText}`);
        throw new Error(`ElevenLabs API error: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      this.logger.log(`TTS synthesis complete, size: ${audioBuffer.length} bytes`);

      return {
        audioBuffer,
        format: "mp3",
      };
    } catch (error) {
      this.logger.error("TTS synthesis failed:", error);
      throw error;
    }
  }
}
