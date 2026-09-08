const assert = require("node:assert/strict");
const test = require("node:test");
const { AdminPromptsService } = require("../dist/modules/admin/admin-prompts.service");

function subject({ concurrentEdit = false } = {}) {
  let prompt = {
    id: "question-id", topic: "Old question?", textContent: "Metadata",
    audioFileId: "old-file", difficulty: "medium", tags: [],
    isActive: true, sortOrder: 0, createdAt: new Date("2026-09-04"), userPrompts: [],
  };
  const updates = [];
  const auditRecords = [];
  const prisma = { prompt: {
    findUnique: async () => ({ ...prompt }),
    findUniqueOrThrow: async () => ({ ...prompt }),
    update: async (args) => {
      updates.push(args);
      if (concurrentEdit) prompt = { ...prompt, topic: "Concurrent question", audioFileId: "concurrent-audio" };
      if (args.where.topic !== prompt.topic || args.where.audioFileId !== prompt.audioFileId) {
        const error = new Error("record no longer matches");
        error.code = "P2025";
        throw error;
      }
      prompt = { ...prompt, ...Object.fromEntries(Object.entries(args.data).filter(([, value]) => value !== undefined)) };
      return { ...prompt };
    },
  } };
  const audit = {
    runSuccess: async (descriptor, callback) => {
      const record = await callback(prisma);
      auditRecords.push({ descriptor, ...record });
      return record.result;
    },
  };
  return { service: new AdminPromptsService(prisma, audit), updates, auditRecords, current: () => prompt };
}

for (const audioFileId of [undefined, "old-file", "  old-file  "]) {
  test(`changing the question invalidates its previous audio (submitted ID: ${audioFileId})`, async () => {
    const { service, updates, auditRecords } = subject();
    const result = await service.updatePrompt("question-id", { topic: "New question?", audioFileId });
    assert.equal(result.audioFileId, null);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.topic, "New question?");
    assert.equal(updates[0].data.audioFileId, null);
    assert.equal(auditRecords[0].before.hasAudioFileId, true);
    assert.equal(auditRecords[0].after.hasAudioFileId, false);
    assert.equal(JSON.stringify(auditRecords[0].before).includes("Old question?"), false);
  });
}

test("an explicitly supplied new voice is retained alongside an edited question", async () => {
  const { service, updates } = subject();
  const result = await service.updatePrompt("question-id", { topic: "New question?", audioFileId: "new-file" });
  assert.equal(result.audioFileId, "new-file");
  assert.equal(updates.length, 1);
});

for (const change of [
  { topic: "Old question?" }, { tags: ["new-tag"] },
  { textContent: "Updated metadata" }, { isActive: false },
]) {
  test(`non-text change keeps prepared audio: ${Object.keys(change)[0]}`, async () => {
    const { service } = subject();
    const result = await service.updatePrompt("question-id", change);
    assert.equal(result.audioFileId, "old-file");
  });
}

test("an explicit clear or replacement without a topic change still works", async () => {
  const { service } = subject();
  assert.equal((await service.updatePrompt("question-id", { audioFileId: null })).audioFileId, null);
  assert.equal((await service.updatePrompt("question-id", { audioFileId: "replacement" })).audioFileId, "replacement");
});

test("concurrent topic/audio changes are not overwritten and return a conflict", async () => {
  const { service, current, auditRecords } = subject({ concurrentEdit: true });
  await assert.rejects(
    service.updatePrompt("question-id", { topic: "Old question?" }),
    (error) => error.getStatus() === 409,
  );
  assert.equal(current().topic, "Concurrent question");
  assert.equal(current().audioFileId, "concurrent-audio");
  assert.equal(auditRecords.length, 0);
});
