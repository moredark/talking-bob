import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from "@nestjs/common";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("live")
  @Header("Cache-Control", "no-store")
  getLiveness() {
    return { status: "ok" as const };
  }

  @Get("ready")
  @Header("Cache-Control", "no-store")
  async getReadiness() {
    const readiness = await this.healthService.getReadiness();
    if (!readiness.ready) {
      throw new ServiceUnavailableException({
        status: "not_ready",
        checks: readiness.checks,
      });
    }

    return {
      status: "ready" as const,
      checks: readiness.checks,
    };
  }
}
