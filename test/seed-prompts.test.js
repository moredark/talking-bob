require("ts-node/register/transpile-only");

const assert = require("node:assert/strict");
const test = require("node:test");
const { seedPrompts } = require("../prisma/seed-prompts");

test("prompt seed is repeatable and creates prompts without audio", async () => {
  const storedPrompts = new Map();
  const prisma = {
    prompt: {
      findFirst: async ({ where }) => {
        const prompt = storedPrompts.get(where.topic);
        return prompt ? { id: prompt.id } : null;
      },
      create: async ({ data }) => {
        const prompt = {
          id: `prompt-${storedPrompts.size + 1}`,
          ...data,
        };
        storedPrompts.set(data.topic, prompt);
        return prompt;
      },
    },
  };

  await seedPrompts(prisma);
  const sizeAfterFirstRun = storedPrompts.size;
  await seedPrompts(prisma);

  assert.ok(sizeAfterFirstRun > 0);
  assert.equal(storedPrompts.size, sizeAfterFirstRun);
  assert.ok(
    [...storedPrompts.values()].every(
      (prompt) => prompt.audioFileId === null,
    ),
  );
});
