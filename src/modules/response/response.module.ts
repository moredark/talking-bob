import { Module } from "@nestjs/common";
import { StreakModule } from "../streak";
import { ResponseService } from "./response.service";

@Module({
  imports: [StreakModule],
  providers: [ResponseService],
  exports: [ResponseService],
})
export class ResponseModule {}
