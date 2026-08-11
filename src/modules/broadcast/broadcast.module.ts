import { Module } from "@nestjs/common";
import { BroadcastDispatcher } from "./broadcast-dispatcher.service";

@Module({
  providers: [BroadcastDispatcher],
  exports: [BroadcastDispatcher],
})
export class BroadcastModule {}
