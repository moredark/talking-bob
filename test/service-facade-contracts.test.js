const assert = require("node:assert/strict");
const test = require("node:test");

const responseBarrel = require("../dist/modules/response");
const { ResponseService } = require("../dist/modules/response/response.service");
const scheduleBarrel = require("../dist/modules/schedule");
const { ScheduleService } = require("../dist/modules/schedule/schedule.service");

async function withFixedDate(iso, callback) {
  const RealDate = global.Date;
  const fixedTime = new RealDate(iso).getTime();

  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedTime] : args));
    }

    static now() {
      return fixedTime;
    }
  };

  try {
    return await callback();
  } finally {
    global.Date = RealDate;
  }
}

test("ScheduleService remains a one-argument Prisma facade with schedule defaults", async () => {
  const updates = [];
  const lockedUser = {
    id: "user-1",
    dailyPromptEnabled: true,
    dailyPromptHour: 13,
    dailyPromptMinute: 0,
    timezone: "Europe/Moscow",
  };
  const tx = {
    $queryRaw: async () => [lockedUser],
    user: {
      update: async (args) => {
        updates.push(args);
        return { ...lockedUser, ...args.data };
      },
    },
  };
  const prisma = {
    $transaction: async (callback) => callback(tx),
  };

  const service = new ScheduleService(prisma);
  const result = await withFixedDate("2026-08-09T08:00:00.000Z", () =>
    service.initializeSchedule("user-1", 15, 30, "Europe/Moscow"),
  );

  assert.equal(result.id, "user-1");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].where, { id: "user-1" });
  assert.deepEqual(
    { ...updates[0].data, nextPromptAt: updates[0].data.nextPromptAt.toISOString() },
    {
      dailyPromptEnabled: true,
      dailyPromptHour: 15,
      dailyPromptMinute: 30,
      timezone: "Europe/Moscow",
      nextPromptAt: "2026-08-09T12:30:00.000Z",
    },
  );
});

test("ResponseService accepts its streak collaborator and preserves facade method arguments", async () => {
  const attemptedAt = new Date("2026-08-09T08:00:00.000Z");
  const deliveryUpdates = [];
  const lookups = [];
  const prisma = {
    $transaction: async (callback) =>
      callback({
        $queryRaw: async () => [],
        reportDeliveryRequest: {
          findUnique: async (args) => {
            lookups.push(args);
            return {
              id: "request-1",
              status: "pending",
              claimToken: "claim-1",
              deliveryAttemptedAt: null,
              nextChunkIndex: 0,
              chunks: ["first chunk"],
            };
          },
          update: async (args) => {
            deliveryUpdates.push(args);
            return args;
          },
        },
      }),
    userResponse: {
      findUnique: async (args) => ({ id: "response-1", ...args.where }),
    },
  };

  const service = new ResponseService(prisma, {});
  const begun = await withFixedDate(attemptedAt.toISOString(), () =>
    service.beginDeliveryChunk("request-1", "claim-1"),
  );
  const response = await service.getResponseById("response-1");

  assert.deepEqual(lookups, [{ where: { id: "request-1" } }]);
  assert.deepEqual({ ...begun, attemptedAt: begun.attemptedAt.toISOString() }, {
    outcome: "begun",
    chunk: "first chunk",
    chunkIndex: 0,
    attemptedAt: attemptedAt.toISOString(),
  });
  assert.equal(deliveryUpdates.length, 1);
  assert.deepEqual(deliveryUpdates[0].where, { id: "request-1" });
  assert.deepEqual(
    {
      ...deliveryUpdates[0].data,
      deliveryAttemptedAt: deliveryUpdates[0].data.deliveryAttemptedAt.toISOString(),
      lastDeliveryErrorAt: deliveryUpdates[0].data.lastDeliveryErrorAt.toISOString(),
    },
    {
      deliveryAttemptedAt: attemptedAt.toISOString(),
      claimToken: null,
      claimExpiresAt: null,
      lastDeliveryErrorCode: "unknown_delivery_outcome",
      lastDeliveryErrorAt: attemptedAt.toISOString(),
    },
  );
  assert.deepEqual(response, { id: "response-1" });
});

test("service barrels preserve public runtime exports without exposing operation classes", () => {
  assert.equal(scheduleBarrel.ScheduleService, ScheduleService);
  assert.equal(responseBarrel.ResponseService, ResponseService);

  for (const operationName of [
    "ScheduleSettingsOperations",
    "ScheduleClaimsOperations",
    "ScheduleDeliveryOperations",
  ]) {
    assert.equal(Object.hasOwn(scheduleBarrel, operationName), false);
  }

  for (const operationName of [
    "ResponseCrudOperations",
    "ResponseDeliveryOperations",
    "ResponseGenerationOperations",
  ]) {
    assert.equal(Object.hasOwn(responseBarrel, operationName), false);
  }
});
