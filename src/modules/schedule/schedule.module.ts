import { Module, forwardRef } from "@nestjs/common";
import { ScheduleModule as NestScheduleModule } from "@nestjs/schedule";
import { DatabaseModule } from "../../infrastructure/database";
import { PromptModule } from "../prompt";
import { ScheduleService } from "./schedule.service";
import { SchedulerService } from "./scheduler.service";
import { DailyPromptDispatcher } from "./daily-prompt.dispatcher";
import { MESSAGE_DISPATCHER } from "./message-dispatcher.interface";

@Module({
  imports: [
    NestScheduleModule.forRoot(),
    DatabaseModule,
    PromptModule,
  ],
  providers: [
    ScheduleService,
    SchedulerService,
    DailyPromptDispatcher,
    {
      provide: MESSAGE_DISPATCHER,
      useExisting: DailyPromptDispatcher,
    },
  ],
  exports: [ScheduleService, DailyPromptDispatcher],
})
export class ScheduleModule {}
