const assert = require("node:assert/strict");
const test = require("node:test");
const { RequestMethod, UnprocessableEntityException } = require("@nestjs/common");

const { AdminController } = require("../dist/modules/admin/admin.controller");
const { ADMIN_AUDIT_MUTATION_METADATA } = require("../dist/modules/admin/admin-audit.decorator");
const { AdminPersonalitiesService } = require("../dist/modules/admin/admin-personalities.service");
const {
  AdminCreatePersonalityPipe,
  AdminUpdatePersonalityPipe,
  AdminUpdateAgentPromptRulesPipe,
  AdminUuidPipe,
} = require("../dist/modules/admin/admin-validation.pipe");
const { AuthGuard } = require("../dist/modules/auth");

const IDS = {
  friendly: "11111111-1111-4111-8111-111111111111",
  third: "22222222-2222-4222-8222-222222222222",
};
const NOW = new Date("2026-08-12T10:00:00.000Z");

function personality(overrides = {}) {
  return {
    id: IDS.third,
    key: "third",
    name: "Third personality",
    description: "A dynamic option",
    followUpStylePrompt: "Ask one concise follow-up.",
    analysisStylePrompt: "Return concise JSON analysis.",
    isActive: true,
    isDefault: false,
    sortOrder: 20,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function directAudit(tx, mutations = []) {
  return {
    runSuccess: async (descriptor, callback) => {
      const mutation = await callback(tx);
      mutations.push({ descriptor, mutation });
      return mutation.result;
    },
  };
}

function rejects422(callback) {
  assert.throws(callback, (error) =>
    error instanceof UnprocessableEntityException && error.getStatus() === 422);
}

function routePipes(methodName) {
  const metadata = Reflect.getMetadata("__routeArguments__", AdminController, methodName) ?? {};
  return Object.values(metadata).flatMap((argument) => argument.pipes ?? []);
}

test("personality DTO validation is strict, normalized, bounded, and allows multiline prompts", () => {
  const create = new AdminCreatePersonalityPipe();
  assert.deepEqual(create.transform({
    key: "third_personality",
    name: "  Third personality  ",
    description: "  Optional description  ",
    followUpStylePrompt: "  First line\nSecond line\t ",
    analysisStylePrompt: "  Analyze\nReturn JSON  ",
    isActive: false,
    sortOrder: 2_147_483_647,
  }), {
    key: "third_personality",
    name: "Third personality",
    description: "Optional description",
    followUpStylePrompt: "First line\nSecond line",
    analysisStylePrompt: "Analyze\nReturn JSON",
    isActive: false,
    sortOrder: 2_147_483_647,
  });

  const update = new AdminUpdatePersonalityPipe();
  assert.deepEqual(update.transform({ followUpStylePrompt: "  Replacement\nPrompt  " }), {
    followUpStylePrompt: "Replacement\nPrompt",
  });

  for (const body of [
    [], {},
    { key: "Upper", name: "Name", followUpStylePrompt: "F", analysisStylePrompt: "A" },
    { key: "-bad", name: "Name", followUpStylePrompt: "F", analysisStylePrompt: "A" },
    { key: "x".repeat(33), name: "Name", followUpStylePrompt: "F", analysisStylePrompt: "A" },
    { key: "valid", name: " ", followUpStylePrompt: "F", analysisStylePrompt: "A" },
    { key: "valid", name: "Name", followUpStylePrompt: "", analysisStylePrompt: "A" },
    { key: "valid", name: "Name", followUpStylePrompt: "F", analysisStylePrompt: "x".repeat(8001) },
    { key: "valid", name: "Name", followUpStylePrompt: "bad\u0000prompt", analysisStylePrompt: "A" },
    { key: "valid", name: "Name", followUpStylePrompt: "F", analysisStylePrompt: "A", isActive: "yes" },
    { key: "valid", name: "Name", followUpStylePrompt: "F", analysisStylePrompt: "A", sortOrder: -1 },
    { key: "valid", name: "Name", followUpStylePrompt: "F", analysisStylePrompt: "A", unknown: true },
  ]) rejects422(() => create.transform(body));

  for (const body of [{}, { key: "renamed" }, { isActive: false }, { name: "x", unknown: true }]) {
    rejects422(() => update.transform(body));
  }
  const rules = new AdminUpdateAgentPromptRulesPipe();
  assert.deepEqual(rules.transform({ followUpPrompt: "  Shared follow-up\nRules  ", analysisPrompt: "  Shared analysis\nRules  " }), { followUpPrompt: "Shared follow-up\nRules", analysisPrompt: "Shared analysis\nRules" });
  for (const body of [{}, { followUpPrompt: "F" }, { analysisPrompt: "A" }, { followUpPrompt: "F", analysisPrompt: "A", unknown: true }]) rejects422(() => rules.transform(body));
});

test("list projects selectedUsersCount and preserves stable database ordering", async () => {
  let query;
  const row = personality({ _count: { users: 7 } });
  const service = new AdminPersonalitiesService({ agentPersonality: {
    findMany: async (candidate) => { query = candidate; return [row]; },
  } }, {});

  assert.deepEqual(await service.list(), [{ ...personality(), selectedUsersCount: 7 }]);
  assert.deepEqual(query, {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: { _count: { select: { users: true } } },
  });
});

test("create and activation enforce the 20-active cap while inactive create remains allowed", async () => {
  const tx = {
    $queryRaw: async () => [],
    agentPersonality: {
      count: async () => 20,
      create: async ({ data }) => ({ ...personality(data), _count: { users: 0 } }),
      findUnique: async () => personality({ isActive: false }),
    },
  };
  const service = new AdminPersonalitiesService({}, directAudit(tx));
  const activeDto = { key: "third", name: "Third", followUpStylePrompt: "Follow", analysisStylePrompt: "Analyze" };

  await assert.rejects(service.create(activeDto), (error) => error.getStatus() === 409);
  await assert.rejects(service.activate(IDS.third), (error) => error.getStatus() === 409);
  await assert.rejects(service.setDefault(IDS.third), (error) => error.getStatus() === 409);
  assert.equal((await service.create({ ...activeDto, isActive: false })).isActive, false);
});

test("setDefault locks, activates its target, and flips defaults atomically", async () => {
  const calls = [];
  let row = personality({ isActive: false });
  const tx = {
    $queryRaw: async () => { calls.push("lock"); return []; },
    agentPersonality: {
      findUnique: async () => { calls.push("find-target"); return row; },
      count: async () => { calls.push("count-active"); return 19; },
      updateMany: async (args) => { calls.push(["clear-default", args]); return { count: 1 }; },
      update: async ({ data }) => { calls.push(["set-target", data]); row = { ...row, ...data }; return row; },
      findUniqueOrThrow: async () => { calls.push("read-result"); return { ...row, _count: { users: 3 } }; },
    },
  };
  const mutations = [];
  const result = await new AdminPersonalitiesService({}, directAudit(tx, mutations)).setDefault(IDS.third);

  assert.equal(result.isActive, true);
  assert.equal(result.isDefault, true);
  assert.equal(result.selectedUsersCount, 3);
  assert.deepEqual(calls, [
    "lock", "find-target", "count-active",
    ["clear-default", { where: { isDefault: true }, data: { isDefault: false } }],
    ["set-target", { isActive: true, isDefault: true }],
    "read-result",
  ]);
  assert.deepEqual(mutations[0].descriptor, { action: "personality.set_default", entityType: "personality" });
});

test("deactivation rejects the default and reassigns nondefault users before marking it inactive", async () => {
  const defaultRow = personality({ id: IDS.friendly, key: "friendly", isDefault: true });
  const defaultTx = {
    $queryRaw: async () => [],
    agentPersonality: { findUnique: async () => defaultRow },
  };
  await assert.rejects(
    new AdminPersonalitiesService({}, directAudit(defaultTx)).deactivate(IDS.friendly),
    (error) => error.getStatus() === 422,
  );

  const calls = [];
  let row = personality();
  const tx = {
    $queryRaw: async () => { calls.push("lock"); return []; },
    agentPersonality: {
      findUnique: async () => { calls.push("find-target"); return row; },
      findFirst: async (query) => { calls.push(["find-default", query]); return defaultRow; },
      update: async ({ data }) => { calls.push(["deactivate", data]); row = { ...row, ...data }; return row; },
      findUniqueOrThrow: async () => { calls.push("read-result"); return { ...row, _count: { users: 0 } }; },
    },
    user: {
      updateMany: async (query) => { calls.push(["reassign", query]); return { count: 4 }; },
    },
  };
  const mutations = [];
  const result = await new AdminPersonalitiesService({}, directAudit(tx, mutations)).deactivate(IDS.third);
  assert.equal(result.isActive, false);
  assert.deepEqual(calls.slice(0, 5), [
    "lock", "find-target",
    ["find-default", { where: { isDefault: true, isActive: true } }],
    ["reassign", { where: { agentTone: "third" }, data: { agentTone: "friendly" } }],
    ["deactivate", { isActive: false }],
  ]);
  assert.equal(mutations[0].mutation.after.reassignedUserCount, 4);
});

test("all mutating operations return 404 for missing personality rows", async () => {
  for (const method of ["update", "activate", "deactivate", "setDefault"]) {
    const tx = {
      $queryRaw: async () => [],
      agentPersonality: { findUnique: async () => null },
    };
    const service = new AdminPersonalitiesService({}, directAudit(tx));
    await assert.rejects(
      method === "update" ? service.update(IDS.third, { name: "New" }) : service[method](IDS.third),
      (error) => error.getStatus() === 404,
      method,
    );
  }
});

test("audit snapshots never contain personality names, descriptions, or prompts", async () => {
  const sensitive = {
    name: "SECRET NAME", description: "SECRET DESCRIPTION",
    followUpStylePrompt: "SECRET FOLLOWUP", analysisStylePrompt: "SECRET ANALYSIS",
  };
  const before = personality(sensitive);
  const after = { ...before, ...Object.fromEntries(Object.entries(sensitive).map(([key, value]) => [key, `${value} UPDATED`])), _count: { users: 2 } };
  const tx = { agentPersonality: {
    findUnique: async () => before,
    update: async () => after,
  } };
  const mutations = [];
  await new AdminPersonalitiesService({}, directAudit(tx, mutations)).update(IDS.third, {
    name: after.name, description: after.description,
    followUpStylePrompt: after.followUpStylePrompt, analysisStylePrompt: after.analysisStylePrompt,
  });

  const auditSnapshots = {
    before: mutations[0].mutation.before,
    after: mutations[0].mutation.after,
  };
  const serialized = JSON.stringify(auditSnapshots);
  for (const value of [...Object.values(sensitive), ...Object.values(sensitive).map((value) => `${value} UPDATED`)]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.deepEqual(mutations[0].mutation.after.changedFields.sort(), ["analysisStylePrompt", "description", "followUpStylePrompt", "name"]);
});

test("admin controller exposes personality and shared-rules routes with validators and audit decorators", () => {
  assert.ok((Reflect.getMetadata("__guards__", AdminController) ?? []).includes(AuthGuard));
  const routes = Object.getOwnPropertyNames(AdminController.prototype).flatMap((name) => {
    const handler = AdminController.prototype[name];
    const path = Reflect.getMetadata("path", handler);
    const method = Reflect.getMetadata("method", handler);
    return typeof path === "string" && path.startsWith("personalities") ? [[name, method, path]] : [];
  });
  assert.deepEqual(routes.map(([, method, path]) => [method, path]).sort((a, b) => a[1].localeCompare(b[1])), [
    [RequestMethod.GET, "personalities"],
    [RequestMethod.POST, "personalities"],
    [RequestMethod.PATCH, "personalities/:id"],
    [RequestMethod.POST, "personalities/:id/activate"],
    [RequestMethod.POST, "personalities/:id/deactivate"],
    [RequestMethod.POST, "personalities/:id/set-default"],
    [RequestMethod.GET, "personalities/rules"],
    [RequestMethod.PATCH, "personalities/rules"],
  ].sort((a, b) => a[1].localeCompare(b[1])));
  assert.ok(routePipes("createPersonality").includes(AdminCreatePersonalityPipe));
  assert.ok(routePipes("updatePersonality").includes(AdminUpdatePersonalityPipe));
  assert.ok(routePipes("updatePersonalityRules").includes(AdminUpdateAgentPromptRulesPipe));
  for (const name of ["updatePersonality", "activatePersonality", "deactivatePersonality", "setDefaultPersonality"]) {
    assert.ok(routePipes(name).includes(AdminUuidPipe));
  }
  for (const [name, action] of [
    ["createPersonality", "personality.create"], ["updatePersonality", "personality.update"],
    ["activatePersonality", "personality.activate"], ["deactivatePersonality", "personality.deactivate"],
    ["setDefaultPersonality", "personality.set_default"],
    ["updatePersonalityRules", "personality.rules.update"],
  ]) {
    assert.deepEqual(Reflect.getMetadata(ADMIN_AUDIT_MUTATION_METADATA, AdminController.prototype[name]), {
      action, entityType: "personality",
    });
  }
});
