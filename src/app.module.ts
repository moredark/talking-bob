import { DynamicModule, Module } from "@nestjs/common";
import { RuntimeConfigModule } from "./config/runtime-config.module";
import { RuntimeConfig } from "./config/runtime.config";
import { RuntimeSettingsBootstrap } from "./config/runtime-settings.service";
import { DatabaseModule } from "./infrastructure/database";
import { TelegramModule } from "./modules/telegram";
import { AuthModule } from "./modules/auth";
import { AdminModule } from "./modules/admin";
import { ErrorLogModule } from "./modules/error-log";
import { HealthModule } from "./modules/health";

@Module({
  imports: [
    DatabaseModule,
    ErrorLogModule,
    TelegramModule,
    HealthModule,
    AuthModule,
    AdminModule,
  ],
})
export class AppModule {
  static forRoot(runtimeConfig: RuntimeConfig, settings: RuntimeSettingsBootstrap): DynamicModule {
    return {
      module: AppModule,
      imports: [RuntimeConfigModule.forRoot(runtimeConfig, settings)],
    };
  }
}
