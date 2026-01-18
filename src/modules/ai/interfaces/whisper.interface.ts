export interface TranscriptionResult {
  text: string;
  language?: string;
}

export interface IWhisperService {
  transcribe(audioBuffer: Buffer, language?: string): Promise<TranscriptionResult>;
}

export const WHISPER_SERVICE = Symbol("WHISPER_SERVICE");
