import assert from "node:assert/strict";
import { test } from "node:test";
import { StartupReport } from "./startupReport.js";

type LogEntry = { level: "info" | "warn" | "error"; bindings?: Record<string, unknown>; message?: string };

function createLog(entries: LogEntry[]) {
  return {
    info: (bindingsOrMessage: Record<string, unknown> | string, message?: string) => {
      entries.push({
        level: "info",
        ...(typeof bindingsOrMessage === "string" ? { message: bindingsOrMessage } : { bindings: bindingsOrMessage, message }),
      });
    },
    warn: (bindings: Record<string, unknown>, message: string) => entries.push({ level: "warn", bindings, message }),
    error: (bindings: Record<string, unknown>, message: string) => entries.push({ level: "error", bindings, message }),
  };
}

test("StartupReport emits one successful summary without per-task info logs", async () => {
  const entries: LogEntry[] = [];
  const report = new StartupReport(createLog(entries) as never, "guild-1");

  await report.run("panel reconciliation", async () => undefined);
  await report.run("modmail UI restore", async () => undefined);
  report.logSummary();

  assert.deepEqual(entries, [{
    level: "info",
    bindings: { completedComponents: ["panel reconciliation", "modmail UI restore"], completedCount: 2, guildId: "guild-1" },
    message: "Startup reconciliation completed successfully.",
  }]);
});

test("StartupReport records a failed component and emits an issue summary", async () => {
  const entries: LogEntry[] = [];
  const report = new StartupReport(createLog(entries) as never, "guild-1");
  const failure = new Error("missing permission");

  await report.run("reaction-role panel", async () => { throw failure; });
  await report.run("modmail UI restore", async () => undefined);
  report.logSummary();

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    level: "error",
    bindings: { component: "reaction-role panel", err: failure, failedComponents: ["reaction-role panel"], guildId: "guild-1" },
    message: "startup task failed",
  });
  assert.deepEqual(entries[1], {
    level: "warn",
    bindings: { completedCount: 1, failedComponents: ["reaction-role panel"], guildId: "guild-1" },
    message: "Startup reconciliation completed with issues.",
  });
});

test("StartupReport summarizes panel kinds reported by a reconciliation failure", async () => {
  const entries: LogEntry[] = [];
  const report = new StartupReport(createLog(entries) as never, "guild-1");
  const failure = Object.assign(new Error("panel reconciliation failed"), {
    failedComponents: ["reaction_role_admin", "automod_panel"],
  });

  await report.run("panel reconciliation", async () => { throw failure; });
  report.logSummary();

  assert.deepEqual(entries[1], {
    level: "warn",
    bindings: { completedCount: 0, failedComponents: ["reaction_role_admin", "automod_panel"], guildId: "guild-1" },
    message: "Startup reconciliation completed with issues.",
  });
});

console.log("startupReport.spec.ts: all assertions passed");
