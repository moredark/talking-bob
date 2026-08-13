import { Module } from "@nestjs/common";
import { PersonalityService } from "./personality.service";
@Module({ providers: [PersonalityService], exports: [PersonalityService] })
export class PersonalityModule {}
