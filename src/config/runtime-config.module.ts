import {
  DynamicModule,
  Global,
  InjectionToken,
  Module,
} from "@nestjs/common";
import { RuntimeConfig } from "./runtime.config";

export const RUNTIME_CONFIG: InjectionToken = Symbol("RUNTIME_CONFIG");

@Global()
@Module({})
export class RuntimeConfigModule {
  static forRoot(config: RuntimeConfig): DynamicModule {
    return {
      module: RuntimeConfigModule,
      global: true,
      providers: [{ provide: RUNTIME_CONFIG, useValue: config }],
      exports: [RUNTIME_CONFIG],
    };
  }
}
