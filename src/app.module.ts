import { Module } from "@nestjs/common";
import { DatabaseModule } from "./infrastructure/database";
import { TelegramModule } from "./modules/telegram";
import { AuthModule } from "./modules/auth";
import { AdminModule } from "./modules/admin";
import { ErrorLogModule } from "./modules/error-log";

@Module({
  imports: [
    DatabaseModule,
    ErrorLogModule,
    TelegramModule,
    AuthModule,
    AdminModule,
  ],
})
export class AppModule {}
