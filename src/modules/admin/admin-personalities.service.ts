import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { AgentPersonality, Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { AdminAuditService } from "./admin-audit.service";
import {
  AgentPersonalityItem,
  AgentPromptRulesItem,
  CreatePersonalityDto,
  UpdatePersonalityDto,
  UpdateAgentPromptRulesDto,
} from "./admin.contracts";

type PersonalityWithCount = AgentPersonality & { _count: { users: number } };

@Injectable()
export class AdminPersonalitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(): Promise<AgentPersonalityItem[]> {
    const rows = await this.prisma.agentPersonality.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      include: { _count: { select: { users: true } } },
    });
    return rows.map((row) => this.item(row));
  }

  async getRules(): Promise<AgentPromptRulesItem> {
    const rules = await this.prisma.agentPromptRules.findUnique({ where: { id: "default" } });
    if (!rules) throw new ConflictException("Shared prompt rules are missing");
    return rules;
  }

  updateRules(dto: UpdateAgentPromptRulesDto): Promise<AgentPromptRulesItem> {
    return this.audit.runSuccess(
      { action: "personality.rules.update", entityType: "personality" },
      async (tx) => {
        const before = await tx.agentPromptRules.findUnique({ where: { id: "default" } });
        if (!before) throw new ConflictException("Shared prompt rules are missing");
        const rules = await tx.agentPromptRules.update({ where: { id: "default" }, data: dto });
        const changedFields = Object.keys(dto).filter((key) => (before as any)[key] !== (rules as any)[key]);
        return {
          result: rules,
          entityId: "default",
          before: { changedFields },
          after: { changedFields },
        };
      },
    );
  }

  create(dto: CreatePersonalityDto): Promise<AgentPersonalityItem> {
    return this.audit.runSuccess(
      { action: "personality.create", entityType: "personality" },
      async (tx) => {
        await this.lock(tx);
        if ((dto.isActive ?? true) && await tx.agentPersonality.count({ where: { isActive: true } }) >= 20) {
          throw new ConflictException("Active personality limit reached");
        }
        const row = await tx.agentPersonality.create({
          data: { ...dto, description: dto.description ?? "", isActive: dto.isActive ?? true, sortOrder: dto.sortOrder ?? 0, isDefault: false },
          include: { _count: { select: { users: true } } },
        });
        return { result: this.item(row), entityId: row.id, after: this.snapshot(row, ["key", "isActive", "isDefault", "sortOrder"]) };
      },
    );
  }

  update(id: string, dto: UpdatePersonalityDto): Promise<AgentPersonalityItem> {
    return this.audit.runSuccess(
      { action: "personality.update", entityType: "personality" },
      async (tx) => {
        const before = await tx.agentPersonality.findUnique({ where: { id } });
        if (!before) throw new NotFoundException("Personality not found");
        const row = await tx.agentPersonality.update({ where: { id }, data: dto, include: { _count: { select: { users: true } } } });
        const changedFields = Object.keys(dto).filter((key) => (before as any)[key] !== (row as any)[key]);
        return { result: this.item(row), entityId: id, before: this.snapshot(before, changedFields), after: this.snapshot(row, changedFields) };
      },
    );
  }

  activate(id: string): Promise<AgentPersonalityItem> {
    return this.audit.runSuccess(
      { action: "personality.activate", entityType: "personality" },
      async (tx) => {
        await this.lock(tx);
        const before = await tx.agentPersonality.findUnique({ where: { id } });
        if (!before) throw new NotFoundException("Personality not found");
        if (!before.isActive && await tx.agentPersonality.count({ where: { isActive: true } }) >= 20) throw new ConflictException("Active personality limit reached");
        if (!before.isActive) await tx.agentPersonality.update({ where: { id }, data: { isActive: true } });
        const row = await this.withCount(tx, id);
        return { result: this.item(row), entityId: id, before: this.snapshot(before), after: this.snapshot(row) };
      },
    );
  }

  deactivate(id: string): Promise<AgentPersonalityItem> {
    return this.audit.runSuccess(
      { action: "personality.deactivate", entityType: "personality" },
      async (tx) => {
        await this.lock(tx);
        const before = await tx.agentPersonality.findUnique({ where: { id } });
        if (!before) throw new NotFoundException("Personality not found");
        if (before.isDefault) throw new UnprocessableEntityException("Default personality cannot be deactivated");
        const fallback = await tx.agentPersonality.findFirst({ where: { isDefault: true, isActive: true } });
        if (!fallback) throw new ConflictException("Active default personality is missing");
        const reassigned = await tx.user.updateMany({ where: { agentTone: before.key }, data: { agentTone: fallback.key } });
        if (before.isActive) await tx.agentPersonality.update({ where: { id }, data: { isActive: false } });
        const row = await this.withCount(tx, id);
        return { result: this.item(row), entityId: id, before: this.snapshot(before), after: { ...this.snapshot(row), reassignedUserCount: reassigned.count } };
      },
    );
  }

  setDefault(id: string): Promise<AgentPersonalityItem> {
    return this.audit.runSuccess(
      { action: "personality.set_default", entityType: "personality" },
      async (tx) => {
        await this.lock(tx);
        const target = await tx.agentPersonality.findUnique({ where: { id } });
        if (!target) throw new NotFoundException("Personality not found");
        if (!target.isActive && await tx.agentPersonality.count({ where: { isActive: true } }) >= 20) throw new ConflictException("Active personality limit reached");
        await tx.agentPersonality.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
        await tx.agentPersonality.update({ where: { id }, data: { isActive: true, isDefault: true } });
        const row = await this.withCount(tx, id);
        return { result: this.item(row), entityId: id, before: this.snapshot(target), after: this.snapshot(row) };
      },
    );
  }

  private withCount(tx: Prisma.TransactionClient, id: string): Promise<PersonalityWithCount> {
    return tx.agentPersonality.findUniqueOrThrow({ where: { id }, include: { _count: { select: { users: true } } } });
  }

  private async lock(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "agent_personalities" ORDER BY "id" FOR UPDATE`;
  }

  private item(row: PersonalityWithCount): AgentPersonalityItem {
    const { _count, ...personality } = row;
    return { ...personality, selectedUsersCount: _count.users };
  }

  private snapshot(row: { key: string; isActive: boolean; isDefault: boolean; sortOrder: number }, changedFields?: string[]): Record<string, unknown> {
    return { key: row.key, isActive: row.isActive, isDefault: row.isDefault, sortOrder: row.sortOrder, ...(changedFields ? { changedFields: changedFields.filter((key) => ["name", "description", "followUpStylePrompt", "analysisStylePrompt", "sortOrder"].includes(key)) } : {}) };
  }
}
