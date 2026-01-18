import { Module } from "@nestjs/common";
import {
  WHISPER_SERVICE,
  LLM_SERVICE,
  TTS_SERVICE,
} from "./interfaces";
import { WhisperService, LLMService, TTSService } from "./services";

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
    {
      provide: TTS_SERVICE,
      useClass: TTSService,
    },
  ],
  exports: [WHISPER_SERVICE, LLM_SERVICE, TTS_SERVICE],
})
export class AiModule {}
