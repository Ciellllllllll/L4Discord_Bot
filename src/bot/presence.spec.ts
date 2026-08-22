import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUptime, startPresence } from "./presence.js";

const log = { debug: () => undefined, warn: () => undefined } as never;

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("稼働時間を秒なしで表示し、0の単位を省略する", () => {
  assert.equal(formatUptime(0), "0m");
  assert.equal(formatUptime(59), "0m");
  assert.equal(formatUptime(60), "1m");
  assert.equal(formatUptime(3_600 + 60), "1h 1m");
  assert.equal(formatUptime(365 * 86_400 + 30 * 86_400 + 86_400 + 3_600 + 300), "1y 1mo 1d 1h 5m");
});

test("Presenceは起動直後と60秒ごとに稼働時間だけを更新する", async () => {
  const statuses: unknown[] = [];
  let scheduled: (() => void) | undefined;
  const timer = startPresence(
    { user: { setPresence: async (presence: unknown) => { statuses.push(presence); } } } as never,
    log,
    () => 3_661,
    {
      setInterval: (callback, delay) => {
        assert.equal(delay, 60_000);
        scheduled = callback;
        return { marker: "presence" } as unknown as NodeJS.Timeout;
      },
    },
  );

  await flushMicrotasks();
  assert.equal(statuses.length, 1);
  assert.equal((statuses[0] as { activities: [{ name: string }] }).activities[0].name, "稼働時間: 1h 1m");

  scheduled?.();
  await flushMicrotasks();
  assert.equal(statuses.length, 2);
  assert.equal((timer as unknown as { marker: string }).marker, "presence");
});

test("Presence更新失敗時に旧ステータスへ切り替えない", async () => {
  let attempts = 0;
  let warnings = 0;
  startPresence(
    { user: { setPresence: async () => { attempts += 1; throw new Error("gateway unavailable"); } } } as never,
    { debug: () => undefined, warn: () => { warnings += 1; } } as never,
    () => 0,
    { setInterval: () => ({}) as unknown as NodeJS.Timeout },
  );

  await flushMicrotasks();
  assert.equal(attempts, 1);
  assert.equal(warnings, 1);
});
