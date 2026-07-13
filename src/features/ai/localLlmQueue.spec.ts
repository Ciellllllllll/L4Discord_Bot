import assert from "node:assert/strict";
import { LocalLlmQueue } from "./localLlmQueue.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> {
  await Promise.resolve();
}

async function run(): Promise<void> {
  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 10 });
    const first = deferred<string>();
    const second = deferred<string>();
    const events: string[] = [];

    const firstTicket = queue.enqueue({
      userId: "user-a",
      onStart: () => events.push("first:start"),
      run: async () => {
        events.push("first:run");
        return await first.promise;
      },
    });
    const secondTicket = queue.enqueue({
      userId: "user-b",
      onStart: () => events.push("second:start"),
      run: async () => {
        events.push("second:run");
        return await second.promise;
      },
    });

    assert.equal(firstTicket.ok, true);
    assert.equal(secondTicket.ok, true);
    assert.equal(secondTicket.queuedAhead, 0);
    assert.deepEqual(events, ["first:start", "first:run"]);

    first.resolve("one");
    await assert.doesNotReject(async () => {
      assert.equal(await firstTicket.promise, "one");
    });
    assert.deepEqual(events, ["first:start", "first:run", "second:start", "second:run"]);

    second.resolve("two");
    assert.equal(await secondTicket.promise, "two");
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 1 });
    const running = deferred<void>();
    let rejectedRunCalls = 0;

    const firstTicket = queue.enqueue({
      userId: "user-a",
      run: async () => await running.promise,
    });
    const secondTicket = queue.enqueue({
      userId: "user-b",
      run: async () => "queued",
    });
    const rejectedTicket = queue.enqueue({
      userId: "user-c",
      run: async () => {
        rejectedRunCalls += 1;
        return "should not run";
      },
    });

    assert.equal(firstTicket.ok, true);
    assert.equal(secondTicket.ok, true);
    assert.equal(secondTicket.queuedAhead, 0);
    assert.deepEqual(rejectedTicket, {
      ok: false,
      reason: "queue_full",
      queuedAhead: 1,
    });
    assert.equal(rejectedRunCalls, 0);

    running.resolve();
    await firstTicket.promise;
    await secondTicket.promise;
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 1 });
    const events: string[] = [];

    const ticket = queue.enqueue({
      userId: "user-a",
      onStart: () => events.push("start"),
      run: async () => {
        events.push("run");
        return "done";
      },
    });

    assert.equal(ticket.ok, true);
    assert.deepEqual(events, ["start", "run"]);
    assert.equal(await ticket.promise, "done");
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 2 });
    const events: string[] = [];

    const failedTicket = queue.enqueue({
      userId: "user-a",
      run: async () => {
        events.push("failed");
        throw new Error("boom");
      },
    });
    const nextTicket = queue.enqueue({
      userId: "user-b",
      run: async () => {
        events.push("next");
        return "after failure";
      },
    });

    assert.equal(failedTicket.ok, true);
    assert.equal(nextTicket.ok, true);
    await assert.rejects(() => failedTicket.promise, /boom/);
    assert.equal(await nextTicket.promise, "after failure");
    assert.deepEqual(events, ["failed", "next"]);
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 2 });
    const events: string[] = [];

    const failedTicket = queue.enqueue({
      userId: "user-a",
      onStart: () => {
        events.push("failed:start");
        throw new Error("onStart boom");
      },
      run: async () => {
        events.push("failed:run");
        return "should not run";
      },
    });
    const nextTicket = queue.enqueue({
      userId: "user-b",
      run: async () => {
        events.push("next");
        return "after onStart failure";
      },
    });

    assert.equal(failedTicket.ok, true);
    assert.equal(nextTicket.ok, true);
    await assert.rejects(() => failedTicket.promise, /onStart boom/);
    assert.equal(await nextTicket.promise, "after onStart failure");
    assert.deepEqual(events, ["failed:start", "next"]);
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: Number.NaN, maxQueue: 1 });
    const events: string[] = [];

    const ticket = queue.enqueue({
      userId: "user-a",
      run: async () => {
        events.push("run");
        return "nan concurrent falls back";
      },
    });

    assert.equal(ticket.ok, true);
    assert.deepEqual(events, ["run"]);
    assert.equal(await ticket.promise, "nan concurrent falls back");
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 0, maxQueue: 1 });

    const ticket = queue.enqueue({
      userId: "user-a",
      run: async () => "zero concurrent falls back",
    });

    assert.equal(ticket.ok, true);
    assert.equal(await ticket.promise, "zero concurrent falls back");
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: -1, maxQueue: 1 });

    const ticket = queue.enqueue({
      userId: "user-a",
      run: async () => "negative concurrent falls back",
    });

    assert.equal(ticket.ok, true);
    assert.equal(await ticket.promise, "negative concurrent falls back");
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: Number.NaN });
    const running = deferred<void>();

    const runningTicket = queue.enqueue({
      userId: "user-a",
      run: async () => await running.promise,
    });
    const rejectedTicket = queue.enqueue({
      userId: "user-b",
      run: async () => "should not queue",
    });

    assert.equal(runningTicket.ok, true);
    assert.deepEqual(rejectedTicket, {
      ok: false,
      reason: "queue_full",
      queuedAhead: 0,
    });

    running.resolve();
    await runningTicket.promise;
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 0 });
    const running = deferred<void>();

    const runningTicket = queue.enqueue({
      userId: "user-a",
      run: async () => await running.promise,
    });
    const rejectedTicket = queue.enqueue({
      userId: "user-b",
      run: async () => "should not queue",
    });

    assert.equal(runningTicket.ok, true);
    assert.deepEqual(rejectedTicket, {
      ok: false,
      reason: "queue_full",
      queuedAhead: 0,
    });

    running.resolve();
    await runningTicket.promise;
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: -1 });
    const running = deferred<void>();

    const runningTicket = queue.enqueue({
      userId: "user-a",
      run: async () => await running.promise,
    });
    const rejectedTicket = queue.enqueue({
      userId: "user-b",
      run: async () => "should not queue",
    });

    assert.equal(runningTicket.ok, true);
    assert.deepEqual(rejectedTicket, {
      ok: false,
      reason: "queue_full",
      queuedAhead: 0,
    });

    running.resolve();
    await runningTicket.promise;
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 3 });
    const running = deferred<void>();

    const runningTicket = queue.enqueue({
      userId: "user-a",
      run: async () => await running.promise,
    });
    const duplicateRunningTicket = queue.enqueue({
      userId: "user-a",
      run: async () => "duplicate running",
    });
    const waitingTicket = queue.enqueue({
      userId: "user-b",
      run: async () => "queued",
    });
    const duplicateWaitingTicket = queue.enqueue({
      userId: "user-b",
      run: async () => "duplicate waiting",
    });

    assert.equal(runningTicket.ok, true);
    assert.deepEqual(duplicateRunningTicket, {
      ok: false,
      reason: "duplicate_user",
      queuedAhead: 0,
    });
    assert.equal(waitingTicket.ok, true);
    assert.deepEqual(duplicateWaitingTicket, {
      ok: false,
      reason: "duplicate_user",
      queuedAhead: 1,
    });

    running.resolve();
    await runningTicket.promise;
    assert.equal(await waitingTicket.promise, "queued");
  }

  {
    const queue = new LocalLlmQueue({ maxConcurrent: 2, maxQueue: 2 });
    const first = deferred<void>();
    const second = deferred<void>();
    const events: string[] = [];

    const firstTicket = queue.enqueue({
      userId: "user-a",
      run: async () => {
        events.push("first");
        await first.promise;
      },
    });
    const secondTicket = queue.enqueue({
      userId: "user-b",
      run: async () => {
        events.push("second");
        await second.promise;
      },
    });
    const thirdTicket = queue.enqueue({
      userId: "user-c",
      run: async () => {
        events.push("third");
      },
    });

    assert.equal(firstTicket.ok, true);
    assert.equal(secondTicket.ok, true);
    assert.equal(thirdTicket.ok, true);
    assert.equal(thirdTicket.queuedAhead, 0);
    assert.deepEqual(events, ["first", "second"]);

    first.resolve();
    await firstTicket.promise;
    await tick();
    assert.deepEqual(events, ["first", "second", "third"]);

    second.resolve();
    await secondTicket.promise;
    await thirdTicket.promise;
  }
}

void run()
  .then(() => {
    console.log("localLlmQueue.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
