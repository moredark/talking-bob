import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Broadcast, BroadcastRecipient, Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import {
  BroadcastDetail,
  BroadcastDetailQuery,
  BroadcastFilters,
  BroadcastInputDto,
  BroadcastListItem,
  BroadcastListQuery,
  BroadcastPreview,
  BroadcastRecipientItem,
  Paginated,
  broadcastAudienceWhere,
  broadcastSnapshotInsert,
  normalizeBroadcastFilters,
} from "../broadcast";
import { AdminAuditContextService } from "./admin-audit-context.service";
import { AdminAuditService } from "./admin-audit.service";

type RecipientRow = BroadcastRecipient;

@Injectable()
export class AdminBroadcastsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly auditContext: AdminAuditContextService,
  ) {}

  async preview(input: BroadcastInputDto, now = new Date()): Promise<BroadcastPreview> {
    const audienceCount = await this.prisma.user.count({
      where: broadcastAudienceWhere(input.filters, now),
    });
    return { normalized: this.normalized(input), audienceCount };
  }

  async create(input: BroadcastInputDto, now = new Date()): Promise<BroadcastDetail> {
    return this.audit.runSuccess(
      { action: "broadcast.create", entityType: "broadcast" },
      async (tx) => {
        const actor = this.auditContext.current() ?? this.auditContext.fallback();
        const broadcast = await tx.broadcast.create({
          data: {
            content: input.content,
            filters: input.filters as unknown as Prisma.InputJsonObject,
            mode: input.mode,
            scheduledForLocal: input.scheduledFor,
            scheduledAt: input.scheduledAt,
            status: "queued",
            createdById: actor.actorId,
            createdByUsername: actor.actorUsername,
          },
        });
        const audienceCount = await tx.$executeRaw(broadcastSnapshotInsert(broadcast.id, input.filters, now));
        await tx.broadcast.update({
          where: { id: broadcast.id },
          data: { totalRecipients: audienceCount },
        });
        const detail = await this.detailInTransaction(tx, broadcast.id, {
          recipientPage: 1,
          recipientLimit: 50,
        });
        return {
          result: detail!,
          entityId: broadcast.id,
          before: null,
          after: this.auditSnapshot(broadcast, input.filters, audienceCount),
        };
      },
    );
  }

  async list(query: BroadcastListQuery): Promise<Paginated<BroadcastListItem>> {
    const where: Prisma.BroadcastWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lt: query.to } : {}),
      };
    }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.broadcast.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.broadcast.count({ where }),
    ]);
    return {
      data: rows.map((row) => this.listItem(row)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async detail(id: string, query: BroadcastDetailQuery): Promise<BroadcastDetail | null> {
    return this.prisma.$transaction((tx) => this.detailInTransaction(tx, id, query));
  }

  async cancel(id: string): Promise<BroadcastDetail> {
    return this.audit.runSuccess(
      { action: "broadcast.cancel", entityType: "broadcast" },
      async (tx) => {
        const current = await tx.broadcast.findUnique({ where: { id } });
        if (!current) throw new NotFoundException("Broadcast not found");
        if (current.status !== "queued") throw new ConflictException("Only queued broadcasts can be cancelled");
        const now = new Date();
        const claimed = await tx.broadcast.updateMany({
          where: { id, status: "queued" },
          data: { status: "processing" },
        });
        if (claimed.count !== 1) {
          throw new ConflictException("Only queued broadcasts can be cancelled");
        }
        await tx.broadcastRecipient.updateMany({
          where: { broadcastId: id, status: "pending" },
          data: {
            status: "skipped",
            claimToken: null,
            claimExpiresAt: null,
            nextAttemptAt: null,
            lastErrorCode: "broadcast_cancelled",
            lastErrorAt: now,
          },
        });
        const updated = await tx.broadcast.update({
          where: { id, status: "processing" },
          data: {
            status: "cancelled",
            skippedCount: current.totalRecipients,
            terminalAt: now,
          },
        });
        const detail = await this.detailInTransaction(tx, id, {
          recipientPage: 1,
          recipientLimit: 50,
        });
        return {
          result: detail!,
          entityId: id,
          before: { status: current.status },
          after: { status: updated.status, counts: this.counts(updated) },
        };
      },
    );
  }

  private async detailInTransaction(
    tx: Prisma.TransactionClient,
    id: string,
    query: BroadcastDetailQuery,
  ): Promise<BroadcastDetail | null> {
    const row = await tx.broadcast.findUnique({ where: { id } });
    if (!row) return null;
    const where: Prisma.BroadcastRecipientWhereInput = {
      broadcastId: id,
      ...(query.recipientStatus ? { status: query.recipientStatus } : {}),
    };
    const [recipients, total] = await Promise.all([
      tx.broadcastRecipient.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: (query.recipientPage - 1) * query.recipientLimit,
        take: query.recipientLimit,
      }),
      tx.broadcastRecipient.count({ where }),
    ]);
    return {
      ...this.listItem(row),
      recipients: {
        data: recipients.map((recipient) => this.recipientItem(recipient)),
        total,
        page: query.recipientPage,
        limit: query.recipientLimit,
        totalPages: Math.ceil(total / query.recipientLimit),
      },
    };
  }

  private normalized(input: BroadcastInputDto): BroadcastPreview["normalized"] {
    return {
      content: input.content,
      filters: input.filters,
      mode: input.mode,
      scheduledFor: input.scheduledFor,
      scheduledAt: input.scheduledAt,
    };
  }

  private listItem(row: Broadcast): BroadcastListItem {
    return {
      id: row.id,
      content: row.content,
      contentPurged: row.contentPurgedAt !== null,
      filters: normalizeBroadcastFilters(row.filters),
      mode: row.mode,
      scheduledFor: row.scheduledForLocal,
      scheduledAt: row.scheduledAt,
      status: row.status,
      counts: this.counts(row),
      createdBy: { id: row.createdById, username: row.createdByUsername },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      terminalAt: row.terminalAt,
    };
  }

  private recipientItem(row: RecipientRow): BroadcastRecipientItem {
    return {
      id: row.id,
      user: {
        id: row.userId,
        telegramId: row.telegramIdSnapshot.toString(),
        username: row.usernameSnapshot,
        languageLevel: row.languageLevelSnapshot,
        dailyPromptEnabled: row.dailyPromptEnabledSnapshot,
        announcementEnabled: row.announcementEnabledSnapshot,
      },
      status: row.status,
      attemptCount: row.attemptCount,
      nextAttemptAt: row.nextAttemptAt,
      deliveryAttemptedAt: row.deliveryAttemptedAt,
      sentAt: row.sentAt,
      lastErrorCode: row.lastErrorCode,
      lastErrorAt: row.lastErrorAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private counts(row: Broadcast) {
    const terminal = row.sentCount + row.failedCount + row.ambiguousCount + row.skippedCount;
    return {
      total: row.totalRecipients,
      pending: Math.max(0, row.totalRecipients - terminal),
      sent: row.sentCount,
      failed: row.failedCount,
      ambiguous: row.ambiguousCount,
      skipped: row.skippedCount,
    };
  }

  private auditSnapshot(row: Broadcast, filters: BroadcastFilters, audienceCount: number) {
    return {
      mode: row.mode,
      scheduledAt: row.scheduledAt,
      filters,
      audienceCount,
      status: row.status,
    };
  }
}
