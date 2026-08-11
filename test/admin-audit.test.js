const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { NotFoundException } = require("@nestjs/common");
const { firstValueFrom, Observable } = require("rxjs");
const { Reflector } = require("@nestjs/core");
const { AdminAuditContextService } = require("../dist/modules/admin/admin-audit-context.service");
const { ADMIN_AUDIT_MUTATION_METADATA } = require("../dist/modules/admin/admin-audit.decorator");
const { AdminController } = require("../dist/modules/admin/admin.controller");
const { AdminAuditInterceptor } = require("../dist/modules/admin/admin-audit.interceptor");
const { AdminErrorLogsService } = require("../dist/modules/admin/admin-error-logs.service");
const { AdminAuditService, AdminAuditWriteError } = require("../dist/modules/admin/admin-audit.service");
const { AdminAuditLogsQueryPipe } = require("../dist/modules/admin/admin-validation.pipe");

const IDS = {
  audit: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  actor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  prompt: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const NOW = new Date("2026-08-10T12:00:00.000Z");

function contextWithActor() {
  const context = new AdminAuditContextService();
  const value = context.create({
    actorId: IDS.actor,
    actorUsername: "admin",
    requestId: "request-42",
    correlationId: "correlation-42",
  });
  return { context, value };
}

test("audit query validation is strict and models [from,to) UTC filters", () => {
  const pipe = new AdminAuditLogsQueryPipe();
  const query = pipe.transform({
    page: "2", limit: "25", actorId: ` ${IDS.actor} `, action: "prompt.update",
    entityType: "prompt", entityId: IDS.prompt, outcome: "success",
    from: "2026-08-01T00:00:00.000Z", to: "2026-08-10T00:00:00Z",
  });
  assert.equal(query.page, 2);
  assert.equal(query.limit, 25);
  assert.equal(query.actorId, IDS.actor);
  assert.equal(query.from.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(query.to.toISOString(), "2026-08-10T00:00:00.000Z");
  for (const invalid of [
    { action: "secret.read" }, { entityType: "session" }, { outcome: "pending" },
    { actorId: "bad value" }, { from: "2026-08-01" }, { from: "2026-02-31T00:00:00Z" },
    { from: "2026-08-10T00:00:00Z", to: "2026-08-10T00:00:00Z" }, { sort: "desc" },
  ]) assert.throws(() => pipe.transform(invalid), (error) => error.getStatus() === 422);
});

test("success writer uses one callback transaction and stores only approved snapshots", async () => {
  const creates = [];
  const tx = { adminAuditLog: { create: async (args) => { creates.push(args); return args.data; } } };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const { context, value } = contextWithActor();
  const audit = new AdminAuditService(prisma, context);

  const result = await context.run(value, () => audit.runSuccess(
    { action: "prompt.update", entityType: "prompt" },
    async (receivedTx) => {
      assert.equal(receivedTx, tx);
      return {
        result: "ok",
        entityId: IDS.prompt,
        before: { difficulty: "easy", topic: "private topic", textContent: "private", audioFileId: "provider-file" },
        after: { difficulty: "hard", tags: ["grammar"], isActive: true, sortOrder: 4, hasTextContent: true, hasAudioFileId: true, token: "secret" },
      };
    },
  ));

  assert.equal(result, "ok");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].data, {
    actorId: IDS.actor,
    actorUsername: "admin",
    action: "prompt.update",
    entityType: "prompt",
    entityId: IDS.prompt,
    outcome: "success",
    requestId: "request-42",
    correlationId: "correlation-42",
    before: { difficulty: "easy" },
    after: { difficulty: "hard", tags: ["grammar"], isActive: true, sortOrder: 4, hasTextContent: true, hasAudioFileId: true },
    failureCode: null,
  });
  assert.doesNotMatch(JSON.stringify(creates), /private|provider-file|token|secret/);
});

test("audit write failure rolls back callback mutation and is classified separately", async () => {
  const businessRows = [];
  const prisma = {
    $transaction: async (callback) => {
      const start = businessRows.length;
      try {
        return await callback({ adminAuditLog: { create: async () => { throw new Error("audit unavailable"); } } });
      } catch (error) {
        businessRows.splice(start);
        throw error;
      }
    },
  };
  const { context, value } = contextWithActor();
  const audit = new AdminAuditService(prisma, context);
  await assert.rejects(
    context.run(value, () => audit.runSuccess(
      { action: "prompt.create", entityType: "prompt" },
      async () => {
        businessRows.push(IDS.prompt);
        return { result: true, entityId: IDS.prompt };
      },
    )),
    (error) => error instanceof AdminAuditWriteError,
  );
  assert.deepEqual(businessRows, []);
});

test("failure writer records one sanitized failure and never replaces the original error", async () => {
  const creates = [];
  const { context, value } = contextWithActor();
  const audit = new AdminAuditService({ adminAuditLog: { create: async (args) => { creates.push(args); return args.data; } } }, context);
  await context.run(value, () => audit.writeFailureBestEffort({
    action: "user.update", entityType: "user", entityId: IDS.actor,
    error: new NotFoundException("private diagnostic"),
  }));
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].data, {
    actorId: IDS.actor, actorUsername: "admin", action: "user.update", entityType: "user",
    entityId: IDS.actor, outcome: "failure", requestId: "request-42",
    correlationId: "correlation-42", failureCode: "not_found",
  });
  assert.doesNotMatch(JSON.stringify(creates), /private diagnostic/);

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const unavailable = new AdminAuditService({ adminAuditLog: { create: async () => { throw new Error("storage secret"); } } }, context);
    await assert.doesNotReject(context.run(value, () => unavailable.writeFailureBestEffort({
      action: "prompt.delete", entityType: "prompt", entityId: IDS.prompt, error: new Error("original"),
    })));
  } finally {
    console.error = originalConsoleError;
  }
});

test("audit interceptor snapshots JWT actor, echoes normalized IDs, and audits one failure", async () => {
  const { context } = contextWithActor();
  const failures = [];
  const audit = { writeFailureBestEffort: (input) => { failures.push({ input, current: context.current() }); return new Promise(() => {}); } };
  const interceptor = new AdminAuditInterceptor(context, audit, new Reflector());
  const responseHeaders = {};
  const original = new NotFoundException("private");
  const execution = {
    getHandler: () => AdminController.prototype.updateUser,
    switchToHttp: () => ({
      getRequest: () => ({
        admin: { sub: IDS.actor, username: " admin " },
        headers: { "x-request-id": "bad request id", "x-correlation-id": " trace-42 " },
        params: { id: IDS.actor },
      }),
      getResponse: () => ({ setHeader: (name, value) => { responseHeaders[name] = value; } }),
    }),
  };
  const next = { handle: () => new Observable((subscriber) => subscriber.error(original)) };
  const propagated = await Promise.race([
    firstValueFrom(interceptor.intercept(execution, next)).catch((error) => error),
    new Promise((resolve) => setImmediate(() => resolve("audit-delayed-error"))),
  ]);
  assert.equal(propagated, original);

  assert.match(responseHeaders["x-request-id"], /^admin-request-[0-9a-f-]{36}$/);
  assert.equal(responseHeaders["x-correlation-id"], "trace-42");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].input.action, "user.update");
  assert.equal(failures[0].input.error, original);
  assert.deepEqual(failures[0].current, {
    actorId: IDS.actor, actorUsername: "admin",
    requestId: responseHeaders["x-request-id"], correlationId: "trace-42",
  });
});

test("all ten and only ten admin mutations map to audit actions", () => {
  const reflector = new Reflector();
  const decorated = [];
  const mappings = [
    ["updateUser", "user.update", "user"],
    ["resetUserProgress", "user.reset_progress", "user"],
    ["createPrompt", "prompt.create", "prompt"],
    ["updatePrompt", "prompt.update", "prompt"],
    ["deletePrompt", "prompt.delete", "prompt"],
    ["clearOldErrorLogs", "error_log.clear_old", "error_log"],
    ["updateProductSettings", "settings.product.update", "runtime_settings"],
    ["updateInfrastructureSettings", "settings.infrastructure.update", "runtime_settings"],
    ["createBroadcast", "broadcast.create", "broadcast"],
    ["cancelBroadcast", "broadcast.cancel", "broadcast"],
  ];
  const mutationSources = [
    "src/modules/admin/admin-users.service.ts",
    "src/modules/admin/admin-prompts.service.ts",
    "src/modules/admin/admin-error-logs.service.ts",
    "src/modules/admin/admin-settings.service.ts",
    "src/modules/admin/admin-broadcasts.service.ts",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  for (const [handler, action, entityType] of mappings) {
    const metadata = reflector.get(ADMIN_AUDIT_MUTATION_METADATA, AdminController.prototype[handler]);
    assert.deepEqual(metadata, { action, entityType });
    decorated.push(handler);
    if (action.startsWith("settings.") || action.startsWith("broadcast.")) {
      assert.match(mutationSources, new RegExp(`"${action}"`));
      assert.match(mutationSources, /runSuccess\(/);
    } else {
      assert.match(mutationSources, new RegExp(`runSuccess\\(\\{ action: "${action}", entityType: "${entityType}" \\}`));
  }
  }
  assert.equal(reflector.get(ADMIN_AUDIT_MUTATION_METADATA, AdminController.prototype.getAuditLogs), undefined);
  assert.equal(decorated.length, 10);
  assert.equal((readFileSync("src/modules/admin/admin.controller.ts", "utf8").match(/@AdminAuditMutation\(/g) ?? []).length, 10);
  assert.doesNotMatch(mutationSources, /if \(!this\.audit\)|@Optional\(\).*audit/);
  const controller = readFileSync("src/modules/admin/admin.controller.ts", "utf8");
  assert.doesNotMatch(controller, /@(Patch|Delete)\("audit-logs/);
});

test("audit list applies exact filters, half-open dates, and stable ordering", async () => {
  let findArgs;
  const row = {
    id: IDS.audit, actorId: IDS.actor, actorUsername: "admin", action: "prompt.update",
    entityType: "prompt", entityId: IDS.prompt, outcome: "success", requestId: "request-42",
    correlationId: "correlation-42", before: null, after: null, failureCode: null, createdAt: NOW,
  };
  const prisma = { adminAuditLog: {
    findMany: async (args) => { findArgs = args; return [row]; },
    count: async () => 1,
    findUnique: async () => row,
  } };
  const audit = new AdminAuditService(prisma, new AdminAuditContextService());
  const from = new Date("2026-08-01T00:00:00.000Z");
  const to = new Date("2026-08-11T00:00:00.000Z");
  const result = await audit.getLogs({ page: 2, limit: 10, actorId: IDS.actor, action: "prompt.update", entityType: "prompt", entityId: IDS.prompt, outcome: "success", from, to });
  assert.deepEqual(findArgs, {
    where: { actorId: IDS.actor, action: "prompt.update", entityType: "prompt", entityId: IDS.prompt, outcome: "success", createdAt: { gte: from, lt: to } },
    skip: 10, take: 10, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  assert.equal(result.data[0].createdAt.toISOString(), NOW.toISOString());
  assert.equal(result.totalPages, 1);
  assert.deepEqual((await audit.getLogById(IDS.audit)).before, null);
});
test("audit snapshot sanitizer covers user, reset, and error-clear branches", () => {
  const audit = new AdminAuditService({}, new AdminAuditContextService());
  assert.deepEqual(audit.sanitizeSnapshot("user.update", {
    dailyPromptEnabled: false, languageLevel: "C1", status: "banned",
    bannedAt: NOW, hasBannedReason: true, bannedReason: "secret",
  }), {
    dailyPromptEnabled: false, languageLevel: "C1", status: "banned",
    bannedAt: NOW.toISOString(), hasBannedReason: true,
  });
  assert.deepEqual(audit.sanitizeSnapshot("user.reset_progress", {
    reportDeliveryRequests: 1, userActivityDays: 5, conversationMessages: 2, userResponses: 3,
    userPrompts: 4, transcript: "secret",
  }), {
    reportDeliveryRequests: 1, userActivityDays: 5, conversationMessages: 2, userResponses: 3, userPrompts: 4,
  });
  assert.deepEqual(audit.sanitizeSnapshot("error_log.clear_old", {
    cutoff: NOW, days: 30, deletedCount: 5, deletedContent: "secret",
  }), { cutoff: NOW.toISOString(), days: 30, deletedCount: 5 });
});

test("error-log clearing executes in audit transaction with safe metadata", async () => {
  let descriptor;
  let mutation;
  let deleteArgs;
  const tx = { errorLog: { deleteMany: async (args) => { deleteArgs = args; return { count: 7 }; } } };
  const audit = {
    runSuccess: async (input, callback) => {
      descriptor = input;
      mutation = await callback(tx);
      return mutation.result;
    },
  };
  const service = new AdminErrorLogsService({ clearOldLogs: async () => { throw new Error("unaudited"); } }, audit);
  const deleted = await service.clearOldErrorLogs(30);

  assert.equal(deleted, 7);
  assert.deepEqual(descriptor, { action: "error_log.clear_old", entityType: "error_log" });
  assert.equal(mutation.entityId, "old");
  assert.equal(mutation.after.days, 30);
  assert.equal(mutation.after.deletedCount, 7);
  assert.equal(mutation.after.cutoff.toISOString(), deleteArgs.where.createdAt.lt.toISOString());
});

test("success writer can return an explicit transactional no-op without an audit row", async () => {
  const creates = [];
  const prisma = {
    $transaction: async (callback) => callback({ adminAuditLog: { create: async (args) => creates.push(args) } }),
  };
  const audit = new AdminAuditService(prisma, new AdminAuditContextService());

  const result = await audit.runSuccess(
    { action: "user.update", entityType: "user" },
    async () => ({ result: "unchanged", entityId: IDS.actor, skipAudit: true }),
  );

  assert.equal(result, "unchanged");
  assert.deepEqual(creates, []);
});
