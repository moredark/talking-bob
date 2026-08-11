const assert = require("node:assert/strict");
const test = require("node:test");
const { InternalServerErrorException, UnprocessableEntityException } = require("@nestjs/common");
const { AdminController } = require("../dist/modules/admin/admin.controller");
const { AdminErrorLogsService } = require("../dist/modules/admin/admin-error-logs.service");
const { AdminPromptsService } = require("../dist/modules/admin/admin-prompts.service");
const { AdminUsersService } = require("../dist/modules/admin/admin-users.service");
const { AdminExceptionFilter } = require("../dist/modules/admin/admin-exception.filter");
const { AdminAuditLogsQueryPipe, AdminCreatePromptPipe, AdminDaysPipe, AdminErrorLogsQueryPipe, AdminPaginationPipe, AdminUpdatePromptPipe, AdminUpdateUserPipe, AdminUuidPipe } = require("../dist/modules/admin/admin-validation.pipe");
const { ErrorLogService } = require("../dist/modules/error-log/error-log.service");
const { AuthGuard } = require("../dist/modules/auth");
const { ADMIN_IDS, ADMIN_TIMESTAMP, adminAuditHarness, adminUser, errorLog } = require("./support/admin-test-builders");

function rejects422(callback) {
  assert.throws(callback, (error) => error instanceof UnprocessableEntityException && error.getStatus() === 422);
}

function routePipes(methodName) {
  const argumentsMetadata = Reflect.getMetadata("__routeArguments__", AdminController, methodName) ?? {};
  return Object.values(argumentsMetadata).flatMap((argument) => argument.pipes ?? []);
}

function pipeInstance(pipe) {
  return typeof pipe === "function" ? new pipe() : pipe;
}

test("admin controller remains guarded as a whole", () => {
  const guards = Reflect.getMetadata("__guards__", AdminController) ?? [];
  assert.ok(guards.includes(AuthGuard));
});

test("auth guard rejects requests without a Bearer token as 401", async () => {
  const guard = new AuthGuard({ validateToken: async () => ({ sub: "admin" }) });
  const context = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) };
  await assert.rejects(() => guard.canActivate(context), (error) => error.getStatus() === 401);
});

test("admin query validation applies defaults, bounds, allowlists, and stops service dispatch", () => {
  assert.deepEqual(new AdminPaginationPipe(20).transform({}), { page: 1, limit: 20 });
  assert.deepEqual(new AdminErrorLogsQueryPipe().transform({ page: "2", correlationId: "  request.1  " }), { page: 2, limit: 50, type: undefined, service: undefined, correlationId: "request.1" });
  for (const query of [{ page: "0" }, { page: "1000001" }, { limit: "101" }, { limit: "2x" }, { sort: "createdAt" }]) rejects422(() => new AdminPaginationPipe(20).transform(query));
  for (const query of [{ type: "db" }, { service: "postgres" }, { correlationId: "bad value" }, { sort: "desc" }]) rejects422(() => new AdminErrorLogsQueryPipe().transform(query));
  for (const days of ["0", "3651", "1.5"]) rejects422(() => new AdminDaysPipe().transform(days));

  let serviceCalls = 0;
  rejects422(() => {
    const query = new AdminPaginationPipe(20).transform({ limit: "0" });
    serviceCalls += 1;
    return query;
  });
  assert.equal(serviceCalls, 0);
});

test("admin HTTP decorators attach the intended validators and preserve correlation dispatch", () => {
  const usersQuery = routePipes("getUsers").map(pipeInstance).find((pipe) => pipe instanceof AdminPaginationPipe);
  const errorLogsQuery = routePipes("getErrorLogs").map(pipeInstance).find((pipe) => pipe instanceof AdminErrorLogsQueryPipe);
  const auditLogsQuery = routePipes("getAuditLogs").map(pipeInstance).find((pipe) => pipe instanceof AdminAuditLogsQueryPipe);
  assert.deepEqual(usersQuery.transform({}), { page: 1, limit: 20 });
  assert.ok(routePipes("getUserById").includes(AdminUuidPipe));
  assert.ok(routePipes("createPrompt").includes(AdminCreatePromptPipe));
  assert.ok(routePipes("updatePrompt").includes(AdminUpdatePromptPipe));
  assert.ok(routePipes("updateUser").includes(AdminUpdateUserPipe));
  assert.ok(routePipes("clearOldErrorLogs").includes(AdminDaysPipe));
  assert.ok(routePipes("getAuditLogById").includes(AdminUuidPipe));
  assert.equal(auditLogsQuery.transform({}).limit, 50);
  rejects422(() => usersQuery.transform({ unknown: "value" }));
  rejects422(() => errorLogsQuery.transform({ sort: "desc" }));

  const calls = [];
  const controller = new AdminController({
    getErrorLogs: (...args) => {
      calls.push(args);
      return "dispatched";
    },
  });
  const query = errorLogsQuery.transform({
    page: "3",
    limit: "7",
    type: "system",
    service: "general",
    correlationId: " trace-42 ",
  });
  assert.equal(controller.getErrorLogs(query), "dispatched");
  assert.deepEqual(calls, [[3, 7, "system", "general", "trace-42"]]);
});

test("admin body and UUID validation reject unknown, empty, malformed, and cross-field input", () => {
  assert.equal(new AdminUuidPipe().transform(ADMIN_IDS.user), ADMIN_IDS.user);
  rejects422(() => new AdminUuidPipe().transform("not-a-uuid"));
  const create = new AdminCreatePromptPipe().transform({ topic: "  Travel  ", audioFileId: "  file-1  ", difficulty: "easy", tags: ["fluency"] });
  assert.equal(create.topic, "Travel");
  assert.equal(create.audioFileId, "file-1");
  assert.equal(new AdminCreatePromptPipe().transform({ topic: "x", sortOrder: 2_147_483_647 }).sortOrder, 2_147_483_647);
  rejects422(() => new AdminCreatePromptPipe().transform({ topic: "x", sortOrder: 2_147_483_648 }));
  rejects422(() => new AdminUpdatePromptPipe().transform({ sortOrder: 2_147_483_648 }));
  for (const body of [[], {}, { topic: "x", unknown: true }, { topic: " ", tags: [] }, { topic: "x", tags: ["grammar", "grammar"] }, { topic: "x", difficulty: "expert" }, { topic: "x", sortOrder: -1 }]) rejects422(() => new AdminCreatePromptPipe().transform(body));
  rejects422(() => new AdminUpdatePromptPipe().transform({}));
  rejects422(() => new AdminUpdateUserPipe().transform({}));
  rejects422(() => new AdminUpdateUserPipe().transform({ bannedReason: "reason" }));
  assert.deepEqual(new AdminUpdateUserPipe().transform({ status: "banned", bannedReason: "  reason  " }), { status: "banned", bannedReason: "reason" });
});

test("user and prompt services request deterministic ordering and expose moderation fields", async () => {
  const userFinds = [];
  const user = adminUser({ _count: { userPrompts: 1, userResponses: 1 }, userResponses: [{ analysis: '{"overallScore":8}', createdAt: new Date(ADMIN_TIMESTAMP) }] });
  const usersPrisma = { user: { findMany: async (args) => { userFinds.push(args); return [user]; }, count: async () => 1, findUnique: async (args) => { userFinds.push(args); return user; } } };
  const users = new AdminUsersService(usersPrisma, adminAuditHarness(usersPrisma));
  const list = await users.getUsers(1, 20);
  const detail = await users.getUserById(ADMIN_IDS.user);
  assert.deepEqual(userFinds[0].orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(userFinds[0].include.userResponses.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(userFinds[1].select.userResponses.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(userFinds[1].select.userResponses.select, { analysis: true, createdAt: true });
  assert.equal("responses" in detail, false);
  assert.equal(list.data[0].createdAt.toISOString(), ADMIN_TIMESTAMP);
  assert.deepEqual({ languageLevel: detail.languageLevel, status: detail.status, bannedAt: detail.bannedAt, bannedReason: detail.bannedReason }, { languageLevel: "B1", status: "active", bannedAt: null, bannedReason: null });

  let promptOrder;
  const promptsPrisma = { prompt: { findMany: async (args) => { promptOrder = args.orderBy; return []; }, count: async () => 0 } };
  const prompts = new AdminPromptsService(promptsPrisma, adminAuditHarness(promptsPrisma));
  await prompts.getPrompts(1, 20);
  assert.deepEqual(promptOrder, [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "desc" }]);
});

test("unchanged user updates return detail without a write or audit entry", async () => {
  const existing = adminUser({
    languageLevel: null,
    _count: { userPrompts: 1, userResponses: 0 },
    userResponses: [],
  });
  let writes = 0;
  let auditCalls = 0;
  const prisma = {
    user: {
      findUnique: async () => existing,
      findUniqueOrThrow: async () => {
        throw new Error("no-op update must not enter an audit transaction");
      },
      update: async () => {
        writes += 1;
        throw new Error("no-op update must not write the user");
      },
    },
  };
  const audit = {
    runSuccess: async () => {
      auditCalls += 1;
      throw new Error("no-op update must not create user.update audit entry");
    },
  };
  const service = new AdminUsersService(prisma, audit);

  const result = await service.updateUser(ADMIN_IDS.user, { languageLevel: null });

  assert.equal(result.languageLevel, null);
  assert.equal(result.id, ADMIN_IDS.user);
  assert.equal(writes, 0);
  assert.equal(auditCalls, 0);
});

test("user update becomes an audited no-op when another request already applied the value", async () => {
  const staleUser = adminUser({ languageLevel: "B1" });
  const currentUser = adminUser({
    languageLevel: null,
    _count: { userPrompts: 0, userResponses: 0 },
    userResponses: [],
  });
  let writes = 0;
  let auditEnvelope;
  const transaction = {
    user: {
      findUniqueOrThrow: async () => currentUser,
      findUnique: async () => currentUser,
      update: async () => {
        writes += 1;
        throw new Error("transactional no-op must not write the user");
      },
    },
  };
  const prisma = { user: { findUnique: async () => staleUser } };
  const audit = {
    runSuccess: async (_descriptor, callback) => {
      auditEnvelope = await callback(transaction);
      return auditEnvelope.result;
    },
  };
  const service = new AdminUsersService(prisma, audit);

  const result = await service.updateUser(ADMIN_IDS.user, { languageLevel: null });

  assert.equal(result.languageLevel, null);
  assert.equal(writes, 0);
  assert.equal(auditEnvelope.skipAudit, true);
  assert.equal(auditEnvelope.before, undefined);
  assert.equal(auditEnvelope.after, undefined);
});

test("user update audit snapshots contain only fields whose values changed", async () => {
  const beforeUser = adminUser({
    dailyPromptEnabled: true,
    languageLevel: null,
    _count: { userPrompts: 0, userResponses: 0 },
    userResponses: [],
  });
  const afterUser = {
    ...beforeUser,
    dailyPromptEnabled: false,
  };
  let auditEnvelope;
  const transaction = {
    user: {
      findUniqueOrThrow: async () => beforeUser,
      update: async () => afterUser,
      findUnique: async () => afterUser,
    },
  };
  const prisma = { user: { findUnique: async () => beforeUser } };
  const audit = {
    runSuccess: async (descriptor, callback) => {
      assert.deepEqual(descriptor, { action: "user.update", entityType: "user" });
      auditEnvelope = await callback(transaction);
      return auditEnvelope.result;
    },
  };
  const service = new AdminUsersService(prisma, audit);

  const result = await service.updateUser(ADMIN_IDS.user, {
    dailyPromptEnabled: false,
    languageLevel: null,
  });

  assert.equal(result.dailyPromptEnabled, false);
  assert.deepEqual(auditEnvelope.before, { dailyPromptEnabled: true });
  assert.deepEqual(auditEnvelope.after, { dailyPromptEnabled: false });
});

test("prompt service preserves direct audioFileId normalization", async () => {
  const writes = [];
  const base = {
    id: ADMIN_IDS.prompt, topic: "Travel", textContent: null, audioFileId: null, difficulty: "medium",
    tags: [], isActive: true, sortOrder: 0, createdAt: new Date(ADMIN_TIMESTAMP), userPrompts: [],
  };
  const promptClient = {
    prompt: {
      findUnique: async () => base,
      findUniqueOrThrow: async () => base,
      create: async (args) => { writes.push(["create", args]); return { ...base, ...args.data }; },
      update: async (args) => { writes.push(["update", args]); return { ...base, ...args.data }; },
    },
  };
  const prompts = new AdminPromptsService(promptClient, adminAuditHarness(promptClient));

  await prompts.createPrompt({ topic: "Travel", audioFileId: "  telegram-file  " });
  await prompts.updatePrompt(ADMIN_IDS.prompt, { audioFileId: "   " });

  assert.equal(writes[0][1].data.audioFileId, "telegram-file");
  assert.equal(writes[1][1].data.audioFileId, null);
});

test("error log queries use a stable tie-breaker and outward mapping removes legacy secrets", async () => {
  let findArgs;
  const rawLog = errorLog();
  const prisma = { errorLog: { findMany: async (args) => { findArgs = args; return [rawLog]; }, count: async () => 1, findUnique: async () => rawLog } };
  const storage = new ErrorLogService(prisma);
  const result = await storage.getLogs({ type: "system", service: "general", correlationId: "request-1", stableOrder: true });
  assert.deepEqual(findArgs.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(findArgs.where, { type: "system", service: "general", correlationId: "request-1" });
  assert.equal(result.total, 1);

  const adminLogs = new AdminErrorLogsService(storage, adminAuditHarness({}));
  const mapped = await adminLogs.getErrorLogById(ADMIN_IDS.errorLog);
  assert.equal(mapped.stack, null);
  assert.equal(mapped.message, "UnknownError");
  assert.deepEqual(mapped.metadata, { schemaVersion: 1, operation: "unknown" });
  assert.doesNotMatch(JSON.stringify(mapped), /provider-secret|sensitive stack|must-not-leak|token/);
  assert.equal(JSON.parse(JSON.stringify(mapped)).createdAt, ADMIN_TIMESTAMP);
});

test("error log outward identifiers and allowlisted metadata values are sanitized", async () => {
  const unsafe = errorLog({
    id: "not-a-uuid", type: "provider-secret", service: "database-secret", operation: "api.token",
    correlationId: "Bearer provider-secret", statusCode: 999, retryable: "true", latencyMs: -1,
    errorKind: "ProviderSecretError", userId: "admin-secret",
    metadata: {
      schemaVersion: 2, operation: "api.token", correlationId: "Bearer metadata-secret",
      telegramUpdateId: "update-42", requestId: "Bearer request-secret", latencyMs: 2_147_483_648,
      statusCode: 600, retryable: "true", errorKind: "ProviderSecretError", code: "provider_secret",
    },
  });
  const service = new AdminErrorLogsService({ getLogById: async () => unsafe }, adminAuditHarness({}));
  const mapped = await service.getErrorLogById(ADMIN_IDS.errorLog);

  assert.deepEqual({
    id: mapped.id, type: mapped.type, service: mapped.service, operation: mapped.operation,
    correlationId: mapped.correlationId, statusCode: mapped.statusCode, retryable: mapped.retryable,
    latencyMs: mapped.latencyMs, errorKind: mapped.errorKind, userId: mapped.userId,
  }, {
    id: "unknown", type: "unknown", service: "unknown", operation: "unknown",
    correlationId: null, statusCode: null, retryable: null, latencyMs: null,
    errorKind: "UnknownError", userId: null,
  });
  assert.deepEqual(mapped.metadata, { telegramUpdateId: "update-42" });
  assert.doesNotMatch(JSON.stringify(mapped), /secret|Bearer|api\.token/i);
});

test("admin exception filter emits only the stable envelope and maps conflicts", () => {
  const bodies = [];
  const host = { switchToHttp: () => ({ getResponse: () => ({ status: (statusCode) => ({ json: (body) => bodies.push({ statusCode, body }) }) }) }) };
  const filter = new AdminExceptionFilter();
  filter.catch(Object.assign(new Error("unique constraint details"), { code: "P2002", meta: { target: "secret" } }), host);
  filter.catch(Object.assign(new Error("missing row details"), { code: "P2025", meta: { cause: "secret" } }), host);
  filter.catch(new InternalServerErrorException("database password leaked"), host);
  filter.catch(new UnprocessableEntityException("sortOrder is out of range"), host);
  filter.catch(new Error("database password leaked"), host);
  assert.deepEqual(bodies[0], { statusCode: 409, body: { statusCode: 409, error: "Conflict", message: "Resource conflict" } });
  assert.deepEqual(bodies[1], { statusCode: 404, body: { statusCode: 404, error: "Not Found", message: "Resource not found" } });
  assert.deepEqual(bodies[2], { statusCode: 500, body: { statusCode: 500, error: "Internal Server Error", message: "Internal server error" } });
  assert.deepEqual(bodies[3], { statusCode: 422, body: { statusCode: 422, error: "Unprocessable Entity", message: "sortOrder is out of range" } });
  assert.deepEqual(bodies[4], { statusCode: 500, body: { statusCode: 500, error: "Internal Server Error", message: "Internal server error" } });
  assert.doesNotMatch(JSON.stringify(bodies), /password|missing row|unique constraint/);
});
test("audit detail controller preserves UUID validation and returns sanitized 404", async () => {
  assert.ok(routePipes("getAuditLogById").includes(AdminUuidPipe));
  const controller = new AdminController({ getAuditLogById: async () => null });
  await assert.rejects(
    () => controller.getAuditLogById(ADMIN_IDS.errorLog),
    (error) => error.getStatus() === 404 && error.message === "Audit log not found",
  );
});
