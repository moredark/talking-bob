import { Module } from "@nestjs/common";
import { RUNTIME_CONFIG } from "../../config/runtime-config.module";
import { RuntimeConfig } from "../../config/runtime.config";
import { WHISPER_SERVICE, LLM_SERVICE } from "./interfaces";
import {
  AI_REQUEST_CONCURRENCY,
  AI_REQUEST_MAX_PENDING,
  AiRequestLimiterService,
  WhisperService,
  LLMService,
} from "./services";

@Module({
  providers: [
    {
      provide: AI_REQUEST_CONCURRENCY,
      inject: [RUNTIME_CONFIG],
      useFactory: (config: RuntimeConfig) => config.concurrency.aiRequests,
    },
    {
      provide: AI_REQUEST_MAX_PENDING,
      inject: [RUNTIME_CONFIG],
      useFactory: (config: RuntimeConfig) =>
        config.concurrency.aiRequestMaxPending,
    },
    AiRequestLimiterService,
    {
      provide: WHISPER_SERVICE,
      useClass: WhisperService,
    },
    {
      provide: LLM_SERVICE,
      useClass: LLMService,
    },
  ],
  exports: [WHISPER_SERVICE, LLM_SERVICE, AiRequestLimiterService],
})
export class AiModule {}
