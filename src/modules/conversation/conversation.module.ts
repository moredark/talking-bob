import { Module } from "@nestjs/common";
import { StreakModule } from "../streak";
import { ConversationService } from "./conversation.service";

@Module({
  imports: [StreakModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
