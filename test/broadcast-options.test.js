const assert = require("node:assert/strict");
const test = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { AdminBroadcastInputPipe } = require("../dist/modules/admin/admin-broadcast-validation.pipe");
const { broadcastAudienceWhere } = require("../dist/modules/broadcast/broadcast-audience");
const { broadcastSnapshotInsert } = require("../dist/modules/broadcast/broadcast-snapshot");

const NOW = new Date("2026-08-10T10:00:00.000Z");
const FILTERS = { languageLevels: [], activity: "any", dailyPromptEnabled: "any" };
const base = { content: "hello", filters: FILTERS, mode: "immediate" };
const rejects422 = (fn) => assert.throws(fn, (error) => error instanceof UnprocessableEntityException && error.getStatus() === 422);

test("broadcast options accept independent JSON periods and action", () => {
  const result = new AdminBroadcastInputPipe(() => NOW).transform({
    ...base,
    filters: { ...FILTERS, noVoiceForDays: 14, scheduledDeliveryWithinDays: 7 },
    messageAction: "open_schedule",
  });
  assert.equal(result.filters.noVoiceForDays, 14);
  assert.equal(result.filters.scheduledDeliveryWithinDays, 7);
  assert.equal(result.messageAction, "open_schedule");
  for (const value of [0, -1, 1.5, 366, "14", true]) {
    rejects422(() => new AdminBroadcastInputPipe(() => NOW).transform({ ...base, filters: { ...FILTERS, noVoiceForDays: value } }));
  }
  rejects422(() => new AdminBroadcastInputPipe(() => NOW).transform({ ...base, messageAction: "unknown" }));
});

test("new audience conditions compose with legacy filters", () => {
  const filters = { ...FILTERS, noVoiceForDays: 14, scheduledDeliveryWithinDays: 7 };
  const where = broadcastAudienceWhere(filters, NOW);
  assert.deepEqual(where.OR[0], { lastUserMessageAt: null });
  assert.equal(where.OR[1].lastUserMessageAt.lt.toISOString(), "2026-07-27T10:00:00.000Z");
  assert.equal(where.userPrompts.some.source, "scheduled");
  assert.equal(where.userPrompts.some.deliveryStatus, "sent");
  assert.equal(where.userPrompts.some.sentAt.gte.toISOString(), "2026-08-03T10:00:00.000Z");
  const sql = broadcastSnapshotInsert("11111111-1111-4111-8111-111111111111", filters, NOW);
  const text = sql.strings.join("?").replace(/\s+/g, " ");
  assert.match(text, /lastUserMessageAt.*IS NULL OR.*lastUserMessageAt.*</);
  assert.match(text, /EXISTS \( SELECT 1 FROM "user_prompts"/);
  assert.match(text, /"source" = 'scheduled'/);
  assert.match(text, /"deliveryStatus" = 'sent'/);
});

test("saved corrupted new filters fail closed", () => {
  const { normalizeBroadcastFilters } = require("../dist/modules/broadcast/broadcast-audience");
  assert.throws(() => normalizeBroadcastFilters({ ...FILTERS, noVoiceForDays: "14" }), /Invalid saved broadcast filter/);
  assert.deepEqual(normalizeBroadcastFilters(FILTERS), FILTERS);
});
