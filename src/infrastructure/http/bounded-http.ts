export type BoundedHttpErrorCode =
  | "aborted"
  | "network"
  | "response_too_large"
  | "timeout";

export class BoundedHttpError extends Error {
  constructor(
    readonly code: BoundedHttpErrorCode,
    readonly attempt: number,
    options?: { cause?: unknown },
  ) {
    super(messageFor(code));
    this.name = "BoundedHttpError";
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface BoundedFetchOptions extends RequestInit {
  timeoutMs: number;
  maxResponseBytes: number;
  safeToRetry?: boolean;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Fetches and buffers a response under fixed time and byte limits. The returned
 * value remains a regular Response, so callers can use text(), json(), etc.
 */
export async function boundedFetch(
  input: RequestInfo | URL,
  options: BoundedFetchOptions,
): Promise<Response> {
  validatePositiveInteger("timeoutMs", options.timeoutMs);
  validatePositiveInteger("maxResponseBytes", options.maxResponseBytes);

  const {
    timeoutMs,
    maxResponseBytes,
    safeToRetry = false,
    fetchImpl = fetch,
    signal: callerSignal,
    ...requestInit
  } = options;
  const attempts = safeToRetry ? 2 : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchAttempt(
      fetchImpl,
      input,
      requestInit,
      callerSignal,
      timeoutMs,
      maxResponseBytes,
      attempt,
    ).catch((error: unknown) => {
      const normalized = normalizeError(error, callerSignal, attempt);
      if (attempt < attempts && isRetryableError(normalized)) return normalized;
      throw normalized;
    });

    if (response instanceof BoundedHttpError) continue;
    if (attempt < attempts && RETRYABLE_STATUS_CODES.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    return response;
  }

  throw new BoundedHttpError("network", attempts);
}

async function fetchAttempt(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  requestInit: RequestInit,
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
  attempt: number,
): Promise<Response> {
  if (callerSignal?.aborted) throw new BoundedHttpError("aborted", attempt);

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(input, {
      ...requestInit,
      signal: controller.signal,
    });
    assertContentLength(response, maxResponseBytes, attempt);
    return await bufferResponse(response, maxResponseBytes, attempt);
  } catch (error) {
    if (timedOut) throw new BoundedHttpError("timeout", attempt, { cause: error });
    if (callerSignal?.aborted) {
      throw new BoundedHttpError("aborted", attempt, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function assertContentLength(
  response: Response,
  maxResponseBytes: number,
  attempt: number,
): void {
  const raw = response.headers.get("content-length");
  if (raw === null) return;
  const contentLength = Number(raw);
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    void response.body?.cancel();
    throw new BoundedHttpError("response_too_large", attempt);
  }
}

async function bufferResponse(
  response: Response,
  maxResponseBytes: number,
  attempt: number,
): Promise<Response> {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedHttpError("response_too_large", attempt);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const bodyAllowed = ![101, 204, 205, 304].includes(response.status);
  return new Response(bodyAllowed ? body : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeError(
  error: unknown,
  callerSignal: AbortSignal | null | undefined,
  attempt: number,
): BoundedHttpError {
  if (error instanceof BoundedHttpError) return error;
  if (callerSignal?.aborted) {
    return new BoundedHttpError("aborted", attempt, { cause: error });
  }
  return new BoundedHttpError("network", attempt, { cause: error });
}

function isRetryableError(error: BoundedHttpError): boolean {
  return error.code === "network" || error.code === "timeout";
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function messageFor(code: BoundedHttpErrorCode): string {
  switch (code) {
    case "aborted":
      return "HTTP request was aborted";
    case "network":
      return "HTTP request failed";
    case "response_too_large":
      return "HTTP response exceeded the configured size limit";
    case "timeout":
      return "HTTP request exceeded the configured timeout";
  }
}
