import { Inject, Injectable, Logger } from "@nestjs/common";
import { Context, GrammyError, InlineKeyboard, InputFile } from "grammy";
import { ITtsService, TTS_SERVICE } from "../ai/interfaces/tts.interface";
import { buildVoiceCaption } from "./voice-caption";

export class AmbiguousSpokenReplyDeliveryError extends Error {
  constructor(readonly cause: unknown) {
    super("Telegram voice delivery outcome is unknown");
    this.name = "AmbiguousSpokenReplyDeliveryError";
  }
}

@Injectable()
export class SpokenReplyService {
  private readonly logger = new Logger(SpokenReplyService.name);

  constructor(@Inject(TTS_SERVICE) private readonly tts: ITtsService) {}

  async send(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
    const caption = buildVoiceCaption(text);
    if (!this.tts.enabled || !caption) {
      await this.sendText(ctx, text, keyboard);
      return;
    }

    let audio: Buffer;
    try {
      audio = await this.tts.synthesize(text);
    } catch {
      this.logger.warn("Speech synthesis unavailable; sending original text");
      await this.sendText(ctx, text, keyboard);
      return;
    }

    try {
      await ctx.replyWithVoice(new InputFile(audio, "reply.ogg"), {
        ...caption,
        reply_markup: keyboard,
      });
    } catch (error) {
      if (!(error instanceof GrammyError)) {
        // A timeout may occur after Telegram accepted the voice message.
        throw new AmbiguousSpokenReplyDeliveryError(error);
      }
      await this.sendText(ctx, text, keyboard);
    }
  }

  private async sendText(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
    // Keep the complete original even if a provider returns an unusually long reply.
    let remaining = text;
    while (remaining.length > 4096) {
      let end = 4096;
      const lastCodeUnit = remaining.charCodeAt(end - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
      await ctx.reply(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    await ctx.reply(remaining, { reply_markup: keyboard });
  }
}
