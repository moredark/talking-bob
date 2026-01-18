export interface TTSResult {
  audioBuffer: Buffer;
  format: string;
}

export interface ITTSService {
  synthesize(text: string, language?: string): Promise<TTSResult>;
}

export const TTS_SERVICE = Symbol("TTS_SERVICE");
