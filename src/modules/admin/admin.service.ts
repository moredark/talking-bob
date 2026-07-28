import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database";
import {
  ErrorLogService,
  ErrorType,
  ErrorService as ErrorServiceType,
} from "../error-log";

export interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  newUsersThisWeek: number;
  totalPromptsSent: number;
  totalResponses: number;
  responseRate: number;
  averageScore: number | null;
  usersWithDailyEnabled: number;
}

export interface UserListItem {
  id: string;
  telegramId: string;
  username: string | null;
  createdAt: Date;
  dailyPromptEnabled: boolean;
  promptsReceived: number;
  responsesCount: number;
  averageScore: number | null;
  lastActivityAt: Date | null;
}

export interface UserDetail {
  id: string;
  telegramId: string;
  username: string | null;
  createdAt: Date;
  dailyPromptEnabled: boolean;
  dailyPromptHour: number;
  dailyPromptMinute: number;
  timezone: string;
  promptsReceived: number;
  responsesCount: number;
  averageScore: number | null;
  responses: {
    id: string;
    promptTopic: string;
    transcript: string | null;
    overallScore: number | null;
    createdAt: Date;
  }[];
}

export interface TopicStats {
  id: string;
  topic: string;
  isActive: boolean;
  timesSent: number;
  responsesCount: number;
  responseRate: number;
  averageScore: number | null;
}

export interface PromptItem {
  id: string;
  topic: string;
  textContent: string | null;
  audioFileId: string | null;
  difficulty: string;
  tags: string[];
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  timesSent: number;
}

export interface CreatePromptDto {
  topic: string;
  textContent?: string;
  audioFileId?: string | null;
  difficulty?: string;
  tags?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdatePromptDto {
  topic?: string;
  textContent?: string;
  audioFileId?: string | null;
  difficulty?: string;
  tags?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateUserDto {
  dailyPromptEnabled?: boolean;
  languageLevel?: string | null;
  status?: string;
  bannedReason?: string;
}

export interface ErrorLogItem {
  id: string;
  type: string;
  service: string;
  message: string;
  stack: string | null;
  metadata: unknown;
  userId: string | null;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogService: ErrorLogService,
  ) {}

  async getDashboardStats(): Promise<DashboardStats> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      usersWithDailyEnabled,
      totalPromptsSent,
      totalResponses,
      newUsersThisWeek,
      activeUserIds,
      responsesWithAnalysis,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { dailyPromptEnabled: true } }),
      this.prisma.userPrompt.count(),
      this.prisma.userResponse.count(),
      this.prisma.user.count({
        where: { createdAt: { gte: sevenDaysAgo } },
      }),
      this.prisma.userResponse.findMany({
        where: { createdAt: { gte: sevenDaysAgo } },
        select: { userId: true },
        distinct: ["userId"],
      }),
      this.prisma.userResponse.findMany({
        where: { analysis: { not: null } },
        select: { analysis: true },
      }),
    ]);

    const scores = responsesWithAnalysis
      .map((r) => {
        try {
          const parsed = JSON.parse(r.analysis || "{}");
          return parsed.overallScore;
        } catch {
          return null;
        }
      })
      .filter((s): s is number => typeof s === "number");

    const averageScore =
      scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : null;

    const responseRate =
      totalPromptsSent > 0
        ? Math.round((totalResponses / totalPromptsSent) * 100)
        : 0;

    return {
      totalUsers,
      activeUsers: activeUserIds.length,
      newUsersThisWeek,
      totalPromptsSent,
      totalResponses,
      responseRate,
      averageScore,
      usersWithDailyEnabled,
    };
  }

  async getUsers(page: number, limit: number): Promise<PaginatedResult<UserListItem>> {
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          userPrompts: { select: { id: true } },
          userResponses: {
            select: { id: true, analysis: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
        },
      }),
      this.prisma.user.count(),
    ]);

    const data: UserListItem[] = users.map((user) => {
      const scores = user.userResponses
        .map((r) => {
          try {
            const parsed = JSON.parse(r.analysis || "{}");
            return parsed.overallScore;
          } catch {
            return null;
          }
        })
        .filter((s): s is number => typeof s === "number");

      const averageScore =
        scores.length > 0
          ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
          : null;

      const lastActivityAt =
        user.userResponses.length > 0 ? user.userResponses[0].createdAt : null;

      return {
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        createdAt: user.createdAt,
        dailyPromptEnabled: user.dailyPromptEnabled,
        promptsReceived: user.userPrompts.length,
        responsesCount: user.userResponses.length,
        averageScore,
        lastActivityAt,
      };
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserById(id: string): Promise<UserDetail | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        userPrompts: { select: { id: true } },
        userResponses: {
          include: {
            userPrompt: {
              include: {
                prompt: { select: { topic: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!user) {
      return null;
    }

    const scores = user.userResponses
      .map((r) => {
        try {
          const parsed = JSON.parse(r.analysis || "{}");
          return parsed.overallScore;
        } catch {
          return null;
        }
      })
      .filter((s): s is number => typeof s === "number");

    const averageScore =
      scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : null;

    const responses = user.userResponses.map((r) => {
      let overallScore: number | null = null;
      try {
        const parsed = JSON.parse(r.analysis || "{}");
        overallScore = parsed.overallScore ?? null;
      } catch {
        // ignore
      }

      return {
        id: r.id,
        promptTopic: r.userPrompt.prompt.topic,
        transcript: r.transcript,
        overallScore,
        createdAt: r.createdAt,
      };
    });

    return {
      id: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      createdAt: user.createdAt,
      dailyPromptEnabled: user.dailyPromptEnabled,
      dailyPromptHour: user.dailyPromptHour,
      dailyPromptMinute: user.dailyPromptMinute,
      timezone: user.timezone,
      promptsReceived: user.userPrompts.length,
      responsesCount: user.userResponses.length,
      averageScore,
      responses,
    };
  }

  async getTopicStats(): Promise<TopicStats[]> {
    const prompts = await this.prisma.prompt.findMany({
      include: {
        userPrompts: {
          include: {
            userResponse: {
              select: { id: true, analysis: true },
            },
          },
        },
      },
    });

    return prompts.map((prompt) => {
      const timesSent = prompt.userPrompts.length;
      const responsesWithData = prompt.userPrompts
        .filter((up) => up.userResponse)
        .map((up) => up.userResponse!);

      const responsesCount = responsesWithData.length;
      const responseRate = timesSent > 0 ? Math.round((responsesCount / timesSent) * 100) : 0;

      const scores = responsesWithData
        .map((r) => {
          try {
            const parsed = JSON.parse(r.analysis || "{}");
            return parsed.overallScore;
          } catch {
            return null;
          }
        })
        .filter((s): s is number => typeof s === "number");

      const averageScore =
        scores.length > 0
          ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
          : null;

      return {
        id: prompt.id,
        topic: prompt.topic,
        isActive: prompt.isActive,
        timesSent,
        responsesCount,
        responseRate,
        averageScore,
      };
    });
  }

  // ============ PROMPT CRUD ============

  async getPrompts(
    page: number,
    limit: number,
  ): Promise<PaginatedResult<PromptItem>> {
    const skip = (page - 1) * limit;

    const [prompts, total] = await Promise.all([
      this.prisma.prompt.findMany({
        skip,
        take: limit,
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
        include: {
          userPrompts: { select: { id: true } },
        },
      }),
      this.prisma.prompt.count(),
    ]);

    const data: PromptItem[] = prompts.map((p) => ({
      id: p.id,
      topic: p.topic,
      textContent: p.textContent,
      audioFileId: p.audioFileId,
      difficulty: p.difficulty,
      tags: p.tags,
      isActive: p.isActive,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      timesSent: p.userPrompts.length,
    }));

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getPromptById(id: string): Promise<PromptItem | null> {
    const prompt = await this.prisma.prompt.findUnique({
      where: { id },
      include: {
        userPrompts: { select: { id: true } },
      },
    });

    if (!prompt) return null;

    return {
      id: prompt.id,
      topic: prompt.topic,
      textContent: prompt.textContent,
      audioFileId: prompt.audioFileId,
      difficulty: prompt.difficulty,
      tags: prompt.tags,
      isActive: prompt.isActive,
      sortOrder: prompt.sortOrder,
      createdAt: prompt.createdAt,
      timesSent: prompt.userPrompts.length,
    };
  }

  async createPrompt(dto: CreatePromptDto): Promise<PromptItem> {
    const prompt = await this.prisma.prompt.create({
      data: {
        topic: dto.topic,
        textContent: dto.textContent,
        audioFileId: dto.audioFileId?.trim() || null,
        difficulty: dto.difficulty ?? "medium",
        tags: dto.tags ?? [],
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    return {
      id: prompt.id,
      topic: prompt.topic,
      textContent: prompt.textContent,
      audioFileId: prompt.audioFileId,
      difficulty: prompt.difficulty,
      tags: prompt.tags,
      isActive: prompt.isActive,
      sortOrder: prompt.sortOrder,
      createdAt: prompt.createdAt,
      timesSent: 0,
    };
  }

  async updatePrompt(id: string, dto: UpdatePromptDto): Promise<PromptItem | null> {
    const existing = await this.prisma.prompt.findUnique({ where: { id } });
    if (!existing) return null;

    const prompt = await this.prisma.prompt.update({
      where: { id },
      data: {
        topic: dto.topic,
        textContent: dto.textContent,
        audioFileId:
          dto.audioFileId === undefined
            ? undefined
            : dto.audioFileId?.trim() || null,
        difficulty: dto.difficulty,
        tags: dto.tags,
        isActive: dto.isActive,
        sortOrder: dto.sortOrder,
      },
      include: {
        userPrompts: { select: { id: true } },
      },
    });

    return {
      id: prompt.id,
      topic: prompt.topic,
      textContent: prompt.textContent,
      audioFileId: prompt.audioFileId,
      difficulty: prompt.difficulty,
      tags: prompt.tags,
      isActive: prompt.isActive,
      sortOrder: prompt.sortOrder,
      createdAt: prompt.createdAt,
      timesSent: prompt.userPrompts.length,
    };
  }

  async deletePrompt(id: string): Promise<boolean> {
    const existing = await this.prisma.prompt.findUnique({ where: { id } });
    if (!existing) return false;

    await this.prisma.prompt.delete({ where: { id } });
    return true;
  }

  // ============ USER ACTIONS ============

  async updateUser(id: string, dto: UpdateUserDto): Promise<UserDetail | null> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) return null;

    const updateData: Record<string, unknown> = {};

    if (dto.dailyPromptEnabled !== undefined) {
      updateData.dailyPromptEnabled = dto.dailyPromptEnabled;
    }

    if (dto.languageLevel !== undefined) {
      updateData.languageLevel = dto.languageLevel;
    }

    if (dto.status !== undefined) {
      updateData.status = dto.status;
      if (dto.status === "banned") {
        updateData.bannedAt = new Date();
        updateData.bannedReason = dto.bannedReason ?? null;
      } else if (dto.status === "active") {
        updateData.bannedAt = null;
        updateData.bannedReason = null;
      }
    }

    await this.prisma.user.update({
      where: { id },
      data: updateData,
    });

    return this.getUserById(id);
  }

  async resetUserProgress(id: string): Promise<boolean> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) return false;

    await this.prisma.$transaction([
      this.prisma.conversationMessage.deleteMany({
        where: { userPrompt: { userId: id } },
      }),
      this.prisma.userResponse.deleteMany({ where: { userId: id } }),
      this.prisma.userPrompt.deleteMany({ where: { userId: id } }),
    ]);

    return true;
  }

  // ============ ERROR LOGS ============

  async getErrorLogs(
    page: number,
    limit: number,
    type?: ErrorType,
    service?: ErrorServiceType,
  ): Promise<PaginatedResult<ErrorLogItem>> {
    const result = await this.errorLogService.getLogs({
      type,
      service,
      limit,
      offset: (page - 1) * limit,
    });

    return {
      data: result.logs.map((log) => ({
        id: log.id,
        type: log.type,
        service: log.service,
        message: log.message,
        stack: log.stack,
        metadata: log.metadata,
        userId: log.userId,
        createdAt: log.createdAt,
      })),
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    };
  }

  async getErrorLogById(id: string): Promise<ErrorLogItem | null> {
    const log = await this.errorLogService.getLogById(id);
    if (!log) return null;

    return {
      id: log.id,
      type: log.type,
      service: log.service,
      message: log.message,
      stack: log.stack,
      metadata: log.metadata,
      userId: log.userId,
      createdAt: log.createdAt,
    };
  }

  async clearOldErrorLogs(daysOld: number = 30): Promise<number> {
    return this.errorLogService.clearOldLogs(daysOld);
  }
}
