import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { CreatePromptDto, PaginatedResult, PromptItem, UpdatePromptDto } from "./admin.contracts";
import { AdminAuditService } from "./admin-audit.service";

type PromptRecord = { id: string; topic: string; textContent: string | null; audioFileId: string | null; difficulty: string; tags: string[]; isActive: boolean; sortOrder: number; createdAt: Date; userPrompts?: Array<{ id: string }> };

@Injectable()
export class AdminPromptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  private mapPrompt(prompt: PromptRecord): PromptItem {
    return {
      id: prompt.id, topic: prompt.topic, textContent: prompt.textContent, audioFileId: prompt.audioFileId,
      difficulty: prompt.difficulty, tags: prompt.tags, isActive: prompt.isActive, sortOrder: prompt.sortOrder,
      createdAt: prompt.createdAt, timesSent: prompt.userPrompts?.length ?? 0,
    };
  }

  async getPrompts(page: number, limit: number): Promise<PaginatedResult<PromptItem>> {
    const [prompts, total] = await Promise.all([
      this.prisma.prompt.findMany({ skip: (page - 1) * limit, take: limit, orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "desc" }], include: { userPrompts: { select: { id: true } } } }),
      this.prisma.prompt.count(),
    ]);
    return { data: prompts.map((prompt) => this.mapPrompt(prompt)), total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getPromptById(id: string): Promise<PromptItem | null> {
    const prompt = await this.prisma.prompt.findUnique({ where: { id }, include: { userPrompts: { select: { id: true } } } });
    return prompt ? this.mapPrompt(prompt) : null;
  }

  async createPrompt(dto: CreatePromptDto): Promise<PromptItem> {
    return this.audit.runSuccess({ action: "prompt.create", entityType: "prompt" }, async (tx) => {
      const prompt = await tx.prompt.create({ data: this.createData(dto) });
      const result = this.mapPrompt(prompt);
      return { result, entityId: prompt.id, after: this.promptSnapshot(prompt) };
    });
  }

  async updatePrompt(id: string, dto: UpdatePromptDto): Promise<PromptItem | null> {
    if (!await this.prisma.prompt.findUnique({ where: { id } })) return null;
    return this.audit.runSuccess({ action: "prompt.update", entityType: "prompt" }, async (tx) => {
      const before = await tx.prompt.findUniqueOrThrow({ where: { id } });
      const prompt = await tx.prompt.update({ where: { id }, data: this.updateData(dto), include: { userPrompts: { select: { id: true } } } });
      return {
        result: this.mapPrompt(prompt),
        entityId: id,
        before: this.promptSnapshot(before, dto),
        after: this.promptSnapshot(prompt, dto),
      };
    });
  }

  async deletePrompt(id: string): Promise<boolean> {
    if (!await this.prisma.prompt.findUnique({ where: { id } })) return false;
    return this.audit.runSuccess({ action: "prompt.delete", entityType: "prompt" }, async (tx) => {
      const before = await tx.prompt.findUniqueOrThrow({ where: { id } });
      await tx.prompt.delete({ where: { id } });
      return { result: true, entityId: id, before: this.promptSnapshot(before) };
    });
  }

  private createData(dto: CreatePromptDto): Prisma.PromptCreateInput {
    return {
      topic: dto.topic,
      textContent: dto.textContent,
      audioFileId: dto.audioFileId?.trim() || null,
      difficulty: dto.difficulty ?? "medium",
      tags: dto.tags ?? [],
      isActive: dto.isActive ?? true,
      sortOrder: dto.sortOrder ?? 0,
    };
  }

  private updateData(dto: UpdatePromptDto): Prisma.PromptUpdateInput {
    return {
      topic: dto.topic,
      textContent: dto.textContent,
      audioFileId: dto.audioFileId === undefined ? undefined : dto.audioFileId?.trim() || null,
      difficulty: dto.difficulty,
      tags: dto.tags,
      isActive: dto.isActive,
      sortOrder: dto.sortOrder,
    };
  }

  private promptSnapshot(prompt: { difficulty: string; tags: string[]; isActive: boolean; sortOrder: number; textContent: string | null; audioFileId: string | null }, changed?: UpdatePromptDto): Record<string, unknown> {
    const include = (key: keyof UpdatePromptDto) => !changed || changed[key] !== undefined;
    const snapshot: Record<string, unknown> = {};
    if (include("difficulty")) snapshot.difficulty = prompt.difficulty;
    if (include("tags")) snapshot.tags = prompt.tags;
    if (include("isActive")) snapshot.isActive = prompt.isActive;
    if (include("sortOrder")) snapshot.sortOrder = prompt.sortOrder;
    if (include("textContent")) snapshot.hasTextContent = Boolean(prompt.textContent);
    if (include("audioFileId")) snapshot.hasAudioFileId = Boolean(prompt.audioFileId);
    return snapshot;
  }
}
