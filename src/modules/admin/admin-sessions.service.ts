import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";
import { AdminSessionDetail, AdminSessionListItem, AdminSessionsQuery, PaginatedResult } from "./admin.contracts";

@Injectable()
export class AdminSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSessions(query: AdminSessionsQuery): Promise<PaginatedResult<AdminSessionListItem>> {
    const where: Prisma.UserPromptWhereInput = {};
    if (query.userId) where.userId = query.userId;
    if (query.topic) where.prompt = { topic: { contains: query.topic, mode: "insensitive" } };
    if (query.source) where.source = query.source;
    if (query.deliveryStatus) where.deliveryStatus = query.deliveryStatus;
    if (query.conversationStatus) where.conversationStatus = query.conversationStatus;
    if (query.generationStatus) where.userResponse = { is: { generationStatus: query.generationStatus } };
    if (query.from || query.to) where.createdAt = { gte: query.from, lt: query.to };

    const [sessions, total] = await Promise.all([
      this.prisma.userPrompt.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true, source: true, deliveryStatus: true, conversationStatus: true,
          createdAt: true, sentAt: true, conversationClosedAt: true, contentPurgedAt: true, aiTracePurgedAt: true,
          user: { select: { id: true, telegramId: true, username: true } },
          prompt: { select: { id: true, topic: true } },
          userResponse: { select: { generationStatus: true, generatedAt: true } },
          _count: { select: { conversationMessages: true } },
        },
      }),
      this.prisma.userPrompt.count({ where }),
    ]);

    return {
      data: sessions.map((session) => this.listItem(session)),
      total, page: query.page, limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async getSessionById(id: string): Promise<AdminSessionDetail | null> {
    const session = await this.prisma.userPrompt.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, telegramId: true, username: true } },
        prompt: { select: { id: true, topic: true } },
        conversationMessages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        userResponse: {
          include: {
            reportDeliveryRequests: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          },
        },
        aiProviderCalls: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        _count: { select: { conversationMessages: true } },
      },
    });
    if (!session) return null;
    const list = this.listItem(session);
    const response = session.userResponse;
    return {
      ...list,
      contentPurgedAt: session.contentPurgedAt,
      aiTracePurgedAt: session.aiTracePurgedAt,
      delivery: {
        scheduledFor: session.scheduledFor,
        deliveryAttemptedAt: session.deliveryAttemptedAt,
        lastErrorCode: session.lastDeliveryErrorCode,
        lastErrorAt: session.lastDeliveryErrorAt,
      },
      messages: session.conversationMessages.map((message) => ({
        id: message.id, role: message.role,
        content: session.contentPurgedAt ? null : message.content,
        voiceFileId: session.contentPurgedAt ? null : message.voiceFileId,
        createdAt: message.createdAt,
      })),
      response: response ? {
        id: response.id,
        transcript: response.transcript,
        analysis: this.analysis(response.analysis, response.analysisKind, response.analysisVersion),
        generationStatus: response.generationStatus,
        generationAttemptedAt: response.generationAttemptedAt,
        generatedAt: response.generatedAt,
        lastErrorCode: response.lastGenerationErrorCode,
        lastErrorAt: response.lastGenerationErrorAt,
        sensitiveDataPurgedAt: response.sensitiveDataPurgedAt,
        createdAt: response.createdAt,
      } : null,
      reportDeliveries: (response?.reportDeliveryRequests ?? []).map((request) => ({
        id: request.id, status: request.status, nextChunkIndex: request.nextChunkIndex,
        deliveryAttemptedAt: request.deliveryAttemptedAt, deliveredAt: request.deliveredAt,
        lastErrorCode: request.lastDeliveryErrorCode, lastErrorAt: request.lastDeliveryErrorAt,
        createdAt: request.createdAt, updatedAt: request.updatedAt,
      })),
      providerCalls: session.aiProviderCalls.map((call) => ({
        id: call.id, operation: call.operation, provider: call.provider, model: call.model,
        attempt: call.attempt, outcome: call.outcome, statusCode: call.statusCode,
        latencyMs: call.latencyMs, inputTokens: call.inputTokens, outputTokens: call.outputTokens,
        totalTokens: call.totalTokens, responseContent: call.responseContent,
        failureCode: call.failureCode, correlationId: call.correlationId,
        requestId: call.requestId, createdAt: call.createdAt,
      })),
    } as AdminSessionDetail;
  }

  private listItem(session: any): AdminSessionListItem {
    return {
      id: session.id,
      user: { id: session.user.id, telegramId: session.user.telegramId.toString(), username: session.user.username },
      prompt: session.prompt,
      source: session.source,
      deliveryStatus: session.deliveryStatus,
      conversationStatus: session.conversationStatus,
      generationStatus: session.userResponse?.generationStatus ?? null,
      turnCount: session._count.conversationMessages,
      createdAt: session.createdAt,
      sentAt: session.sentAt,
      conversationClosedAt: session.conversationClosedAt,
      generatedAt: session.userResponse?.generatedAt ?? null,
      contentPurged: Boolean(session.contentPurgedAt),
    };
  }

  private analysis(raw: string | null, kind: string | null, version: number | null): AdminSessionDetail["response"] extends infer R ? any : never {
    if (!raw) return null;
    if ((kind === "model" || kind === "fallback") && version === 1) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.summary === "string" && Array.isArray(parsed.improvementPoints) && typeof parsed.overallScore === "number") {
          return { kind, version: 1, summary: parsed.summary, improvementPoints: parsed.improvementPoints.filter((item: unknown) => typeof item === "string"), overallScore: parsed.overallScore };
        }
      } catch {}
    }
    return { kind: "legacy", raw };
  }
}
