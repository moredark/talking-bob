const assert = require("node:assert/strict");
const test = require("node:test");
const {
  HEADERS_METADATA,
  METHOD_METADATA,
} = require("@nestjs/common/constants");
const { RequestMethod } = require("@nestjs/common");

const {
  HealthController,
} = require("../dist/modules/health/health.controller");
const { HealthService } = require("../dist/modules/health/health.service");

function createHealthRuntime({
  databaseError,
  telegramState = "running",
} = {}) {
  const calls = { database: 0, telegram: 0 };
  const prisma = {
    async $queryRaw() {
      calls.database += 1;
      if (databaseError) throw databaseError;
      return [{ value: 1 }];
    },
  };
  const telegram = {
    getLifecycleState() {
      calls.telegram += 1;
      return telegramState;
    },
  };
  const service = new HealthService(prisma, telegram);
  return {
    calls,
    controller: new HealthController(service),
  };
}

function noStoreMetadata(method) {
  return Reflect.getMetadata(HEADERS_METADATA, method).find(
    ({ name }) => name.toLowerCase() === "cache-control",
  );
}

test("liveness is a dependency-free GET with an uncached 200 response", () => {
  const { calls, controller } = createHealthRuntime({
    databaseError: new Error("postgresql://secret@database/internal"),
    telegramState: "stopped",
  });

  assert.deepEqual(controller.getLiveness(), { status: "ok" });
  assert.deepEqual(calls, { database: 0, telegram: 0 });
  assert.equal(
    Reflect.getMetadata(METHOD_METADATA, controller.getLiveness),
    RequestMethod.GET,
  );
  assert.deepEqual(noStoreMetadata(controller.getLiveness), {
    name: "Cache-Control",
    value: "no-store",
  });
  // Nest's default status for a GET handler is 200; no @HttpCode override exists.
});

test("readiness succeeds only when PostgreSQL is up and Telegram is running", async () => {
  const { calls, controller } = createHealthRuntime();

  assert.deepEqual(await controller.getReadiness(), {
    status: "ready",
    checks: { database: "up", telegram: "running" },
  });
  assert.deepEqual(calls, { database: 1, telegram: 1 });
  assert.deepEqual(noStoreMetadata(controller.getReadiness), {
    name: "Cache-Control",
    value: "no-store",
  });
});

test("readiness sanitizes a database failure", async () => {
  const secret = "postgresql://admin:do-not-leak@db.internal/talking_bob";
  const { controller } = createHealthRuntime({
    databaseError: new Error(`connection failed: ${secret}`),
  });

  await assert.rejects(controller.getReadiness(), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(error.getResponse(), {
      status: "not_ready",
      checks: { database: "down", telegram: "running" },
    });
    assert.equal(JSON.stringify(error.getResponse()).includes(secret), false);
    assert.equal(JSON.stringify(error.getResponse()).includes("connection failed"), false);
    return true;
  });
});

test("readiness observes a Telegram shutdown that starts during the database probe", async () => {
  let releaseDatabase;
  let telegramState = "running";
  const databaseProbe = new Promise((resolve) => {
    releaseDatabase = resolve;
  });
  const service = new HealthService(
    {
      async $queryRaw() {
        await databaseProbe;
        return [{ value: 1 }];
      },
    },
    {
      getLifecycleState() {
        return telegramState;
      },
    },
  );
  const controller = new HealthController(service);

  const readiness = controller.getReadiness();
  telegramState = "shutting_down";
  releaseDatabase();

  await assert.rejects(readiness, (error) => {
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(error.getResponse(), {
      status: "not_ready",
      checks: { database: "up", telegram: "shutting_down" },
    });
    return true;
  });
});

for (const telegramState of [
  "starting",
  "restart_wait",
  "shutting_down",
  "stopped",
]) {
  test(`readiness returns a sanitized 503 while Telegram is ${telegramState}`, async () => {
    const { controller } = createHealthRuntime({ telegramState });

    await assert.rejects(controller.getReadiness(), (error) => {
      assert.equal(error.getStatus(), 503);
      assert.deepEqual(error.getResponse(), {
        status: "not_ready",
        checks: { database: "up", telegram: telegramState },
      });
      assert.equal("stack" in error.getResponse(), false);
      assert.equal("message" in error.getResponse(), false);
      return true;
    });
  });
}
