const assert = require("node:assert/strict");
const test = require("node:test");

test("compiled seed artifact loads and runs through CommonJS", async () => {
  const { seedDatabase } = require("../dist-seed/seed.js");
  const prompts = new Map();
  const prisma = {
    prompt: {
      findFirst: async ({ where }) => prompts.get(where.topic) ?? null,
      create: async ({ data }) => {
        const prompt = { id: `prompt-${prompts.size + 1}`, ...data };
        prompts.set(data.topic, prompt);
        return prompt;
      },
    },
  };

  assert.equal(typeof seedDatabase, "function");
  await seedDatabase(prisma, {});
  assert.ok(prompts.size > 0);
});
