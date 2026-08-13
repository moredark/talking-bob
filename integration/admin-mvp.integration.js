require("reflect-metadata");
const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Module } = require("@nestjs/common");
const { NestFactory, Reflector } = require("@nestjs/core");
const { PrismaService } = require("../dist/infrastructure/database");
const { RUNTIME_CONFIG } = require("../dist/config/runtime-config.module");
const { RUNTIME_SETTINGS_BOOTSTRAP, RuntimeSettingsService } = require("../dist/config/runtime-settings.service");
const { AuthController } = require("../dist/modules/auth/auth.controller");
const { AuthService } = require("../dist/modules/auth/auth.service");
const { AuthGuard } = require("../dist/modules/auth/auth.guard");
const { AdminController } = require("../dist/modules/admin/admin.controller");
const { AdminService } = require("../dist/modules/admin/admin.service");
const { AdminAnalyticsService } = require("../dist/modules/admin/admin-analytics.service");
const { AdminAuditContextService } = require("../dist/modules/admin/admin-audit-context.service");
const { AdminAuditInterceptor } = require("../dist/modules/admin/admin-audit.interceptor");
const { AdminAuditService } = require("../dist/modules/admin/admin-audit.service");
const { AdminBroadcastsService } = require("../dist/modules/admin/admin-broadcasts.service");
const { AdminSessionsService } = require("../dist/modules/admin/admin-sessions.service");
const { AdminSettingsService } = require("../dist/modules/admin/admin-settings.service");
const { DataRetentionService } = require("../dist/modules/error-log/data-retention.service");
const { BroadcastDispatcher } = require("../dist/modules/broadcast");

const EXPECTED_MIGRATIONS = [
  "20260118172424",
  "20260124153443_add_conversation_messages",
  "20260124160345_add_user_daily_prompt_settings",
  "20260125000000_add_schedule_fields",
  "20260128180643",
  "20260128181852_add_admin_features",
  "20260307110000_add_agent_tone",
  "20260728120000_optional_prompt_audio",
  "20260806120000_delivery_lifecycle",
  "20260808120000_report_lifecycle",
  "20260808140000_quota_windows",
  "20260808160000_retention_and_error_correlation",
  "20260808180000_prompt_selection_history",
  "20260810120000_admin_audit_log",
  "20260810130000_admin_session_inspection",
  "20260810140000_admin_runtime_settings",
  "20260810150000_admin_broadcasts",
  "20260810160000_admin_analytics_facts",
  "20260811120000_add_streaks",
  "20260812120000_agent_personalities",
  "20260813120000_split_agent_prompt_rules",
];

const prisma = new PrismaClient();
let telegramId = BigInt(Date.now()) * 1000n;

async function startAdminHttpApp(runtimeRow, jwtSecret) {
  const bootstrap = { row: runtimeRow, env: Object.freeze({}), bootInfrastructure: Object.freeze({}) };
  const unused = Object.freeze({});
  class RolloutAdminModule {}
  Module({
    controllers: [AuthController, AdminController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: RUNTIME_CONFIG, useValue: { jwtSecret } },
      { provide: RUNTIME_SETTINGS_BOOTSTRAP, useValue: bootstrap },
      AuthService, AuthGuard, RuntimeSettingsService, AdminAuditContextService,
      AdminAuditService, AdminBroadcastsService, AdminAnalyticsService,
      AdminSessionsService, AdminSettingsService, Reflector, AdminAuditInterceptor,
      {
        provide: AdminService,
        inject: [AdminBroadcastsService, AdminAnalyticsService, AdminSessionsService, AdminAuditService, AdminSettingsService],
        useFactory: (broadcasts, analytics, sessions, audit, settings) =>
          new AdminService(broadcasts, unused, analytics, unused, unused, unused, sessions, audit, settings),
      },
    ],
  })(RolloutAdminModule);
  const app = await NestFactory.create(RolloutAdminModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function httpJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function nextTelegramId() {
  telegramId += 1n;
  return telegramId;
}

async function createUser() {
  return prisma.user.create({
    data: {
      telegramId: nextTelegramId(),
      username: `admin-mvp-${randomUUID()}`,
      dailyPromptEnabled: false,
      announcementEnabled: true,
      nextPromptAt: null,
    },
  });
}

test("Admin MVP PostgreSQL rollout journey", async (t) => {
  await prisma.$connect();

  await t.test("fresh schema contains all 21 ordered migrations and analytics facts", async () => {
    const migrations = await prisma.$queryRaw`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY started_at, migration_name
    `;
    assert.deepEqual(migrations.map(({ migration_name }) => migration_name), EXPECTED_MIGRATIONS);

    const columns = await prisma.$queryRaw`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'user_prompts' AND column_name = 'firstUserMessageAt')
          OR (table_name = 'user_responses' AND column_name IN ('overallScore', 'reportDeliveredAt'))
        )
      ORDER BY table_name, column_name
    `;
    assert.deepEqual(
      columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
      [
        "user_prompts.firstUserMessageAt",
        "user_responses.overallScore",
        "user_responses.reportDeliveredAt",
      ],
    );

    const coverage = await prisma.$queryRaw`
      SELECT id, "completeFrom"
      FROM "admin_analytics_coverage"
    `;
    assert.equal(coverage.length, 1);
    assert.equal(coverage[0].id, "durable_facts");
    assert.ok(coverage[0].completeFrom instanceof Date);
  });

  await t.test("real Nest HTTP admin seams enforce auth, DTOs and privacy", async () => {
    const jwtSecret = `rollout-secret-${randomUUID()}`;
    const adminUsername = `rollout-admin-${randomUUID()}`;
    const adminPassword = `Pw-${randomUUID()}`;
    const admin = await prisma.adminUser.create({ data: { username: adminUsername, passwordHash: await bcrypt.hash(adminPassword, 4) } });
    const user = await createUser();
    const prompt = await prisma.prompt.create({ data: { topic: `http-${randomUUID()}`, textContent: "HTTP fixture" } });
    const session = await prisma.userPrompt.create({ data: { userId: user.id, promptId: prompt.id, source: "manual", deliveryStatus: "sent", deliveryAttemptedAt: new Date(), sentAt: new Date(), conversationStatus: "open" } });
    await prisma.aiProviderCall.create({ data: { userId: user.id, userPromptId: session.id, operation: "follow_up", provider: "cloud.ru", model: "rollout-model", attempt: 1, outcome: "succeeded", latencyMs: 1, responseContent: "provider-detail-only" } });
    const runtimeRow = await prisma.runtimeSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    const { app, baseUrl } = await startAdminHttpApp(runtimeRow, jwtSecret);
    try {
      assert.equal((await httpJson(baseUrl, "/admin/settings")).response.status, 401);
      const login = await httpJson(baseUrl, "/auth/login", { method: "POST", body: JSON.stringify({ username: adminUsername, password: adminPassword }) });
      assert.equal(login.response.status, 201);
      const auth = { authorization: `Bearer ${login.body.accessToken}` };
      assert.equal((await httpJson(baseUrl, "/auth/me", { headers: auth })).body.id, admin.id);
      const expired = jwt.sign({ sub: admin.id, username: adminUsername }, jwtSecret, { expiresIn: -1 });
      assert.equal((await httpJson(baseUrl, "/admin/settings", { headers: { authorization: `Bearer ${expired}` } })).response.status, 401);
      assert.equal((await httpJson(baseUrl, "/admin/analytics?days=30&extra=1", { headers: auth })).response.status, 422);
      const settings = await httpJson(baseUrl, "/admin/settings", { headers: auth });
      assert.equal(settings.response.status, 200);
      const updated = await httpJson(baseUrl, "/admin/settings/product", { method: "PATCH", headers: auth, body: JSON.stringify({ expectedVersion: settings.body.product.version, values: { COMMAND_MAX_REQUESTS: 41 } }) });
      assert.equal(updated.response.status, 200);
      const reset = await httpJson(baseUrl, "/admin/settings/product", { method: "PATCH", headers: auth, body: JSON.stringify({ expectedVersion: updated.body.version, values: { COMMAND_MAX_REQUESTS: null } }) });
      assert.equal(reset.response.status, 200);
      const detail = await httpJson(baseUrl, `/admin/sessions/${session.id}`, { headers: auth });
      assert.equal(detail.response.status, 200);
      assert.match(JSON.stringify(detail.body), /provider-detail-only/);
      const list = await httpJson(baseUrl, "/admin/sessions?page=1&limit=20", { headers: auth });
      assert.equal(list.response.status, 200);
      assert.doesNotMatch(JSON.stringify(list.body), /provider-detail-only/);
      const input = { content: "rollout announcement", filters: { languageLevels: [], activity: "any", dailyPromptEnabled: "any" }, mode: "immediate" };
      assert.equal((await httpJson(baseUrl, "/admin/broadcasts/preview", { method: "POST", headers: auth, body: JSON.stringify(input) })).response.status, 201);
      assert.equal((await httpJson(baseUrl, "/admin/broadcasts", { method: "POST", headers: auth, body: JSON.stringify(input) })).response.status, 201);
      const analytics = await httpJson(baseUrl, "/admin/analytics?days=30", { headers: auth });
      assert.equal(analytics.response.status, 200);
      assert.equal(analytics.body.version, 1);
      const audit = await httpJson(baseUrl, "/admin/audit-logs?page=1&limit=20", { headers: auth });
      assert.equal(audit.response.status, 200);
      assert.doesNotMatch(JSON.stringify(audit.body), /rollout announcement|provider-detail-only/);
    } finally {
      await app.close();
    }
  });

  await t.test("runtime overrides and broadcast claims survive a client restart", async () => {
    const original = await prisma.runtimeSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    const marker = 37;
    const applied = await prisma.runtimeSettings.updateMany({
      where: { id: "singleton", productVersion: original.productVersion },
      data: {
        productOverrides: { COMMAND_MAX_REQUESTS: marker },
        productVersion: { increment: 1 },
        updatedById: "rollout-gate",
        updatedByUsername: "rollout-gate",
      },
    });
    assert.equal(applied.count, 1);
    const stale = await prisma.runtimeSettings.updateMany({
      where: { id: "singleton", productVersion: original.productVersion },
      data: {
        productOverrides: { COMMAND_MAX_REQUESTS: marker + 1 },
        productVersion: { increment: 1 },
      },
    });
    assert.equal(stale.count, 0, "a stale runtime-settings CAS must not overwrite a newer version");

    const user = await createUser();
    const scheduledAt = new Date("2026-08-10T15:00:00.000Z");
    const broadcast = await prisma.broadcast.create({
      data: {
        content: "bounded rollout fixture",
        filters: {},
        mode: "scheduled",
        scheduledForLocal: "2026-08-10T18:00",
        scheduledAt,
        status: "queued",
        totalRecipients: 1,
        createdById: "rollout-gate",
        createdByUsername: "rollout-gate",
        recipients: {
          create: {
            userId: user.id,
            telegramIdSnapshot: user.telegramId,
            usernameSnapshot: user.username,
            languageLevelSnapshot: user.languageLevel,
            dailyPromptEnabledSnapshot: user.dailyPromptEnabled,
            announcementEnabledSnapshot: user.announcementEnabled,
          },
        },
      },
    });

    await prisma.$disconnect();
    const restarted = new PrismaClient();
    await restarted.$connect();
    try {
      const persisted = await restarted.runtimeSettings.findUniqueOrThrow({ where: { id: "singleton" } });
      assert.equal(persisted.productOverrides.COMMAND_MAX_REQUESTS, marker);
      assert.equal(persisted.productVersion, original.productVersion + 1);

      const claims = await Promise.all([
        restarted.broadcast.updateMany({
          where: { id: broadcast.id, status: "queued", scheduledAt: { lte: scheduledAt } },
          data: { status: "processing" },
        }),
        restarted.broadcast.updateMany({
          where: { id: broadcast.id, status: "queued", scheduledAt: { lte: scheduledAt } },
          data: { status: "processing" },
        }),
      ]);
      assert.deepEqual(claims.map(({ count }) => count).sort(), [0, 1]);
      assert.equal((await restarted.broadcast.findUniqueOrThrow({ where: { id: broadcast.id } })).status, "processing");

      const recipient = await restarted.broadcastRecipient.findFirstOrThrow({
        where: { broadcastId: broadcast.id },
      });
      await restarted.broadcastRecipient.update({
        where: { id: recipient.id },
        data: {
          claimToken: randomUUID(),
          claimExpiresAt: new Date(scheduledAt.getTime() - 1),
          deliveryAttemptedAt: null,
        },
      });
      let sends = 0;
      const sender = {
        sendPlainText: async () => {
          sends += 1;
        },
      };
      const errors = { capture: async () => undefined };
      const dispatchers = [
        new BroadcastDispatcher(restarted, errors),
        new BroadcastDispatcher(restarted, errors),
      ];
      for (const dispatcher of dispatchers) dispatcher.setSender(sender);
      await Promise.all(dispatchers.map((dispatcher) => dispatcher.dispatchDue(scheduledAt)));

      const delivered = await restarted.broadcastRecipient.findUniqueOrThrow({
        where: { id: recipient.id },
      });
      assert.equal(sends, 1, "an expired unattempted lease must be reclaimed and delivered once");
      assert.equal(delivered.status, "sent");
      assert.equal(delivered.claimToken, null);
      assert.equal(delivered.claimExpiresAt, null);
    } finally {
      await restarted.runtimeSettings.update({
        where: { id: "singleton" },
        data: {
          productOverrides: original.productOverrides,
          productVersion: original.productVersion,
          updatedById: original.updatedById,
          updatedByUsername: original.updatedByUsername,
        },
      });
      await restarted.$disconnect();
      await prisma.$connect();
    }
  });

  await t.test("retention removes raw data but preserves non-sensitive analytics facts", async () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const old31 = new Date("2026-07-10T11:59:59.999Z");
    const old91 = new Date("2026-05-10T11:59:59.999Z");
    const old366 = new Date("2025-08-09T11:59:59.999Z");
    const user = await createUser();
    const prompt = await prisma.prompt.create({
      data: { topic: `rollout-${randomUUID()}`, textContent: "retention fixture" },
    });
    const session = await prisma.userPrompt.create({
      data: {
        userId: user.id,
        promptId: prompt.id,
        source: "manual",
        deliveryStatus: "sent",
        deliveryAttemptedAt: old31,
        sentAt: old31,
        firstUserMessageAt: old31,
        conversationStatus: "closed",
        conversationClosedAt: old31,
      },
    });
    await prisma.userActivityDay.create({
      data: {
        userId: user.id,
        localDate: new Date("2026-07-10T00:00:00.000Z"),
        firstActivityAt: old31,
        lastActivityAt: old31,
        messageCount: 1,
      },
    });
    await prisma.conversationMessage.create({
      data: { userPromptId: session.id, role: "user", content: "private transcript", createdAt: old31 },
    });
    const response = await prisma.userResponse.create({
      data: {
        userId: user.id,
        userPromptId: session.id,
        voiceFileId: "private-voice",
        transcript: "private transcript",
        analysis: "{\"overallScore\":8}",
        generationStatus: "generated",
        generationRequestKey: `rollout-${randomUUID()}`,
        generationAttemptedAt: old31,
        generatedAt: old31,
        analysisVersion: 1,
        analysisKind: "model",
        overallScore: 8,
        reportDeliveredAt: old31,
        createdAt: old31,
      },
    });
    await prisma.aiProviderCall.create({
      data: {
        userId: user.id,
        userPromptId: session.id,
        userResponseId: response.id,
        operation: "analysis",
        provider: "cloud.ru",
        model: "rollout-model",
        attempt: 1,
        outcome: "succeeded",
        latencyMs: 10,
        responseContent: "private provider response",
        createdAt: old31,
      },
    });

    const retainedBroadcast = await prisma.broadcast.create({
      data: {
        content: "private announcement",
        filters: {},
        mode: "immediate",
        scheduledAt: old91,
        status: "completed",
        totalRecipients: 1,
        sentCount: 1,
        terminalAt: old91,
        createdById: "rollout-gate",
        createdByUsername: "rollout-gate",
        createdAt: old91,
        recipients: {
          create: {
            userId: user.id,
            telegramIdSnapshot: user.telegramId,
            usernameSnapshot: user.username,
            languageLevelSnapshot: user.languageLevel,
            dailyPromptEnabledSnapshot: user.dailyPromptEnabled,
            announcementEnabledSnapshot: user.announcementEnabled,
            status: "sent",
            attemptCount: 1,
            deliveryAttemptedAt: old91,
            sentAt: old91,
            createdAt: old91,
          },
        },
      },
    });
    const deletedBroadcast = await prisma.broadcast.create({
      data: {
        content: "expired aggregate",
        filters: {},
        mode: "immediate",
        scheduledAt: old366,
        status: "completed",
        terminalAt: old366,
        createdById: "rollout-gate",
        createdByUsername: "rollout-gate",
        createdAt: old366,
      },
    });
    const audit = await prisma.adminAuditLog.create({
      data: {
        actorId: "rollout-gate",
        actorUsername: "rollout-gate",
        action: "prompt.create",
        entityType: "prompt",
        entityId: prompt.id,
        outcome: "success",
        requestId: "rollout-retention",
        correlationId: "rollout-retention",
        after: { hasTextContent: true },
        createdAt: old366,
      },
    });

    const retention = new DataRetentionService(prisma, {
      retention: { closedConversationContentDays: 30, rateLimitDays: 30, errorLogsDays: 30 },
    });
    const result = await retention.cleanup(now);
    assert.equal(result.aiProviderCalls, 1);
    assert.equal(result.conversationMessages, 1);
    assert.equal(result.userResponses, 1);
    assert.equal(result.broadcastRecipients, 1);
    assert.equal(result.broadcasts, 1);
    assert.equal(result.adminAuditLogs, 1);

    const purgedSession = await prisma.userPrompt.findUniqueOrThrow({ where: { id: session.id } });
    const purgedResponse = await prisma.userResponse.findUniqueOrThrow({ where: { id: response.id } });
    assert.equal(purgedSession.firstUserMessageAt.toISOString(), old31.toISOString());
    assert.equal(purgedResponse.overallScore, 8);
    assert.equal(purgedResponse.reportDeliveredAt.toISOString(), old31.toISOString());
    assert.equal(purgedResponse.transcript, null);
    assert.equal(purgedResponse.analysis, null);
    assert.equal(await prisma.userActivityDay.count({ where: { userId: user.id } }), 1);
    assert.equal(await prisma.aiProviderCall.count({ where: { userPromptId: session.id } }), 0);
    assert.equal((await prisma.broadcast.findUniqueOrThrow({ where: { id: retainedBroadcast.id } })).content, null);
    assert.equal(await prisma.broadcastRecipient.count({ where: { broadcastId: retainedBroadcast.id } }), 0);
    assert.equal(await prisma.broadcast.count({ where: { id: deletedBroadcast.id } }), 0);
    assert.equal(await prisma.adminAuditLog.count({ where: { id: audit.id } }), 0);

    const second = await retention.cleanup(now);
    assert.equal(second.aiProviderCalls, 0);
    assert.equal(second.conversationMessages, 0);
    assert.equal(second.userResponses, 0);
    assert.equal(second.broadcastRecipients, 0);
    assert.equal(second.broadcasts, 0);
    assert.equal(second.adminAuditLogs, 0);
    assert.equal(await prisma.conversationMessage.count({ where: { content: "private transcript" } }), 0);
    assert.equal(
      await prisma.aiProviderCall.count({ where: { responseContent: "private provider response" } }),
      0,
    );
    assert.equal(await prisma.broadcast.count({ where: { content: "private announcement" } }), 0);
  });

  await prisma.$disconnect();
});
