import type { MessageEntity } from "grammy/types";

export const VOICE_TRANSCRIPT_HINT = "Не всё расслышал? Нажми на скрытый текст ниже.\n\n";
const MAX_CAPTION_LENGTH = 1024;

export interface VoiceCaption {
  caption: string;
  caption_entities: MessageEntity[];
}

export function buildVoiceCaption(text: string): VoiceCaption | null {
  if (!text.trim()) return null;
  const caption = VOICE_TRANSCRIPT_HINT + text;
  if (caption.length > MAX_CAPTION_LENGTH) return null;

  return {
    caption,
    caption_entities: [{
      type: "spoiler",
      offset: VOICE_TRANSCRIPT_HINT.length,
      length: text.length,
    }],
  };
}
