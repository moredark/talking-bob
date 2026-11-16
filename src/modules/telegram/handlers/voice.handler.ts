import { Inject, Injectable } from "@nestjs/common";
import { Context } from "grammy";
import { RUNTIME_CONFIG } from "../../../config/runtime-config.module";
import { RuntimeConfig } from "../../../config/runtime.config";
import { RuntimeSettingsService } from "../../../config/runtime-settings.service";
import { boundedFetch } from "../../../infrastructure/http";
import { WHISPER_SERVICE, IWhisperService } from "../../ai";
import { PracticeReplyWorkflowService } from "../practice-reply-workflow.service";

@Injectable()
export class VoiceHandler {
  @Inject(RuntimeSettingsService) private readonly settings!: RuntimeSettingsService;
  constructor(
    private readonly workflow: PracticeReplyWorkflowService,
    @Inject(WHISPER_SERVICE) private readonly whisperService: IWhisperService,
    @Inject(RUNTIME_CONFIG) private readonly runtimeConfig: RuntimeConfig,
  ) {}

  async handle(ctx: Context): Promise<void> {
    const voice = ctx.message?.voice;
    if (!ctx.from?.id || !voice) return;
    const maxDurationSeconds = this.settings.productNumber("VOICE_MAX_DURATION_SECONDS");
    const maxFileSizeBytes = this.settings.productNumber("VOICE_MAX_FILE_SIZE_BYTES");
    if (voice.duration > maxDurationSeconds) {
      await ctx.reply(`Голосовое сообщение слишком длинное. Максимум — ${maxDurationSeconds} секунд.`);
      return;
    }
    if (typeof voice.file_size === "number" && voice.file_size > maxFileSizeBytes) {
      await ctx.reply(`Голосовое сообщение слишком большое. Максимум — ${this.formatByteLimit(maxFileSizeBytes)}.`);
      return;
    }
    await this.workflow.handle(ctx, "voice", async (stage) => {
      stage("telegram_download");
      const audio = await this.downloadVoiceFile(ctx, voice.file_id, maxFileSizeBytes);
      stage("whisper_transcribe");
      return (await this.whisperService.transcribe(audio, "en")).text;
    }, voice.file_id);
  }

  private async downloadVoiceFile(ctx: Context, fileId: string, maxFileSizeBytes: number): Promise<Buffer> {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error("File path not available");
    const url = `https://api.telegram.org/file/bot${this.runtimeConfig.telegramBotToken}/${file.file_path}`;
    const response = await boundedFetch(url, {
      timeoutMs: this.runtimeConfig.externalRequests.telegramFileDownload.timeoutMs,
      maxResponseBytes: Math.min(
        maxFileSizeBytes,
        this.runtimeConfig.externalRequests.telegramFileDownload.maxResponseBytes,
      ),
      safeToRetry: true,
    });
    if (!response.ok) throw new Error(`Telegram file download failed with ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private formatByteLimit(bytes: number): string {
    const mebibyte = 1024 * 1024;
    const kibibyte = 1024;
    if (bytes >= mebibyte) {
      const value = bytes / mebibyte;
      return `${Number.isInteger(value) ? value : value.toFixed(1)} МиБ`;
    }
    if (bytes >= kibibyte) return `${Math.ceil(bytes / kibibyte)} КиБ`;
    return `${bytes} байт`;
  }
}
