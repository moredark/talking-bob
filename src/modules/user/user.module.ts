import { Module } from "@nestjs/common";
import { PersonalityModule } from "../personality";
import { UserService } from "./user.service";

@Module({
  imports: [PersonalityModule],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
