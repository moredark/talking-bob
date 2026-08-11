import {
  DynamicModule,
  Global,
  InjectionToken,
  Module,
} from "@nestjs/common";
import { RuntimeConfig } from "./runtime.config";
import { RUNTIME_SETTINGS_BOOTSTRAP, RuntimeSettingsBootstrap, RuntimeSettingsService } from "./runtime-settings.service";

export const RUNTIME_CONFIG: InjectionToken = Symbol("RUNTIME_CONFIG");

@Global()
@Module({})
export class RuntimeConfigModule {
  static forRoot(config: RuntimeConfig, settings: RuntimeSettingsBootstrap): DynamicModule {
    return {
      module: RuntimeConfigModule,
      global: true,
      providers: [
        { provide: RUNTIME_CONFIG, useValue: config },
        { provide: RUNTIME_SETTINGS_BOOTSTRAP, useValue: settings },
        RuntimeSettingsService,
      ],
      exports: [RUNTIME_CONFIG, RUNTIME_SETTINGS_BOOTSTRAP, RuntimeSettingsService],
    };
  }
}
