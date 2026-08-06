import { Module } from "@nestjs/common";
import { WHISPER_SERVICE, LLM_SERVICE } from "./interfaces";
import { WhisperService, LLMService } from "./services";

@Module({
  providers: [
    {
      provide: WHISPER_SERVICE,
      useClass: WhisperService,
    },
    {
      provide: LLM_SERVICE,
      useClass: LLMService,
    },
  ],
  exports: [WHISPER_SERVICE, LLM_SERVICE],
})
export class AiModule {}
