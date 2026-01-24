import { Module } from "@nestjs/common";
import { TelegramService } from "./telegram.service";
import { SchedulerService } from "./scheduler.service";
import { StartHandler, VoiceHandler, ReportHandler, SettingsHandler } from "./handlers";
import { UserModule } from "../user";
import { PromptModule } from "../prompt";
import { ResponseModule } from "../response";
import { ConversationModule } from "../conversation";
import { RateLimitModule } from "../rate-limit";
import { AiModule } from "../ai";

@Module({
  imports: [
    UserModule,
    PromptModule,
    ResponseModule,
    ConversationModule,
    RateLimitModule,
    AiModule,
  ],
  providers: [TelegramService, SchedulerService, StartHandler, VoiceHandler, ReportHandler, SettingsHandler],
  exports: [TelegramService],
})
export class TelegramModule {}
