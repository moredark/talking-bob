import { Module } from "@nestjs/common";
import { TelegramModule } from "../telegram";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [TelegramModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
