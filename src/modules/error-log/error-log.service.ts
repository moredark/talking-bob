import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export type ErrorType = "ai" | "telegram" | "system";
export type ErrorService =
  | "whisper"
  | "llm"
  | "tts"
  | "telegram"
  | "scheduler"
  | "general";

export interface LogErrorParams {
  type: ErrorType;
  service: ErrorService;
  message: string;
  stack?: string;
  metadata?: Record<string, unknown>;
  userId?: string;
}

@Injectable()
export class ErrorLogService {
  constructor(private prisma: PrismaService) {}

  async log(params: LogErrorParams): Promise<void> {
    try {
      await this.prisma.errorLog.create({
        data: {
          type: params.type,
          service: params.service,
          message: params.message,
          stack: params.stack,
          metadata: params.metadata
            ? JSON.parse(JSON.stringify(params.metadata))
            : undefined,
          userId: params.userId,
        },
      });
    } catch {
      console.error("Failed to log error to database:", params);
    }
  }

  async getLogs(options: {
    type?: ErrorType;
    service?: ErrorService;
    limit?: number;
    offset?: number;
  }) {
    const { type, service, limit = 50, offset = 0 } = options;

    const where: Record<string, string> = {};
    if (type) where.type = type;
    if (service) where.service = service;

    const [logs, total] = await Promise.all([
      this.prisma.errorLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.errorLog.count({ where }),
    ]);

    return { logs, total };
  }

  async getLogById(id: string) {
    return this.prisma.errorLog.findUnique({ where: { id } });
  }

  async clearOldLogs(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.prisma.errorLog.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
    });

    return result.count;
  }
}
