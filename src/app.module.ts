import { Module } from "@nestjs/common";
import { DatabaseModule } from "./infrastructure/database";
import { TelegramModule } from "./modules/telegram";

@Module({
  imports: [DatabaseModule, TelegramModule],
})
export class AppModule {}
