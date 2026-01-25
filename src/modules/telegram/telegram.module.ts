import { Module } from "@nestjs/common";
import { TelegramService } from "./telegram.service";
import { StartHandler, VoiceHandler, ReportHandler, SettingsHandler } from "./handlers";
import { UserModule } from "../user";
import { PromptModule } from "../prompt";
import { ResponseModule } from "../response";
import { ConversationModule } from "../conversation";
import { RateLimitModule } from "../rate-limit";
import { AiModule } from "../ai";
import { ScheduleModule } from "../schedule";

@Module({
  imports: [
    UserModule,
    PromptModule,
    ResponseModule,
    ConversationModule,
    RateLimitModule,
    AiModule,
    ScheduleModule,
  ],
  providers: [TelegramService, StartHandler, VoiceHandler, ReportHandler, SettingsHandler],
  exports: [TelegramService],
})
export class TelegramModule {}
