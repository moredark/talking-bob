const assert = require("node:assert/strict");
const test = require("node:test");

const { run } = require("@grammyjs/runner");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function abortablePending(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

test("real runner 2.0.3 starts with a 100-update poll independently of sink concurrency", async () => {
  const requests = [];
  const bot = {
    api: {
      getUpdates: async (args, signal) => {
        requests.push(args);
        if (requests.length === 1) return [];
        return abortablePending(signal);
      },
    },
    handleUpdate: async () => undefined,
    errorHandler: async () => undefined,
  };

  const runner = run(bot, {
    runner: { silent: true },
    sink: { concurrency: 2 },
  });

  await waitFor(() => requests.length >= 2, "the second update poll");
  await runner.stop();

  assert.equal(requests[0].limit, 100);
  assert.equal(requests[1].limit, 2);
});

test("real runner stop can resolve while accepted middleware remains visible in size", async () => {
  const gates = new Map([
    [1, deferred()],
    [2, deferred()],
  ]);
  let polls = 0;
  const started = [];
  const bot = {
    api: {
      getUpdates: async (_args, signal) => {
        polls += 1;
        if (polls === 1) return [{ update_id: 1 }, { update_id: 2 }];
        return abortablePending(signal);
      },
    },
    handleUpdate: async (update) => {
      started.push(update.update_id);
      await gates.get(update.update_id).promise;
    },
    errorHandler: async () => undefined,
  };

  const runner = run(bot, {
    runner: { silent: true },
    sink: { concurrency: 2 },
  });

  await waitFor(() => started.length === 2, "both middleware tasks to start");
  assert.equal(runner.size(), 2);

  const stopped = runner.stop();
  gates.get(1).resolve();
  await stopped;

  assert.equal(runner.size(), 1);
  gates.get(2).resolve();
  await waitFor(() => runner.size() === 0, "accepted middleware to drain");
});
