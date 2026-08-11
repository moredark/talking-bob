const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { AdminAnalyticsService } = require("../dist/modules/admin/admin-analytics.service");
const { ConversationService } = require("../dist/modules/conversation/conversation.service");
const { getLocalDateKey } = require("../dist/shared/time/timezone");

const prisma = new PrismaClient();

test("analytics facts survive sensitive retention purge and use indexed durable sources", async () => {
  await prisma.$connect();
  const ids = {};
  try {
    await prisma.$transaction(async (tx) => {
      const telegramBase = BigInt(Date.now()) * 1000n;
      const user = await tx.user.create({ data: { telegramId: telegramBase + 501n, createdAt: new Date("2026-08-04T09:00:00Z"), updatedAt: new Date("2026-08-04T09:00:00Z"), dailyPromptEnabled: false } });
      const recipientUser = await tx.user.create({ data: { telegramId: telegramBase + 502n, createdAt: new Date("2026-08-08T09:00:00Z"), updatedAt: new Date("2026-08-08T09:00:00Z"), dailyPromptEnabled: false } });
      const prompt = await tx.prompt.create({ data: { topic: `Analytics ${randomUUID()}`, textContent: "fixture", createdAt: new Date("2026-08-04T09:00:00Z") } });
      const retentionPrompt = await tx.userPrompt.create({ data: { userId: user.id, promptId: prompt.id, source: "manual", deliveryStatus: "sent", sentAt: new Date("2026-08-04T10:00:00Z"), deliveryAttemptedAt: new Date("2026-08-04T10:00:00Z"), firstUserMessageAt: new Date("2026-08-05T10:00:00Z"), createdAt: new Date("2026-08-04T10:00:00Z") } });
      await tx.conversationMessage.create({ data: { userPromptId: retentionPrompt.id, role: "user", content: "retained", createdAt: new Date("2026-08-05T10:00:00Z") } });
      const completedPrompt = await tx.userPrompt.create({ data: { userId: user.id, promptId: prompt.id, source: "manual", deliveryStatus: "sent", sentAt: new Date("2026-08-08T10:00:00Z"), deliveryAttemptedAt: new Date("2026-08-08T10:00:00Z"), firstUserMessageAt: new Date("2026-08-08T10:01:00Z"), conversationStatus: "closed", conversationClosedAt: new Date("2026-08-08T10:03:00Z"), createdAt: new Date("2026-08-08T10:00:00Z") } });
      await tx.conversationMessage.create({ data: { userPromptId: completedPrompt.id, role: "user", content: "answer", createdAt: new Date("2026-08-08T10:01:00Z") } });
      await tx.userActivityDay.createMany({ data: [
        { userId: user.id, localDate: new Date("2026-08-05T00:00:00Z"), firstActivityAt: new Date("2026-08-05T10:00:00Z"), lastActivityAt: new Date("2026-08-05T10:00:00Z"), messageCount: 1 },
        { userId: user.id, localDate: new Date("2026-08-08T00:00:00Z"), firstActivityAt: new Date("2026-08-08T10:01:00Z"), lastActivityAt: new Date("2026-08-08T10:01:00Z"), messageCount: 1 },
      ] });
      const response = await tx.userResponse.create({ data: { userId: user.id, userPromptId: completedPrompt.id, generationRequestKey: randomUUID(), generationStatus: "generated", generationAttemptedAt: new Date("2026-08-08T10:04:00Z"), generatedAt: new Date("2026-08-08T10:05:00Z"), transcript: "fixture", analysis: JSON.stringify({ summary: { overallScore: 2 }, overallScore: 8.4 }), analysisKind: "model", analysisVersion: 1, overallScore: 8.4, reportDeliveredAt: new Date("2026-08-08T10:06:00Z"), createdAt: new Date("2026-08-08T10:02:00Z") } });
      await tx.reportDeliveryRequest.create({ data: { userResponseId: response.id, requestKey: randomUUID(), chunks: ["fixture"], nextChunkIndex: 1, status: "delivered", deliveryAttemptedAt: new Date("2026-08-08T10:06:00Z"), deliveredAt: new Date("2026-08-08T10:06:00Z"), createdAt: new Date("2026-08-08T10:06:00Z"), updatedAt: new Date("2026-08-08T10:06:00Z") } });
      await tx.aiProviderCall.createMany({ data: [
        { userId: user.id, userPromptId: completedPrompt.id, userResponseId: response.id, operation: "analysis", provider: "fixture", model: "fixture", attempt: 1, outcome: "succeeded", latencyMs: 100, responseContent: "fixture", inputTokens: 10, outputTokens: 5, totalTokens: 15, createdAt: new Date("2026-08-08T10:04:00Z") },
        { userId: user.id, userPromptId: completedPrompt.id, userResponseId: response.id, operation: "analysis", provider: "fixture", model: "fixture", attempt: 2, outcome: "failed", latencyMs: 300, failureCode: "provider_error", createdAt: new Date("2026-08-08T10:05:00Z") },
      ] });
      const broadcast = await tx.broadcast.create({ data: { content: "fixture", filters: {}, mode: "immediate", scheduledAt: new Date("2026-08-09T10:00:00Z"), status: "completed_with_errors", totalRecipients: 2, sentCount: 1, failedCount: 1, createdById: "analytics-test", createdByUsername: "Analytics Test", terminalAt: new Date("2026-08-09T10:02:00Z"), createdAt: new Date("2026-08-09T10:00:00Z"), updatedAt: new Date("2026-08-09T10:02:00Z") } });
      await tx.broadcastRecipient.createMany({ data: [
        { broadcastId: broadcast.id, userId: user.id, telegramIdSnapshot: user.telegramId, dailyPromptEnabledSnapshot: false, announcementEnabledSnapshot: true, status: "sent", attemptCount: 1, deliveryAttemptedAt: new Date("2026-08-09T10:01:00Z"), sentAt: new Date("2026-08-09T10:01:00Z"), createdAt: new Date("2026-08-09T10:00:00Z"), updatedAt: new Date("2026-08-09T10:01:00Z") },
        { broadcastId: broadcast.id, userId: recipientUser.id, telegramIdSnapshot: recipientUser.telegramId, dailyPromptEnabledSnapshot: false, announcementEnabledSnapshot: true, status: "failed", attemptCount: 1, deliveryAttemptedAt: new Date("2026-08-09T10:01:00Z"), lastErrorCode: "telegram_403", lastErrorAt: new Date("2026-08-09T10:01:00Z"), createdAt: new Date("2026-08-09T10:00:00Z"), updatedAt: new Date("2026-08-09T10:01:00Z") },
      ] });
      Object.assign(ids, { userId: user.id, recipientUserId: recipientUser.id, promptId: prompt.id, responseId: response.id, broadcastId: broadcast.id });
    });

    const service = new AdminAnalyticsService(prisma);
    const coverageMarker = await prisma.adminAnalyticsCoverage.findUniqueOrThrow({ where: { id: "durable_facts" } });
    const generatedAt = new Date(coverageMarker.completeFrom.getTime() + 60 * 60 * 1000);
    const before30 = await service.getAnalytics(30, generatedAt);
    const before90 = await service.getAnalytics(90, generatedAt);
    assert.equal(before30.coverage.status, "partial");
    assert.equal(before90.coverage.status, "partial");
    assert.equal(before90.coverage.incompleteBefore.getTime(), before90.coverage.completeFrom.getTime());
    assert.deepEqual(before90.funnel.stages.map(({ count }) => count), [2, 2, 1, 1, 1]);
    assert.deepEqual(before90.retention.cohorts.find(({ localDate }) => localDate === "2026-08-04").d1, { retainedUsers: 1, ratePct: 100 });
    assert.equal(before90.scores.averageScore, 8.4, "nested raw score must not override the durable top-level fact");

    await prisma.$transaction(async (tx) => {
      await tx.reportDeliveryRequest.deleteMany({ where: { userResponseId: ids.responseId } });
      await tx.conversationMessage.deleteMany({ where: { userPrompt: { userId: ids.userId } } });
      await tx.userResponse.update({ where: { id: ids.responseId }, data: { voiceFileId: null, transcript: null, analysis: null, sensitiveDataPurgedAt: generatedAt } });
    });
    const after30 = await service.getAnalytics(30, generatedAt);
    const after90 = await service.getAnalytics(90, generatedAt);
    for (const [before, after] of [[before30, after30], [before90, after90]]) {
      assert.deepEqual(after.daily, before.daily);
      assert.deepEqual(after.funnel, before.funnel);
      assert.deepEqual(after.retention, before.retention);
      assert.deepEqual(after.scores, before.scores);
    }
    assert.equal(await prisma.conversationMessage.count({ where: { userPrompt: { userId: ids.userId } } }), 0);
    assert.equal(await prisma.reportDeliveryRequest.count({ where: { userResponseId: ids.responseId } }), 0);
    assert.equal((await prisma.userResponse.findUniqueOrThrow({ where: { id: ids.responseId }, select: { analysis: true, overallScore: true, reportDeliveredAt: true } })).analysis, null);

    for (const [offset, sessionTimezone] of ["Pacific/Honolulu", "Asia/Tokyo"].entries()) {
      const sentAt = new Date();
      const runtimePrompt = await prisma.userPrompt.create({ data: { userId: ids.userId, promptId: ids.promptId, source: "manual", deliveryStatus: "sent", sentAt, deliveryAttemptedAt: sentAt } });
      const timezonePrisma = {
        $transaction: (callback) => prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${sessionTimezone}'`);
          return callback(tx);
        }),
      };
      const accepted = await new ConversationService(timezonePrisma).acceptVoiceAndMaybeClaimGeneration({
        userId: ids.userId,
        userPromptId: runtimePrompt.id,
        content: "timezone-safe",
        voiceFileId: `timezone-${offset}`,
        telegramUpdateId: BigInt(Date.now()) * 1000n + BigInt(offset),
        generationRequestKey: `timezone-${randomUUID()}`,
      });
      assert.equal(accepted.outcome, "accepted");
      const expectedLocalDate = getLocalDateKey(accepted.message.createdAt, "Europe/Moscow");
      const [activity] = await prisma.$queryRaw`
        SELECT "localDate"::text AS "localDate"
        FROM user_activity_days
        WHERE "userId" = ${ids.userId} AND "localDate" = ${expectedLocalDate}::date
      `;
      assert.equal(activity.localDate, expectedLocalDate, `runtime activity date must ignore ${sessionTimezone}`);
    }

    const indexes = await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
        'user_prompts_sent_at_idx', 'user_prompts_first_user_message_at_idx',
        'user_activity_days_local_date_user_idx', 'user_responses_generated_at_idx',
        'user_responses_report_delivered_at_idx'
      ) ORDER BY indexname
    `;
    assert.equal(indexes.length, 5);
  } finally {
    if (ids.broadcastId) await prisma.broadcast.deleteMany({ where: { id: ids.broadcastId } });
    if (ids.userId) {
      await prisma.aiProviderCall.deleteMany({ where: { userId: ids.userId } });
      await prisma.reportDeliveryRequest.deleteMany({ where: { userResponse: { userId: ids.userId } } });
      await prisma.conversationMessage.deleteMany({ where: { userPrompt: { userId: ids.userId } } });
      await prisma.userResponse.deleteMany({ where: { userId: ids.userId } });
      await prisma.userPrompt.deleteMany({ where: { userId: ids.userId } });
      await prisma.userActivityDay.deleteMany({ where: { userId: ids.userId } });
    }
    if (ids.userId || ids.recipientUserId) await prisma.user.deleteMany({ where: { id: { in: [ids.userId, ids.recipientUserId].filter(Boolean) } } });
    if (ids.promptId) await prisma.prompt.deleteMany({ where: { id: ids.promptId } });
    await prisma.$disconnect();
  }
});
