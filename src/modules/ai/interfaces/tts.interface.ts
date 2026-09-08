export interface ITtsService {
  readonly enabled: boolean;
  synthesize(text: string): Promise<Buffer>;
}

export const TTS_SERVICE = Symbol("TTS_SERVICE");
