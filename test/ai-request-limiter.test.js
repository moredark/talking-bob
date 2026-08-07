const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AiRequestLimiterClosedError,
  AiRequestLimiterOverloadedError,
  AiRequestLimiterService,
} = require("../dist/modules/ai/services/ai-request-limiter.service");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("AI limiter enforces finite pending admission, including zero", async () => {
  for (const maxPending of [0, 1]) {
    const limiter = new AiRequestLimiterService(1, maxPending);
    const activeGate = deferred();
    const queuedGate = deferred();
    const active = limiter.run(() => activeGate.promise);
    await tick();

    const queued =
      maxPending === 1 ? limiter.run(() => queuedGate.promise) : undefined;
    if (queued) await tick();
    assert.equal(limiter.pending, maxPending);

    await assert.rejects(
      limiter.run(() => undefined),
      AiRequestLimiterOverloadedError,
    );

    activeGate.resolve();
    await active;
    if (queued) {
      queuedGate.resolve();
      await queued;
    }
    await limiter.drain();
  }
});

test("AI limiter distinguishes overload from closed admission", async () => {
  const limiter = new AiRequestLimiterService(1, 0);
  const gate = deferred();
  const active = limiter.run(() => gate.promise);
  await tick();

  await assert.rejects(
    limiter.run(() => undefined),
    (error) =>
      error instanceof AiRequestLimiterOverloadedError &&
      !(error instanceof AiRequestLimiterClosedError),
  );

  limiter.close();
  await assert.rejects(
    limiter.run(() => undefined),
    (error) =>
      error instanceof AiRequestLimiterClosedError &&
      !(error instanceof AiRequestLimiterOverloadedError),
  );

  gate.resolve();
  await active;
  await limiter.drain();
});

test("close drains already queued work in FIFO order", async () => {
  const limiter = new AiRequestLimiterService(1, 2);
  const firstGate = deferred();
  const order = [];
  const first = limiter.run(async () => {
    order.push("first:start");
    await firstGate.promise;
    order.push("first:end");
  });
  const second = limiter.run(() => order.push("second"));
  const third = limiter.run(() => order.push("third"));
  limiter.close();

  let drained = false;
  const drain = limiter.drain().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  assert.equal(limiter.pending, 2);

  firstGate.resolve();
  await Promise.all([first, second, third, drain]);
  assert.deepEqual(order, ["first:start", "first:end", "second", "third"]);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.pending, 0);
});

test("abort rejects pending work and aborts the active task signal", async () => {
  const limiter = new AiRequestLimiterService(1, 1);
  const reason = new AiRequestLimiterClosedError("shutdown deadline");
  let activeSignal;
  const active = limiter.run(
    (signal) =>
      new Promise((_resolve, reject) => {
        activeSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const pending = limiter.run(() => "must not run");
  const activeRejected = assert.rejects(active, (error) => error === reason);
  const pendingRejected = assert.rejects(pending, (error) => error === reason);
  await tick();

  limiter.abort(reason);
  await Promise.all([activeRejected, pendingRejected, limiter.drain()]);
  assert.equal(activeSignal.aborted, true);
  assert.equal(activeSignal.reason, reason);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.pending, 0);
});
