const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { PrismaClient, Prisma } = require("@prisma/client");
const { UserService } = require("../dist/modules/user/user.service");
const { RateLimitService } = require("../dist/modules/rate-limit/rate-limit.service");
const { ScheduleService } = require("../dist/modules/schedule/schedule.service");
const { ResponseService } = require("../dist/modules/response/response.service");
const { StreakService } = require("../dist/modules/streak/streak.service");
const { AdminAuditContextService } = require("../dist/modules/admin/admin-audit-context.service");
const { AdminAuditService, AdminAuditWriteError } = require("../dist/modules/admin/admin-audit.service");
const { AdminPromptsService } = require("../dist/modules/admin/admin-prompts.service");
const { AdminBroadcastsService } = require("../dist/modules/admin/admin-broadcasts.service");
const { DataRetentionService } = require("../dist/modules/error-log/data-retention.service");

const prisma = new PrismaClient();
let telegramSequence = BigInt(Date.now()) * 1000n;

function nextTelegramId() {
  telegramSequence += 1n;
  return telegramSequence;
}

async function createUser(data = {}) {
  return prisma.user.create({
    data: {
      telegramId: nextTelegramId(),
      dailyPromptEnabled: false,
      nextPromptAt: null,
      ...data,
    },
  });
}

async function createPrompt(topic = randomUUID()) {
  return prisma.prompt.create({ data: { topic, textContent: topic } });
}

async function createSentUserPrompt(userId, promptId) {
  const sentAt = new Date();
  return prisma.userPrompt.create({
    data: {
      userId,
      promptId,
      source: "manual",
      deliveryStatus: "sent",
      deliveryAttemptedAt: sentAt,
      sentAt,
    },
  });
}

test("critical PostgreSQL invariants", async (t) => {
  await prisma.$connect();

  await t.test("fresh migrations and timestamptz are session-TimeZone invariant", async () => {
    const migrations = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    assert.ok(migrations.some(({ migration_name }) => migration_name === "20260810150000_admin_broadcasts"));

    const instant = new Date("2026-08-08T12:34:56.789Z");
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
      const user = await tx.user.create({
        data: {
          telegramId: nextTelegramId(),
          dailyPromptEnabled: false,
          nextPromptAt: null,
          lastPromptSentAt: instant,
        },
      });
      const [row] = await tx.$queryRaw`
        SELECT current_setting('TimeZone') AS timezone,
               EXTRACT(EPOCH FROM "lastPromptSentAt") * 1000 AS millis
        FROM "users" WHERE "id" = ${user.id}
      `;
      return row;
    });
    assert.equal(result.timezone, "Pacific/Honolulu");
    assert.equal(Number(result.millis), instant.getTime());
  });

  await t.test("streak qualification is atomic and calendar/source/reminder identities are unique", async () => {
    const migrations = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name = '20260811120000_add_streaks'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    assert.equal(migrations.length, 1);

    const user = await createUser({ timezone: "UTC" });
    const prompt = await createPrompt("streak-invariants");
    const firstSession = await createSentUserPrompt(user.id, prompt.id);
    const secondSession = await createSentUserPrompt(user.id, prompt.id);
    const service = new StreakService(prisma);
    const qualifiedAt = new Date("2026-08-01T10:00:00.000Z");

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await service.qualifyConversation({
          userId: user.id,
          userPromptId: firstSession.id,
          qualifiedAt,
        }, tx);
        throw new Error("force_streak_rollback");
      }),
      /force_streak_rollback/,
    );
    assert.equal(await prisma.streakDay.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.streakReminder.count({ where: { userId: user.id } }), 0);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).currentStreak, 0);

    await prisma.$transaction((tx) => service.qualifyConversation({
      userId: user.id,
      userPromptId: firstSession.id,
      qualifiedAt,
    }, tx));
    const parallelClaims = await Promise.all([
      service.claimDueReminders(1, new Date("2026-08-02T21:00:00.000Z")),
      new StreakService(prisma).claimDueReminders(1, new Date("2026-08-02T21:00:00.000Z")),
    ]);
    assert.equal(parallelClaims.flat().length, 1, "parallel workers claim one reminder identity");
    const localDate = new Date("2026-08-01T00:00:00.000Z");
    await assert.rejects(
      prisma.streakDay.create({
        data: {
          userId: user.id,
          localDate,
          qualifiedAt,
          timezoneSnapshot: "UTC",
          streakLength: 1,
          longestStreak: 1,
          sourceUserPromptId: secondSession.id,
        },
      }),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );
    await assert.rejects(
      prisma.streakDay.create({
        data: {
          userId: user.id,
          localDate: new Date("2026-08-02T00:00:00.000Z"),
          qualifiedAt,
          timezoneSnapshot: "UTC",
          streakLength: 2,
          longestStreak: 2,
          sourceUserPromptId: firstSession.id,
        },
      }),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );
    const reminder = await prisma.streakReminder.findFirstOrThrow({ where: { userId: user.id } });
    await assert.rejects(
      prisma.streakReminder.create({
        data: {
          userId: user.id,
          localDate: reminder.localDate,
          nextAttemptAt: reminder.nextAttemptAt,
          expiresAt: reminder.expiresAt,
        },
      }),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );
  });
  await t.test("runtime settings singleton enforces shape, independent CAS, and audit atomicity", async () => {
    const migrations = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name = '20260810140000_admin_runtime_settings'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    assert.equal(migrations.length, 1);
    const singleton = await prisma.runtimeSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    assert.ok(singleton.productVersion >= 0);
    assert.ok(singleton.infrastructureVersion >= 0);
    await assert.rejects(
      prisma.runtimeSettings.create({ data: { id: "other" } }),
      (error) => error instanceof Prisma.PrismaClientUnknownRequestError
        && error.message.includes("runtime_settings_singleton_check"),
    );
    const attempts = await Promise.all([
      prisma.runtimeSettings.updateMany({
        where: { id: "singleton", productVersion: singleton.productVersion },
        data: { productOverrides: { COMMAND_MAX_REQUESTS: 40 }, productVersion: { increment: 1 } },
      }),
      prisma.runtimeSettings.updateMany({
        where: { id: "singleton", productVersion: singleton.productVersion },
        data: { productOverrides: { COMMAND_MAX_REQUESTS: 41 }, productVersion: { increment: 1 } },
      }),
    ]);
    assert.deepEqual(attempts.map(({ count }) => count).sort(), [0, 1]);
    const beforeFailure = await prisma.runtimeSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.runtimeSettings.update({
        where: { id: "singleton" },
        data: { infrastructureOverrides: { LLM_MODEL: "next/model" }, infrastructureVersion: { increment: 1 } },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: "integration", actorUsername: "integration",
          action: "settings.infrastructure.update", entityType: "user",
          entityId: "singleton", outcome: "success",
          requestId: "runtime-settings", correlationId: "runtime-settings",
        },
      });
    }));
    const afterFailure = await prisma.runtimeSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    assert.equal(afterFailure.infrastructureVersion, beforeFailure.infrastructureVersion);
    assert.deepEqual(afterFailure.infrastructureOverrides, beforeFailure.infrastructureOverrides);
  });

  await t.test("broadcast snapshot, consent, constraints, audit and queued claim are atomic", async () => {
    const eligible = await createUser({
      status: "active", bannedAt: null, announcementEnabled: true,
      languageLevel: "B1", dailyPromptEnabled: false,
    });
    await createUser({ status: "active", announcementEnabled: false, languageLevel: "B1" });
    await createUser({
      status: "banned", bannedAt: new Date(), bannedReason: "integration",
      announcementEnabled: true, languageLevel: "B1",
    });
    const context = new AdminAuditContextService();
    const audit = new AdminAuditService(prisma, context);
    const broadcasts = new AdminBroadcastsService(prisma, audit, context);
    const activityNow = new Date("2026-08-10T10:00:00.000Z");
    await prisma.user.update({
      where: { id: eligible.id },
      data: { lastUserMessageAt: new Date("2026-07-21T10:00:00.000Z") },
    });
    assert.equal((await broadcasts.preview({
      content: "preview", filters: { languageLevels: ["B1"], activity: "30d", dailyPromptEnabled: false },
      mode: "immediate", scheduledFor: null, scheduledAt: activityNow,
    }, activityNow)).audienceCount, 1);
    assert.equal((await broadcasts.preview({
      content: "preview", filters: { languageLevels: ["B1"], activity: "never", dailyPromptEnabled: false },
      mode: "immediate", scheduledFor: null, scheduledAt: activityNow,
    }, activityNow)).audienceCount, 0);
    const auditContext = context.create({
      actorId: "broadcast-integration", actorUsername: "integration",
      requestId: "broadcast-request", correlationId: "broadcast-correlation",
    });
    const created = await context.run(auditContext, () => broadcasts.create({
      content: "private announcement body",
      filters: { languageLevels: ["B1"], activity: "any", dailyPromptEnabled: false },
      mode: "immediate",
      scheduledFor: null,
      scheduledAt: new Date(),
    }));
    assert.equal(created.counts.total, 1);
    assert.equal(created.recipients.total, 1);
    assert.equal(created.recipients.data[0].user.id, eligible.id);
    const auditRow = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "broadcast.create", entityId: created.id },
    });
    assert.equal(auditRow.outcome, "success");
    assert.equal(auditRow.after.audienceCount, 1);
    assert.doesNotMatch(JSON.stringify(auditRow), /private announcement body/);

    await assert.rejects(
      prisma.broadcast.create({
        data: {
          content: null,
          filters: {},
          mode: "immediate",
          scheduledAt: new Date(),
          createdById: "integration",
          createdByUsername: "integration",
        },
      }),
      (error) => error instanceof Prisma.PrismaClientUnknownRequestError
        && error.message.includes("broadcasts_content_purge_shape_check"),
    );

    const queued = await prisma.broadcast.create({
      data: {
        content: "queued",
        filters: {},
        mode: "immediate",
        scheduledAt: new Date(),
        createdById: "integration",
        createdByUsername: "integration",
      },
    });
    const claims = await Promise.all([
      prisma.broadcast.updateMany({ where: { id: queued.id, status: "queued" }, data: { status: "processing" } }),
      prisma.broadcast.updateMany({ where: { id: queued.id, status: "queued" }, data: { status: "processing" } }),
    ]);
    assert.deepEqual(claims.map(({ count }) => count).sort(), [0, 1]);
    assert.equal((await prisma.broadcast.findUniqueOrThrow({ where: { id: queued.id } })).status, "processing");
  });

  await t.test("AI provider calls enforce shape, cascade with sessions, and purge at the 30-day boundary", async () => {
    const migrations = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name = '20260810130000_admin_session_inspection'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    assert.equal(migrations.length, 1);
    const user = await createUser();
    const prompt = await createPrompt("ai-trace-invariants");
    await prisma.prompt.update({ where: { id: prompt.id }, data: { isActive: false } });
    const oldSession = await createSentUserPrompt(user.id, prompt.id);
    const boundarySession = await createSentUserPrompt(user.id, prompt.id);
    await assert.rejects(
      prisma.aiProviderCall.create({ data: {
        userId: user.id, userPromptId: oldSession.id, operation: "analysis",
        provider: "cloud.ru", model: "model", attempt: 1, outcome: "succeeded",
        latencyMs: 1, responseContent: " ",
      } }),
      (error) => error instanceof Prisma.PrismaClientUnknownRequestError
        && error.message.includes("ai_provider_calls_shape_check"),
    );
    await prisma.aiProviderCall.createMany({ data: [
      { id: randomUUID(), userId: user.id, userPromptId: oldSession.id, operation: "analysis", provider: "cloud.ru", model: "model", attempt: 1, outcome: "failed", latencyMs: 1, failureCode: "http_503", createdAt: new Date("2026-07-11T11:59:59.999Z") },
      { id: randomUUID(), userId: user.id, userPromptId: boundarySession.id, operation: "follow_up", provider: "cloud.ru", model: "model", attempt: 1, outcome: "empty", statusCode: 200, latencyMs: 1, createdAt: new Date("2026-07-11T12:00:00.000Z") },
    ] });
    const retention = new DataRetentionService(prisma, {
      retention: { closedConversationContentDays: 30, rateLimitDays: 30, errorLogsDays: 30 },
    });
    assert.equal((await retention.cleanup(new Date("2026-08-10T12:00:00.000Z"))).aiProviderCalls, 1);
    assert.equal(await prisma.aiProviderCall.count({ where: { userPromptId: oldSession.id } }), 0);
    assert.equal(await prisma.aiProviderCall.count({ where: { userPromptId: boundarySession.id } }), 1);
    assert.equal((await prisma.userPrompt.findUniqueOrThrow({ where: { id: oldSession.id } })).aiTracePurgedAt.toISOString(), "2026-08-10T12:00:00.000Z");
    await prisma.userPrompt.delete({ where: { id: boundarySession.id } });
    assert.equal(await prisma.aiProviderCall.count({ where: { userPromptId: boundarySession.id } }), 0);
  });


  await t.test("admin mutation and success audit commit atomically while audit failure rolls back", async () => {
    const context = new AdminAuditContextService();
    const audit = new AdminAuditService(prisma, context);
    const prompts = new AdminPromptsService(prisma, audit);
    const auditContext = context.create({
      actorId: "integration-admin", actorUsername: "integration",
      requestId: "integration-request", correlationId: "integration-correlation",
    });
    const created = await context.run(auditContext, () => prompts.createPrompt({
      topic: "audited-prompt", textContent: "private prompt text", audioFileId: "provider-file",
      difficulty: "hard", tags: ["grammar"], sortOrder: 7,
    }));
    const success = await prisma.adminAuditLog.findFirstOrThrow({ where: { entityId: created.id } });
    assert.equal(success.action, "prompt.create");
    assert.equal(success.outcome, "success");
    assert.equal(success.actorId, "integration-admin");
    assert.deepEqual(success.after, {
      difficulty: "hard", tags: ["grammar"], isActive: true, sortOrder: 7,
      hasTextContent: true, hasAudioFileId: true,
    });
    assert.doesNotMatch(JSON.stringify(success), /private prompt text|provider-file/);

    const rollbackTopic = `audit-rollback-${randomUUID()}`;
    await assert.rejects(
      context.run(auditContext, () => audit.runSuccess(
        { action: "prompt.create", entityType: "prompt" },
        async (tx) => {
          await tx.prompt.create({ data: { topic: rollbackTopic, textContent: rollbackTopic } });
          return { result: true, entityId: "invalid entity id" };
        },
      )),
      (error) => error instanceof AdminAuditWriteError,
    );
    assert.equal(await prisma.prompt.count({ where: { topic: rollbackTopic } }), 0);

    await assert.rejects(
      prisma.adminAuditLog.create({
        data: {
          actorId: "integration-admin", actorUsername: "integration", action: "secret.read",
          entityType: "prompt", entityId: created.id, outcome: "success",
          requestId: "integration-request", correlationId: "integration-correlation",
        },
      }),
      (error) => error instanceof Prisma.PrismaClientUnknownRequestError
        && error.message.includes("admin_audit_logs_action_check"),
    );
  });

  await t.test("concurrent user upsert preserves one identity", async () => {
    const service = new UserService(prisma);
    const rounds = Array.from({ length: 8 }, () => nextTelegramId());

    for (const telegramId of rounds) {
      const users = await Promise.all(
        Array.from({ length: 8 }, () => service.findOrCreateByTelegramId(telegramId, "parallel")),
      );
      assert.equal(new Set(users.map(({ id }) => id)).size, 1);
      assert.equal(await prisma.user.count({ where: { telegramId } }), 1);
    }
  });

  await t.test("calendar quota is bounded and opens a new persisted window after reset", async () => {
    const user = await createUser({ timezone: "Europe/Moscow" });
    const service = new RateLimitService(prisma);
    const admissions = await Promise.all([
      service.consumeCalendarDayLimit(user.id, "integration_quota", "UTC", 1),
      service.consumeCalendarDayLimit(user.id, "integration_quota", "UTC", 1),
    ]);
    assert.deepEqual(admissions.map(({ allowed }) => allowed).sort(), [false, true]);
    assert.equal(await prisma.userRequest.count({ where: { userId: user.id, action: "integration_quota" } }), 1);

    assert.equal(await prisma.quotaWindow.count({ where: { userId: user.id, action: "integration_quota" } }), 1);

    const resetUser = await createUser({ timezone: "Europe/Moscow" });
    const oldStart = new Date("2026-08-06T21:00:00.000Z");
    const oldEnd = new Date("2026-08-07T21:00:00.000Z");
    const oldWindow = await prisma.quotaWindow.create({
      data: {
        userId: resetUser.id,
        action: "integration_quota_reset",
        timezoneSnapshot: "Europe/Moscow",
        windowStart: oldStart,
        windowEnd: oldEnd,
      },
    });
    await prisma.userRequest.create({
      data: { userId: resetUser.id, action: "integration_quota_reset", quotaWindowId: oldWindow.id, createdAt: oldStart },
    });
    const afterReset = await service.consumeCalendarDayLimit(resetUser.id, "integration_quota_reset", "UTC", 1);
    assert.equal(afterReset.allowed, true);
    assert.equal(await prisma.quotaWindow.count({ where: { userId: resetUser.id, action: "integration_quota_reset" } }), 2);
    const admittedRequest = await prisma.userRequest.findUniqueOrThrow({
      where: { id: afterReset.requestId },
      include: { quotaWindow: true },
    });
    assert.notEqual(admittedRequest.quotaWindowId, oldWindow.id);
    assert.equal(admittedRequest.quotaWindow.timezoneSnapshot, "Europe/Moscow");
    assert.ok(admittedRequest.quotaWindow.windowStart <= admittedRequest.createdAt);
    assert.ok(admittedRequest.quotaWindow.windowEnd > admittedRequest.createdAt);
  });

  await t.test("manual/manual and manual/scheduled claims serialize prompt history", async () => {
    await prisma.prompt.updateMany({ data: { isActive: false } });
    const schedule = new ScheduleService(prisma);
    const [firstPrompt, secondPrompt] = await Promise.all([
      createPrompt("locking-a"),
      createPrompt("locking-b"),
    ]);

    const manualUser = await createUser();
    let releaseManualLock;
    let manualLocked;
    const manualLockReady = new Promise((resolve) => { manualLocked = resolve; });
    const releaseManual = new Promise((resolve) => { releaseManualLock = resolve; });
    const lockedReservation = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${manualUser.id} FOR UPDATE`;
      await tx.userPrompt.create({
        data: {
          userId: manualUser.id,
          promptId: firstPrompt.id,
          source: "manual",
          deliveryStatus: "pending",
        },
      });
      manualLocked();
      await releaseManual;
    }, { timeout: 10_000 });
    await manualLockReady;

    let contenderResolved = false;
    const manualContender = schedule.createManualClaim(manualUser).then((claim) => {
      contenderResolved = true;
      return claim;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(contenderResolved, false);
    releaseManualLock();
    await lockedReservation;
    const lockedManualClaim = await manualContender;
    assert.ok(lockedManualClaim);
    assert.equal(lockedManualClaim.prompt.id, secondPrompt.id);

    const nextManualClaim = await schedule.createManualClaim(manualUser);
    assert.ok(nextManualClaim);
    assert.notEqual(nextManualClaim.prompt.id, lockedManualClaim.prompt.id);

    const now = new Date();
    const mixedUser = await createUser({
      dailyPromptEnabled: true,
      dailyPromptHour: 13,
      dailyPromptMinute: 0,
      timezone: "Europe/Moscow",
      nextPromptAt: new Date(now.getTime() - 60_000),
    });
    const [manualClaim, scheduledClaims] = await Promise.all([
      schedule.createManualClaim(mixedUser, now),
      schedule.claimScheduledBatch(10, now),
    ]);
    const scheduledClaim = scheduledClaims.find(({ user }) => user.id === mixedUser.id)
      ?? (await schedule.claimScheduledBatch(10, now)).find(({ user }) => user.id === mixedUser.id);
    assert.ok(manualClaim);
    assert.ok(scheduledClaim);
    assert.notEqual(manualClaim.prompt.id, scheduledClaim.prompt.id);
  });

  await t.test("report ownership, fencing, and uniqueness are enforced", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const prompt = await createPrompt("report-locking");
    const userPrompt = await createSentUserPrompt(owner.id, prompt.id);
    await prisma.conversationMessage.create({
      data: { userPromptId: userPrompt.id, role: "user", content: "hello", telegramUpdateId: nextTelegramId() },
    });
    const service = new ResponseService(prisma, new StreakService(prisma));

    const wrongOwner = await service.claimGeneration({
      userId: stranger.id, userPromptId: userPrompt.id, voiceFileId: "voice", generationRequestKey: "wrong-owner",
    });
    assert.equal(wrongOwner.outcome, "missing_prompt");

    const claims = await Promise.all([
      service.claimGeneration({ userId: owner.id, userPromptId: userPrompt.id, voiceFileId: "voice", generationRequestKey: "same-request" }),
      service.claimGeneration({ userId: owner.id, userPromptId: userPrompt.id, voiceFileId: "voice", generationRequestKey: "same-request" }),
    ]);
    assert.deepEqual(claims.map(({ outcome }) => outcome).sort(), ["busy", "claimed"]);
    const generation = claims.find(({ outcome }) => outcome === "claimed").claim;
    assert.equal(await prisma.userResponse.count({ where: { userPromptId: userPrompt.id } }), 1);

    const staleGeneration = await service.completeGeneration({
      responseId: generation.responseId, claimToken: randomUUID(), transcript: "hello", analysis: "analysis",
      analysisVersion: 1, analysisKind: "model", chunks: ["one"],
    });
    assert.equal(staleGeneration.outcome, "stale");
    const completed = await service.completeGeneration({
      responseId: generation.responseId, claimToken: generation.claimToken, transcript: "hello", analysis: "analysis",
      analysisVersion: 1, analysisKind: "model", chunks: ["one"],
    });
    assert.equal(completed.outcome, "claimed");

    assert.equal((await service.beginDeliveryChunk(completed.claim.requestId, randomUUID())).outcome, "stale");
    const begun = await service.beginDeliveryChunk(completed.claim.requestId, completed.claim.claimToken);
    assert.equal(begun.outcome, "begun");
    assert.equal((await service.completeDeliveryChunk(completed.claim.requestId, 0, new Date(begun.attemptedAt.getTime() + 1))).outcome, "stale");
    assert.equal((await service.completeDeliveryChunk(completed.claim.requestId, 0, begun.attemptedAt)).outcome, "delivered");

    await assert.rejects(
      prisma.reportDeliveryRequest.create({
        data: {
          userResponseId: generation.responseId, requestKey: "same-request", chunks: ["duplicate"],
          claimToken: randomUUID(), claimExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );
  });

  await t.test("scheduled occurrence is unique and SKIP LOCKED lets another due user progress", async () => {
    const schedule = new ScheduleService(prisma);
    const now = new Date();
    await createPrompt("skip-locked");
    const first = await createUser({
      dailyPromptEnabled: true, dailyPromptHour: 13, dailyPromptMinute: 0, timezone: "Europe/Moscow",
      nextPromptAt: new Date(now.getTime() - 120_000),
    });
    const second = await createUser({
      dailyPromptEnabled: true, dailyPromptHour: 13, dailyPromptMinute: 0, timezone: "Europe/Moscow",
      nextPromptAt: new Date(now.getTime() - 60_000),
    });

    let releaseLock;
    let locked;
    const lockReady = new Promise((resolve) => { locked = resolve; });
    const release = new Promise((resolve) => { releaseLock = resolve; });
    const lockTransaction = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${first.id} FOR UPDATE`;
      locked();
      await release;
    }, { timeout: 10_000 });
    await lockReady;
    const whileLocked = await schedule.claimScheduledBatch(2, now);
    assert.ok(whileLocked.some(({ user }) => user.id === second.id));
    assert.ok(!whileLocked.some(({ user }) => user.id === first.id));
    releaseLock();
    await lockTransaction;

    const afterRelease = await Promise.all([
      schedule.claimScheduledBatch(2, now),
      schedule.claimScheduledBatch(2, now),
    ]);
    assert.equal(afterRelease.flat().filter(({ user }) => user.id === first.id).length, 1);
    const occurrences = await prisma.userPrompt.findMany({ where: { userId: first.id, source: "scheduled" } });
    assert.equal(occurrences.length, 1);
    assert.equal(new Set(occurrences.map(({ scheduledOccurrenceKey }) => scheduledOccurrenceKey)).size, 1);
  });
});

test.after(async () => {
  await prisma.$disconnect();
});
