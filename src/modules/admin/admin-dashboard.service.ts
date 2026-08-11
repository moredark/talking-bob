import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database";
import { DashboardStats, TopicStats } from "./admin.contracts";
import { averageScore } from "./admin-service.utils";

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboardStats(): Promise<DashboardStats> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [totalUsers, usersWithDailyEnabled, totalPromptsSent, totalResponses, newUsersThisWeek, activeUserIds, analyzed] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { dailyPromptEnabled: true } }),
      this.prisma.userPrompt.count(),
      this.prisma.userResponse.count(),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.userResponse.findMany({ where: { createdAt: { gte: sevenDaysAgo } }, select: { userId: true }, distinct: ["userId"] }),
      this.prisma.userResponse.findMany({ where: { analysis: { not: null } }, select: { analysis: true } }),
    ]);
    return {
      totalUsers,
      activeUsers: activeUserIds.length,
      newUsersThisWeek,
      totalPromptsSent,
      totalResponses,
      responseRate: totalPromptsSent > 0 ? Math.round((totalResponses / totalPromptsSent) * 100) : 0,
      averageScore: averageScore(analyzed.map((item) => item.analysis)),
      usersWithDailyEnabled,
    };
  }

  async getTopicStats(): Promise<TopicStats[]> {
    const prompts = await this.prisma.prompt.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      include: { userPrompts: { include: { userResponse: { select: { id: true, analysis: true } } } } },
    });
    return prompts.map((prompt) => {
      const responses = prompt.userPrompts.flatMap((item) => item.userResponse ? [item.userResponse] : []);
      return {
        id: prompt.id,
        topic: prompt.topic,
        isActive: prompt.isActive,
        timesSent: prompt.userPrompts.length,
        responsesCount: responses.length,
        responseRate: prompt.userPrompts.length > 0 ? Math.round((responses.length / prompt.userPrompts.length) * 100) : 0,
        averageScore: averageScore(responses.map((item) => item.analysis)),
      };
    });
  }
}
