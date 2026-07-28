require("ts-node/register/transpile-only");

const assert = require("node:assert/strict");
const test = require("node:test");
const { seedDatabase } = require("../prisma/seed");

function createPrismaMock() {
  const prompts = new Map();
  const admins = new Map();
  let adminCreateCount = 0;

  return {
    prompt: {
      findFirst: async ({ where }) => {
        const prompt = prompts.get(where.topic);
        return prompt ? { id: prompt.id } : null;
      },
      create: async ({ data }) => {
        const prompt = { id: `prompt-${prompts.size + 1}`, ...data };
        prompts.set(data.topic, prompt);
        return prompt;
      },
    },
    adminUser: {
      findUnique: async ({ where }) => admins.get(where.username) ?? null,
      create: async ({ data }) => {
        adminCreateCount += 1;
        const admin = { id: `admin-${adminCreateCount}`, ...data };
        admins.set(data.username, admin);
        return admin;
      },
    },
    getState: () => ({ prompts, admins, adminCreateCount }),
  };
}

test("database seed works without optional admin credentials", async () => {
  const prisma = createPrismaMock();

  await seedDatabase(prisma, {});

  const state = prisma.getState();
  assert.ok(state.prompts.size > 0);
  assert.equal(state.admins.size, 0);
});

test("database seed rejects partially configured admin credentials", async () => {
  const prisma = createPrismaMock();

  await assert.rejects(
    seedDatabase(prisma, { ADMIN_USERNAME: "admin" }),
    /must be provided together/,
  );

  assert.equal(prisma.getState().prompts.size, 0);
});

test("database seed creates configured admin only once", async () => {
  const prisma = createPrismaMock();
  const env = {
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "strong-password",
  };

  await seedDatabase(prisma, env);
  await seedDatabase(prisma, env);

  const state = prisma.getState();
  assert.equal(state.adminCreateCount, 1);
  assert.equal(state.admins.size, 1);
  assert.match(state.admins.get("admin").passwordHash, /^\$2[aby]\$/);
});
