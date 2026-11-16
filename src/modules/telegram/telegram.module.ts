import { PracticeReplyWorkflowService } from "./practice-reply-workflow.service";
import { Module } from "@nestjs/common";
import { TelegramService } from "./telegram.service";
import {
  StartHandler,
  VoiceHandler,
  TextHandler,
  ReportHandler,
  SettingsHandler,
  ScheduleHandler,
} from "./handlers";
import { UserModule } from "../user";
import { PromptModule } from "../prompt";
import { ResponseModule } from "../response";
import { ConversationModule } from "../conversation";
import { RateLimitModule } from "../rate-limit";
import { AiModule } from "../ai";
import { ScheduleModule } from "../schedule";
import { ReportWorkflowService } from "./report-workflow.service";
import { BroadcastModule } from "../broadcast";
import { PersonalityModule } from "../personality";
import { StreakModule } from "../streak";
import { SpokenReplyService } from "./spoken-reply.service";

@Module({
  imports: [
    UserModule,
    PromptModule,
    ResponseModule,
    ConversationModule,
    RateLimitModule,
    AiModule,
    ScheduleModule,
    BroadcastModule,
    StreakModule,
    PersonalityModule,
  ],
  providers: [
    TelegramService,
    StartHandler,
    VoiceHandler,
    TextHandler,
    ReportHandler,
    SpokenReplyService,
    ReportWorkflowService,
    PracticeReplyWorkflowService,
    SettingsHandler,
    ScheduleHandler,
  ],
  exports: [TelegramService],
})
export class TelegramModule {}
