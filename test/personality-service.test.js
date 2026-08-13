const assert = require("node:assert/strict");
const test = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");

const { PersonalityService } = require("../dist/modules/personality/personality.service");

function prompt(key, overrides = {}) {
  return {
    key,
    followUpStylePrompt: `${key} follow-up`,
    analysisStylePrompt: `${key} analysis`,
    isActive: true,
    ...overrides,
  };
}

test("listActive returns at most 20 active personalities in stable display order", async () => {
  let query;
  const expected = [{ key: "third", name: "Third", description: "Dynamic", isDefault: false }];
  const service = new PersonalityService({
    agentPersonality: {
      findMany: async (candidate) => { query = candidate; return expected; },
    },
  });

  assert.equal(await service.listActive(), expected);
  assert.deepEqual(query, {
    where: { isActive: true },
    take: 20,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { key: true, name: true, description: true, isDefault: true },
  });
});

test("resolveSelectedOrDefault returns the selected active personality without reading the default", async () => {
  const selected = prompt("third");
  let fallbackReads = 0;
  const service = new PersonalityService({ agentPromptRules: { findUnique: async () => ({ followUpPrompt: "Shared follow-up", analysisPrompt: "Shared analysis" }) }, agentPersonality: {
    findUnique: async ({ where, select }) => {
      assert.deepEqual(where, { key: "third" });
      assert.deepEqual(select, { key: true, followUpStylePrompt: true, analysisStylePrompt: true, isActive: true });
      return selected;
    },
    findFirst: async () => { fallbackReads += 1; return prompt("friendly"); },
  } });

  assert.deepEqual(await service.resolveSelectedOrDefault("third"), {
    key: "third", followUpPrompt: "Shared follow-up\nthird follow-up", analysisPrompt: "Shared analysis\nthird analysis",
  });
  assert.equal(fallbackReads, 0);
});

test("resolveSelectedOrDefault falls back for absent, missing, or inactive selections", async (t) => {
  for (const scenario of [
    { name: "absent", key: null, selected: null, expectedSelectedReads: 0 },
    { name: "missing", key: "removed", selected: null, expectedSelectedReads: 1 },
    { name: "inactive", key: "retired", selected: prompt("retired", { isActive: false }), expectedSelectedReads: 1 },
  ]) {
    await t.test(scenario.name, async () => {
      let selectedReads = 0;
      let fallbackQuery;
      const fallback = prompt("friendly");
      const service = new PersonalityService({ agentPromptRules: { findUnique: async () => ({ followUpPrompt: "Shared follow-up", analysisPrompt: "Shared analysis" }) }, agentPersonality: {
        findUnique: async () => { selectedReads += 1; return scenario.selected; },
        findFirst: async (query) => { fallbackQuery = query; return fallback; },
      } });

      assert.deepEqual(await service.resolveSelectedOrDefault(scenario.key), {
        key: "friendly", followUpPrompt: "Shared follow-up\nfriendly follow-up", analysisPrompt: "Shared analysis\nfriendly analysis",
      });
      assert.equal(selectedReads, scenario.expectedSelectedReads);
      assert.deepEqual(fallbackQuery, {
        where: { isDefault: true, isActive: true },
        select: { key: true, followUpStylePrompt: true, analysisStylePrompt: true },
      });
    });
  }
});

test("resolveSelectedOrDefault fails loudly when no active default exists", async () => {
  const service = new PersonalityService({ agentPromptRules: { findUnique: async () => ({ followUpPrompt: "Shared follow-up", analysisPrompt: "Shared analysis" }) }, agentPersonality: {
    findUnique: async () => null,
    findFirst: async () => null,
  } });
  await assert.rejects(service.resolveSelectedOrDefault("missing"), /Active default personality is missing/);
});

test("selectForUser only persists an active personality", async (t) => {
  for (const selected of [null, { isActive: false }]) {
    await t.test(selected === null ? "missing" : "inactive", async () => {
      let updates = 0;
      const service = new PersonalityService({
        agentPersonality: { findUnique: async () => selected },
        user: { update: async () => { updates += 1; } },
      });
      await assert.rejects(
        service.selectForUser("user-1", "third"),
        (error) => error instanceof UnprocessableEntityException && error.getStatus() === 422,
      );
      assert.equal(updates, 0);
    });
  }

  const calls = [];
  const updated = { id: "user-1", agentTone: "third" };
  const service = new PersonalityService({
    agentPersonality: { findUnique: async (query) => { calls.push(["find", query]); return { isActive: true }; } },
    user: { update: async (query) => { calls.push(["update", query]); return updated; } },
  });
  assert.equal(await service.selectForUser("user-1", "third"), updated);
  assert.deepEqual(calls, [
    ["find", { where: { key: "third" }, select: { isActive: true } }],
    ["update", { where: { id: "user-1" }, data: { agentTone: "third" } }],
  ]);
});
