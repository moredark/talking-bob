require("ts-node/register/transpile-only");

const assert = require("node:assert/strict");
const test = require("node:test");
const { seedPersonalities } = require("../prisma/seed-personalities");

test("personality seed is idempotent and never overwrites edited rows", async () => {
  const rows = new Map();
  const calls = [];
  const rules = new Map();
  const prisma = { agentPromptRules: { upsert: async ({ where, update, create }) => {
    calls.push({ where, update, create });
    if (!rules.has(where.id)) rules.set(where.id, { ...create });
    else Object.assign(rules.get(where.id), update);
    return rules.get(where.id);
  } }, agentPersonality: {
    upsert: async ({ where, update, create }) => {
      calls.push({ where, update, create });
      if (!rows.has(where.key)) rows.set(where.key, { ...create });
      else Object.assign(rows.get(where.key), update);
      return rows.get(where.key);
    },
  } };

  await seedPersonalities(prisma);
  assert.deepEqual([...rows.keys()], ["friendly", "playful"]);
  assert.match(rules.get("default").followUpPrompt, /English speaking partner/);
  assert.match(rules.get("default").analysisPrompt, /Return ONLY valid JSON/);
  assert.deepEqual([...rows.values()].map(({ key, isActive, isDefault, sortOrder }) => ({ key, isActive, isDefault, sortOrder })), [
    { key: "friendly", isActive: true, isDefault: true, sortOrder: 0 },
    { key: "playful", isActive: true, isDefault: false, sortOrder: 10 },
  ]);
  assert.equal([...rows.values()].filter(({ isActive, isDefault }) => isActive && isDefault).length, 1);
  assert.match(rows.get("friendly").followUpStylePrompt, /encouraging and warm/i);
  assert.match(rows.get("playful").analysisStylePrompt, /slang/i);

  const editedFriendly = {
    ...rows.get("friendly"),
    name: "Edited by admin",
    description: "Edited description",
    followUpStylePrompt: "Edited follow-up",
    analysisStylePrompt: "Edited analysis",
    sortOrder: 99,
  };
  rows.set("friendly", editedFriendly);
  const editedRules = { ...rules.get("default"), followUpPrompt: "Edited shared follow-up", analysisPrompt: "Edited shared analysis" };
  rules.set("default", editedRules);
  await seedPersonalities(prisma);

  assert.deepEqual(rows.get("friendly"), editedFriendly);
  assert.deepEqual(rules.get("default"), editedRules);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(({ update }) => Object.keys(update).length === 0));
});
