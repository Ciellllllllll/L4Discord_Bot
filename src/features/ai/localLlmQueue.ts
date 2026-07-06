export type LocalLlmQueueOptions = {
  maxConcurrent: number;
  maxQueue: number;
};

export type LocalLlmQueueJob<T> = {
  userId: string;
  /**
   * Runs the queued work. If the underlying operation can hang, the caller must
   * provide a timeout-aware promise here because this queue cannot abort HTTP or
   * other external work by itself.
   */
  run: () => Promise<T>;
  onStart?: () => void;
};

export type LocalLlmQueueRejectReason = "queue_full" | "duplicate_user";

export type LocalLlmQueueAccepted<T> = {
  ok: true;
  queuedAhead: number;
  /**
   * Settles with the queued job result or error. Callers must always await or
   * catch this promise after receiving an accepted ticket.
   */
  promise: Promise<T>;
};

export type LocalLlmQueueRejected = {
  ok: false;
  reason: LocalLlmQueueRejectReason;
  queuedAhead: number;
};

export type LocalLlmQueueTicket<T> = LocalLlmQueueAccepted<T> | LocalLlmQueueRejected;

type QueuedJob = {
  userId: string;
  run: () => Promise<unknown>;
  onStart?: () => void;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

function normalizeMaxConcurrent(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.trunc(value);
}

function normalizeMaxQueue(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

export class LocalLlmQueue {
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly waiting: QueuedJob[] = [];
  private readonly runningUsers = new Set<string>();
  private readonly waitingUsers = new Set<string>();
  private runningCount = 0;

  constructor(options: LocalLlmQueueOptions) {
    this.maxConcurrent = normalizeMaxConcurrent(options.maxConcurrent);
    this.maxQueue = normalizeMaxQueue(options.maxQueue);
  }

  enqueue<T>(job: LocalLlmQueueJob<T>): LocalLlmQueueTicket<T> {
    const queuedAhead = this.waiting.length;
    if (this.runningUsers.has(job.userId) || this.waitingUsers.has(job.userId)) {
      return { ok: false, reason: "duplicate_user", queuedAhead };
    }
    if (this.runningCount >= this.maxConcurrent && this.waiting.length >= this.maxQueue) {
      return { ok: false, reason: "queue_full", queuedAhead };
    }

    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.waiting.push({
      userId: job.userId,
      run: job.run,
      onStart: job.onStart,
      resolve: (value) => resolve(value as T),
      reject,
    });
    this.waitingUsers.add(job.userId);
    this.drain();

    return { ok: true, queuedAhead, promise };
  }

  private drain(): void {
    while (this.runningCount < this.maxConcurrent && this.waiting.length > 0) {
      const job = this.waiting.shift();
      if (!job) return;

      this.waitingUsers.delete(job.userId);
      this.runningUsers.add(job.userId);
      this.runningCount += 1;
      void this.execute(job);
    }
  }

  private async execute(job: QueuedJob): Promise<void> {
    try {
      job.onStart?.();
      job.resolve(await job.run());
    } catch (error) {
      job.reject(error);
    } finally {
      this.runningCount -= 1;
      this.runningUsers.delete(job.userId);
      this.drain();
    }
  }
}
