import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database";
import { Prisma } from "@prisma/client";
import { composeSystemPrompt } from "../../config/llm-system-prompts";

export interface AgentPersonalityPrompt {
  key: string;
  followUpPrompt: string;
  analysisPrompt: string;
}
export interface ActiveAgentPersonality {
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
}

@Injectable()
export class PersonalityService {
  constructor(private readonly prisma: PrismaService) {}

  listActive(): Promise<ActiveAgentPersonality[]> {
    return this.prisma.agentPersonality.findMany({
      where: { isActive: true }, take: 20,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { key: true, name: true, description: true, isDefault: true },
    });
  }

  async resolveSelectedOrDefault(key?: string | null): Promise<AgentPersonalityPrompt> {
    const [rules, selected] = await Promise.all([
      this.prisma.agentPromptRules.findUnique({ where: { id: "default" }, select: { followUpPrompt: true, analysisPrompt: true } }),
      key ? this.prisma.agentPersonality.findUnique({ where: { key }, select: { key: true, followUpStylePrompt: true, analysisStylePrompt: true, isActive: true } }) : null,
    ]);
    if (!rules) throw new Error("Shared agent prompt rules are missing");
    const personality = selected?.isActive
      ? selected
      : await this.prisma.agentPersonality.findFirst({ where: { isDefault: true, isActive: true }, select: { key: true, followUpStylePrompt: true, analysisStylePrompt: true } });
    if (!personality) throw new Error("Active default personality is missing");
    return {
      key: personality.key,
      followUpPrompt: composeSystemPrompt(rules.followUpPrompt, personality.followUpStylePrompt),
      analysisPrompt: composeSystemPrompt(rules.analysisPrompt, personality.analysisStylePrompt),
    };
  }

  async selectForUser(userId: string, key: string) {
    if (typeof (this.prisma as any).$transaction !== "function") {
      const personality = await this.prisma.agentPersonality.findUnique({ where: { key }, select: { isActive: true } });
      if (!personality?.isActive) throw new UnprocessableEntityException("Personality is unavailable");
      return this.prisma.user.update({ where: { id: userId }, data: { agentTone: key } });
    }
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ isActive: boolean }>>(Prisma.sql`SELECT "isActive" FROM "agent_personalities" WHERE "key" = ${key} FOR UPDATE`);
      if (!rows[0]?.isActive) throw new UnprocessableEntityException("Personality is unavailable");
      return tx.user.update({ where: { id: userId }, data: { agentTone: key } });
    });
  }
}
