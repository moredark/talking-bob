import { Module } from "@nestjs/common";
import { TelegramService } from "./telegram.service";
import { StartHandler, VoiceHandler } from "./handlers";
import { UserModule } from "../user";
import { PromptModule } from "../prompt";
import { ResponseModule } from "../response";
import { RateLimitModule } from "../rate-limit";
import { AiModule } from "../ai";

@Module({
  imports: [
    UserModule,
    PromptModule,
    ResponseModule,
    RateLimitModule,
    AiModule,
  ],
  providers: [TelegramService, StartHandler, VoiceHandler],
  exports: [TelegramService],
})
export class TelegramModule {}
