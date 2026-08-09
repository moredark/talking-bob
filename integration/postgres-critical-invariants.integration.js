const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { PrismaClient, Prisma } = require("@prisma/client");
const { UserService } = require("../dist/modules/user/user.service");
const { RateLimitService } = require("../dist/modules/rate-limit/rate-limit.service");
const { ScheduleService } = require("../dist/modules/schedule/schedule.service");
const { ResponseService } = require("../dist/modules/response/response.service");

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
    assert.ok(migrations.some(({ migration_name }) => migration_name === "20260808180000_prompt_selection_history"));

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
    const service = new ResponseService(prisma);

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
