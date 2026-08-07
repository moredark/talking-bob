import { Inject, Injectable, InjectionToken, Optional } from "@nestjs/common";
import { RUNTIME_CONCURRENCY_LIMITS } from "../../../config/limits.config";

export const AI_REQUEST_CONCURRENCY: InjectionToken = Symbol(
  "AI_REQUEST_CONCURRENCY",
);
export const AI_REQUEST_MAX_PENDING: InjectionToken = Symbol(
  "AI_REQUEST_MAX_PENDING",
);

export class AiRequestLimiterClosedError extends Error {
  constructor(message: string = "AI request limiter is closed") {
    super(message);
    this.name = "AiRequestLimiterClosedError";
  }
}

export class AiRequestLimiterOverloadedError extends Error {
  constructor() {
    super("AI request limiter pending queue is full");
    this.name = "AiRequestLimiterOverloadedError";
  }
}

interface WaitingJob<T = unknown> {
  task: (signal: AbortSignal) => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

@Injectable()
export class AiRequestLimiterService {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly waiting: WaitingJob[] = [];
  private readonly activeControllers = new Set<AbortController>();
  private readonly drainWaiters = new Set<() => void>();
  private activeCount = 0;
  private accepting = true;

  constructor(
    @Optional()
    @Inject(AI_REQUEST_CONCURRENCY)
    concurrency: number = RUNTIME_CONCURRENCY_LIMITS.aiRequests,
    @Optional()
    @Inject(AI_REQUEST_MAX_PENDING)
    maxPending: number = RUNTIME_CONCURRENCY_LIMITS.aiRequestMaxPending,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new RangeError("AI request concurrency must be a positive integer");
    }
    if (
      !Number.isSafeInteger(maxPending) ||
      maxPending < 0 ||
      maxPending > 1_000
    ) {
      throw new RangeError(
        "AI request max pending must be an integer between 0 and 1000",
      );
    }
    this.concurrency = concurrency;
    this.maxPending = maxPending;
  }

  get active(): number {
    return this.activeCount;
  }

  get pending(): number {
    return this.waiting.length;
  }

  run<T>(task: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new AiRequestLimiterClosedError());
    }
    if (
      this.activeCount >= this.concurrency &&
      this.waiting.length >= this.maxPending
    ) {
      return Promise.reject(new AiRequestLimiterOverloadedError());
    }
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ task, resolve, reject } as WaitingJob);
      this.pump();
    });
  }

  close(): void {
    this.accepting = false;
    this.resolveDrainIfIdle();
  }

  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  abort(
    reason: AiRequestLimiterClosedError = new AiRequestLimiterClosedError(),
  ): void {
    this.accepting = false;
    for (const job of this.waiting.splice(0)) job.reject(reason);
    for (const controller of this.activeControllers) controller.abort(reason);
    this.resolveDrainIfIdle();
  }

  private pump(): void {
    while (this.activeCount < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift() as WaitingJob;
      const controller = new AbortController();
      this.activeControllers.add(controller);
      this.activeCount += 1;
      void Promise.resolve()
        .then(() => job.task(controller.signal))
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeControllers.delete(controller);
          this.activeCount -= 1;
          this.pump();
          this.resolveDrainIfIdle();
        });
    }
  }

  private isIdle(): boolean {
    return this.activeCount === 0 && this.waiting.length === 0;
  }

  private resolveDrainIfIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
