import assert from "node:assert/strict";
import { test } from "node:test";
import { startRuntimeUptime } from "./runtimeUptime.js";

type QueryCall = { sql: string; values: readonly unknown[] };

function fakePool(options: {
  totalSeconds?: number;
  openSessions?: Array<{ session_id: string; last_checkpoint_at: Date }>;
} = {}) {
  const calls: QueryCall[] = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      calls.push({ sql: normalized, values });
      if (normalized.includes("SELECT session_id, last_checkpoint_at")) {
        return { rows: options.openSessions ?? [], rowCount: (options.openSessions ?? []).length };
      }
      if (normalized.includes("SELECT COALESCE(SUM(active_seconds)")) {
        return { rows: [{ total_seconds: String(options.totalSeconds ?? 0) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client } as never,
    calls,
  };
}

test("稼働時間コントローラーは5秒間隔でDBへ保存し、累計を返す", async () => {
  const fixture = fakePool({ totalSeconds: 120 });
  let now = 1_700_000_000_000;
  let checkpoint: (() => void) | undefined;
  let interval = 0;
  const controller = await startRuntimeUptime({
    pool: fixture.pool,
    runtimeKey: "production",
    botVersion: "2.0.14",
    now: () => now,
    setInterval: (callback, delay) => {
      interval = delay;
      checkpoint = callback;
      return {} as NodeJS.Timeout;
    },
  });

  assert.equal(interval, 5_000);
  assert.equal(controller.getUptimeSeconds(), 120);

  now += 12_500;
  checkpoint?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getUptimeSeconds(), 132);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes("active_seconds = active_seconds + $2")), true);

  await controller.stop();
  assert.equal(fixture.calls.some(({ sql }) => sql.includes("end_reason = 'graceful'")), true);
});

test("起動時に未終了セッションを中断扱いにし、保存済み累計を引き継ぐ", async () => {
  const fixture = fakePool({
    totalSeconds: 42,
    openSessions: [{ session_id: "previous", last_checkpoint_at: new Date("2026-08-21T00:00:00.000Z") }],
  });
  const controller = await startRuntimeUptime({
    pool: fixture.pool,
    runtimeKey: "production",
    botVersion: "2.0.15",
    now: () => Date.parse("2026-08-21T01:00:00.000Z"),
    createSessionId: () => "current",
    setInterval: () => ({}) as unknown as NodeJS.Timeout,
  });

  assert.equal(controller.getUptimeSeconds(), 42);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes("end_reason = 'interrupted'")), true);
  assert.equal(fixture.calls.some(({ sql, values }) => sql.startsWith("INSERT INTO bot_runtime_sessions") && values.includes("2.0.15")), true);
  await controller.stop();
});
