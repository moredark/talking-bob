import { Global, Module } from "@nestjs/common";
import { ErrorLogService } from "./error-log.service";
import { ObservabilityContextService } from "./observability-context.service";
import { DataRetentionService } from "./data-retention.service";

@Global()
@Module({
  providers: [ErrorLogService, ObservabilityContextService, DataRetentionService],
  exports: [ErrorLogService, ObservabilityContextService, DataRetentionService],
})
export class ErrorLogModule {}
