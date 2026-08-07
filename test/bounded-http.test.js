const test = require("node:test");
const assert = require("node:assert/strict");

const {
  boundedFetch,
  BoundedHttpError,
} = require("../dist/infrastructure/http/bounded-http");

test("bounded fetch returns a reusable buffered Response", async () => {
  const response = await boundedFetch("https://not-logged.example/secret", {
    timeoutMs: 100,
    maxResponseBytes: 16,
    fetchImpl: async () => new Response("hello"),
  });

  assert.equal(await response.text(), "hello");
});

test("bounded fetch rejects oversized Content-Length before reading", async () => {
  await assert.rejects(
    boundedFetch("https://example.invalid", {
      timeoutMs: 100,
      maxResponseBytes: 4,
      fetchImpl: async () =>
        new Response("large", { headers: { "content-length": "5" } }),
    }),
    (error) =>
      error instanceof BoundedHttpError &&
      error.code === "response_too_large" &&
      !error.message.includes("example.invalid"),
  );
});

test("bounded fetch enforces streamed byte limit without Content-Length", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  });

  await assert.rejects(
    boundedFetch("https://example.invalid", {
      timeoutMs: 100,
      maxResponseBytes: 5,
      fetchImpl: async () => new Response(stream),
    }),
    (error) =>
      error instanceof BoundedHttpError && error.code === "response_too_large",
  );
});

test("bounded fetch aborts a stalled request on timeout", async () => {
  await assert.rejects(
    boundedFetch("https://example.invalid", {
      timeoutMs: 10,
      maxResponseBytes: 10,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    }),
    (error) => error instanceof BoundedHttpError && error.code === "timeout",
  );
});

test("bounded fetch retries at most once and only when marked safe", async () => {
  let unsafeCalls = 0;
  await assert.rejects(
    boundedFetch("https://example.invalid", {
      timeoutMs: 100,
      maxResponseBytes: 10,
      fetchImpl: async () => {
        unsafeCalls += 1;
        throw new Error("provider details must stay hidden");
      },
    }),
    (error) => error.code === "network" && error.attempt === 1,
  );
  assert.equal(unsafeCalls, 1);

  let safeCalls = 0;
  const response = await boundedFetch("https://example.invalid", {
    timeoutMs: 100,
    maxResponseBytes: 10,
    safeToRetry: true,
    fetchImpl: async () => {
      safeCalls += 1;
      if (safeCalls === 1) throw new Error("temporary failure");
      return new Response("ok");
    },
  });
  assert.equal(safeCalls, 2);
  assert.equal(await response.text(), "ok");
});

test("safe bounded fetch retries retryable HTTP status but not permanent status", async () => {
  let retryableCalls = 0;
  const recovered = await boundedFetch("https://example.invalid", {
    timeoutMs: 100,
    maxResponseBytes: 16,
    safeToRetry: true,
    fetchImpl: async () => {
      retryableCalls += 1;
      return retryableCalls === 1
        ? new Response("busy", { status: 503 })
        : new Response("ok");
    },
  });
  assert.equal(retryableCalls, 2);
  assert.equal(await recovered.text(), "ok");

  let permanentCalls = 0;
  const rejected = await boundedFetch("https://example.invalid", {
    timeoutMs: 100,
    maxResponseBytes: 16,
    safeToRetry: true,
    fetchImpl: async () => {
      permanentCalls += 1;
      return new Response("bad request", { status: 400 });
    },
  });
  assert.equal(permanentCalls, 1);
  assert.equal(rejected.status, 400);
});

test("caller abort is typed and is never retried", async () => {
  const controller = new AbortController();
  controller.abort("stop");
  let calls = 0;

  await assert.rejects(
    boundedFetch("https://example.invalid", {
      timeoutMs: 100,
      maxResponseBytes: 10,
      safeToRetry: true,
      signal: controller.signal,
      fetchImpl: async () => {
        calls += 1;
        return new Response("unexpected");
      },
    }),
    (error) => error.code === "aborted",
  );
  assert.equal(calls, 0);
});
