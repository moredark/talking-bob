import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { PaginatedResult, UpdateUserDto, UserDetail, UserListItem } from "./admin.contracts";
import { AdminAuditService } from "./admin-audit.service";
import { averageScore } from "./admin-service.utils";

type UserClient = Pick<Prisma.TransactionClient, "user">;

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async getUsers(page: number, limit: number): Promise<PaginatedResult<UserListItem>> {
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          userPrompts: { select: { id: true } },
          userResponses: { select: { id: true, analysis: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
        },
      }),
      this.prisma.user.count(),
    ]);
    return {
      data: users.map((user) => ({
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        createdAt: user.createdAt,
        dailyPromptEnabled: user.dailyPromptEnabled,
        promptsReceived: user.userPrompts.length,
        responsesCount: user.userResponses.length,
        averageScore: averageScore(user.userResponses.map((response) => response.analysis)),
        lastActivityAt: user.userResponses[0]?.createdAt ?? null,
      })),
      total, page, limit, totalPages: Math.ceil(total / limit),
    };
  }

  getUserById(id: string): Promise<UserDetail | null> {
    return this.getUserByIdFrom(this.prisma, id);
  }

  async updateUser(id: string, dto: UpdateUserDto): Promise<UserDetail | null> {
    const current = await this.prisma.user.findUnique({ where: { id } });
    if (!current) return null;
    if (!this.hasUserUpdateChanges(current, dto)) return this.getUserById(id);
    return this.audit.runSuccess({ action: "user.update", entityType: "user" }, async (tx) => {
      const before = await tx.user.findUniqueOrThrow({ where: { id } });
      if (!this.hasUserUpdateChanges(before, dto)) {
        const result = await this.getUserByIdFrom(tx, id);
        if (!result) throw new Error("User disappeared");
        return { result, entityId: id, skipAudit: true };
      }
      await tx.user.update({ where: { id }, data: this.userUpdateData(dto) });
      const result = await this.getUserByIdFrom(tx, id);
      if (!result) throw new Error("Updated user disappeared");
      const snapshots = this.changedUserUpdateSnapshots(before, result, dto);
      return {
        result,
        entityId: id,
        before: snapshots.before,
        after: snapshots.after,
      };
    });
  }

  async resetUserProgress(id: string): Promise<boolean> {
    if (!await this.prisma.user.findUnique({ where: { id } })) return false;
    return this.audit.runSuccess({ action: "user.reset_progress", entityType: "user" }, async (tx) => {
      const reportDeliveryRequests = await tx.reportDeliveryRequest.deleteMany({ where: { userResponse: { userId: id } } });
      await tx.aiProviderCall.deleteMany({ where: { userId: id } });
      const userActivityDays = await tx.userActivityDay.deleteMany({ where: { userId: id } });
      const conversationMessages = await tx.conversationMessage.deleteMany({ where: { userPrompt: { userId: id } } });
      const userResponses = await tx.userResponse.deleteMany({ where: { userId: id } });
      const userPrompts = await tx.userPrompt.deleteMany({ where: { userId: id } });
      await tx.user.update({ where: { id }, data: { lastUserMessageAt: null } });
      return {
        result: true,
        entityId: id,
        after: {
          reportDeliveryRequests: reportDeliveryRequests.count,
          userActivityDays: userActivityDays.count,
          conversationMessages: conversationMessages.count,
          userResponses: userResponses.count,
          userPrompts: userPrompts.count,
        },
      };
    });
  }

  private async getUserByIdFrom(client: UserClient, id: string): Promise<UserDetail | null> {
    const user = await client.user.findUnique({
      where: { id },
      select: {
        id: true, telegramId: true, username: true, createdAt: true,
        dailyPromptEnabled: true, dailyPromptHour: true, dailyPromptMinute: true,
        timezone: true, languageLevel: true, status: true,
        bannedAt: true, bannedReason: true,
        _count: { select: { userPrompts: true, userResponses: true } },
        userResponses: {
          select: { analysis: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        },
      },
    });
    if (!user) return null;
    return {
      id: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      createdAt: user.createdAt,
      dailyPromptEnabled: user.dailyPromptEnabled,
      dailyPromptHour: user.dailyPromptHour,
      dailyPromptMinute: user.dailyPromptMinute,
      timezone: user.timezone,
      languageLevel: user.languageLevel,
      status: user.status,
      bannedAt: user.bannedAt,
      bannedReason: user.bannedReason,
      promptsReceived: user._count.userPrompts,
      responsesCount: user._count.userResponses,
      averageScore: averageScore(user.userResponses.map((response) => response.analysis)),
    };
  }

  private userUpdateData(dto: UpdateUserDto): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (dto.dailyPromptEnabled !== undefined) data.dailyPromptEnabled = dto.dailyPromptEnabled;
    if (dto.languageLevel !== undefined) data.languageLevel = dto.languageLevel;
    if (dto.status !== undefined) {
      data.status = dto.status;
      data.bannedAt = dto.status === "banned" ? new Date() : null;
      data.bannedReason = dto.status === "banned" ? dto.bannedReason ?? null : null;
    }
    return data;
  }

  private hasUserUpdateChanges(
    user: { dailyPromptEnabled: boolean; languageLevel: string | null; status: string; bannedAt: Date | null; bannedReason: string | null },
    dto: UpdateUserDto,
  ): boolean {
    if (dto.dailyPromptEnabled !== undefined && dto.dailyPromptEnabled !== user.dailyPromptEnabled) return true;
    if (dto.languageLevel !== undefined && dto.languageLevel !== user.languageLevel) return true;
    if (dto.status === undefined) return false;
    if (dto.status !== user.status) return true;
    if (dto.status === "banned") {
      return user.bannedAt === null || (dto.bannedReason ?? null) !== user.bannedReason;
    }
    return user.bannedAt !== null || user.bannedReason !== null;
  }

  private changedUserUpdateSnapshots(
    before: { dailyPromptEnabled: boolean; languageLevel: string | null; status: string; bannedAt: Date | null; bannedReason: string | null },
    after: { dailyPromptEnabled: boolean; languageLevel: string | null; status: string; bannedAt: Date | null; bannedReason: string | null },
    dto: UpdateUserDto,
  ): { before: Record<string, unknown>; after: Record<string, unknown> } {
    const beforeSnapshot = this.userUpdateSnapshot(before, dto);
    const afterSnapshot = this.userUpdateSnapshot(after, dto);
    for (const key of Object.keys(beforeSnapshot)) {
      if (this.snapshotValue(beforeSnapshot[key]) === this.snapshotValue(afterSnapshot[key])) {
        delete beforeSnapshot[key];
        delete afterSnapshot[key];
      }
    }
    return { before: beforeSnapshot, after: afterSnapshot };
  }

  private snapshotValue(value: unknown): unknown {
    return value instanceof Date ? value.toISOString() : value;
  }

  private userUpdateSnapshot(user: { dailyPromptEnabled: boolean; languageLevel: string | null; status: string; bannedAt: Date | null; bannedReason: string | null }, dto: UpdateUserDto): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    if (dto.dailyPromptEnabled !== undefined) snapshot.dailyPromptEnabled = user.dailyPromptEnabled;
    if (dto.languageLevel !== undefined) snapshot.languageLevel = user.languageLevel;
    if (dto.status !== undefined) {
      snapshot.status = user.status;
      snapshot.bannedAt = user.bannedAt;
      snapshot.hasBannedReason = Boolean(user.bannedReason);
    }
    return snapshot;
  }
}
