import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { StreakReminderDispatcher } from "./streak-reminder.dispatcher";
import { StreakReminderScheduler } from "./streak-reminder.scheduler";
import { StreakService } from "./streak.service";

@Module({
  imports: [DatabaseModule],
  providers: [StreakService, StreakReminderDispatcher, StreakReminderScheduler],
  exports: [StreakService, StreakReminderDispatcher],
})
export class StreakModule {}
