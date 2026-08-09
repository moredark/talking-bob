import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database";
import {
  TelegramLifecycleState,
  TelegramService,
} from "../telegram/telegram.service";

type DatabaseHealth = "up" | "down";

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: DatabaseHealth;
    telegram: TelegramLifecycleState;
  };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  async getReadiness(): Promise<ReadinessResult> {
    let database: DatabaseHealth = "down";

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = "up";
    } catch {
      // Readiness exposes only the dependency state, never connection details.
    }

    // Read after the asynchronous DB probe so shutdown/restart transitions
    // cannot leave this request reporting a stale running state.
    const telegram = this.telegram.getLifecycleState();

    return {
      ready: database === "up" && telegram === "running",
      checks: { database, telegram },
    };
  }
}
