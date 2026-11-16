import { Injectable } from "@nestjs/common";
import { Context } from "grammy";
import { PracticeReplyWorkflowService } from "../practice-reply-workflow.service";

@Injectable()
export class TextHandler {
  constructor(private readonly workflow: PracticeReplyWorkflowService) {}

  async handle(ctx: Context): Promise<void> {
    if (!ctx.from?.id || !ctx.message || typeof ctx.message.text !== "string") return;
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    if (!text) {
      await ctx.reply("Отправьте непустой ответ на английском голосом или текстом.");
      return;
    }
    if (text.length > 4096) {
      await ctx.reply("Текстовый ответ слишком длинный. Максимум — 4096 символов.");
      return;
    }
    await this.workflow.handle(ctx, "text", async () => text);
  }
}
