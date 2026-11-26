import assert from "node:assert/strict";
import test from "node:test";
import { AuditLogEvent, type Guild } from "discord.js";
import { findAuditLogForTarget } from "./detecterAudit.js";

function createMockGuild(fetchAuditLogs: () => Promise<unknown>): Guild {
  return {
    members: {
      me: {
        permissions: {
          has: () => true,
        },
      },
    },
    fetchAuditLogs,
  } as unknown as Guild;
}

test("findAuditLogForTarget retries on transient API errors, logs debug on intermediate failures, and does not warn if a retry succeeds", async () => {
  let attempts = 0;
  const warnings: string[] = [];
  const debugs: string[] = [];
  const now = new Date();
  const guild = createMockGuild(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("502 Bad Gateway"), { status: 502 });
    }
    return {
      entries: new Map([
        [
          "100000000000000001",
          {
            id: "100000000000000001",
            target: { id: "200000000000000002" },
            executor: { id: "300000000000000003", username: "mod" },
            reason: "test reason",
            createdAt: now,
            changes: [],
          },
        ],
      ]),
    };
  });

  const result = await findAuditLogForTarget({
    guild,
    action: AuditLogEvent.MemberKick,
    targetUserId: "200000000000000002",
    auditWindowSec: 60,
    defaultReasonText: "理由なし",
    isProcessedAuditId: () => false,
    warn: (_meta, message) => warnings.push(message),
    debug: (_meta, message) => debugs.push(message),
    retryDelaysMs: [0, 0, 0],
  });

  assert.equal(attempts, 2);
  assert.equal(warnings.length, 0);
  assert.equal(debugs.length, 1);
  assert.equal(result?.auditId, "100000000000000001");
  assert.equal(result?.actorId, "300000000000000003");
});

test("findAuditLogForTarget retries on network error codes and fetch TypeError with network cause, warning once on final failure", async () => {
  let attempts = 0;
  const warnings: string[] = [];
  const debugs: string[] = [];
  const guild = createMockGuild(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    if (attempts === 2) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      });
    }
    throw Object.assign(new Error("Too Many Requests"), { status: 429 });
  });

  const result = await findAuditLogForTarget({
    guild,
    action: AuditLogEvent.MemberKick,
    targetUserId: "200000000000000002",
    auditWindowSec: 60,
    defaultReasonText: "理由なし",
    isProcessedAuditId: () => false,
    warn: (_meta, message) => warnings.push(message),
    debug: (_meta, message) => debugs.push(message),
    retryDelaysMs: [0, 0, 0],
  });

  assert.equal(attempts, 3);
  assert.equal(debugs.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(result, null);
});

test("findAuditLogForTarget stops immediately on plain Error without status/network code and TypeError without network cause", async () => {
  for (const err of [
    new Error("unexpected internal bug"),
    new TypeError("Cannot read properties of undefined"),
  ]) {
    let attempts = 0;
    const warnings: string[] = [];
    const guild = createMockGuild(async () => {
      attempts += 1;
      throw err;
    });

    const result = await findAuditLogForTarget({
      guild,
      action: AuditLogEvent.MemberKick,
      targetUserId: "200000000000000002",
      auditWindowSec: 60,
      defaultReasonText: "理由なし",
      isProcessedAuditId: () => false,
      warn: (_meta, message) => warnings.push(message),
      retryDelaysMs: [0, 0, 0],
    });

    assert.equal(attempts, 1);
    assert.equal(warnings.length, 1);
    assert.equal(result, null);
  }
});

test("findAuditLogForTarget stops immediately on Discord API error code (50013)", async () => {
  let attempts = 0;
  const warnings: string[] = [];
  const guild = createMockGuild(async () => {
    attempts += 1;
    throw Object.assign(new Error("Missing Permissions"), {
      name: "DiscordAPIError[50013]",
      code: 50_013,
      status: 403,
    });
  });

  const result = await findAuditLogForTarget({
    guild,
    action: AuditLogEvent.MemberKick,
    targetUserId: "200000000000000002",
    auditWindowSec: 60,
    defaultReasonText: "理由なし",
    isProcessedAuditId: () => false,
    warn: (_meta, message) => warnings.push(message),
    retryDelaysMs: [0, 0, 0],
  });

  assert.equal(attempts, 1);
  assert.equal(warnings.length, 1);
  assert.equal(result, null);
});

test("findAuditLogForTarget retries on DOMException AbortError and TimeoutError despite numeric legacy code", async () => {
  let attempts = 0;
  const now = new Date();
  const guild = createMockGuild(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (attempts === 2) {
      throw new DOMException("The operation timed out", "TimeoutError");
    }
    return {
      entries: new Map([
        [
          "100000000000000009",
          {
            id: "100000000000000009",
            target: { id: "200000000000000002" },
            executor: { id: "300000000000000003", username: "mod" },
            reason: "recovered",
            createdAt: now,
            changes: [],
          },
        ],
      ]),
    };
  });

  const result = await findAuditLogForTarget({
    guild,
    action: AuditLogEvent.MemberKick,
    targetUserId: "200000000000000002",
    auditWindowSec: 60,
    defaultReasonText: "理由なし",
    isProcessedAuditId: () => false,
    warn: () => {},
    retryDelaysMs: [0, 0, 0],
  });

  assert.equal(attempts, 3);
  assert.equal(result?.auditId, "100000000000000009");
});

test("findAuditLogForTarget stops immediately on HTTP 403 without error code", async () => {
  let attempts = 0;
  const warnings: string[] = [];
  const guild = createMockGuild(async () => {
    attempts += 1;
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  });

  const result = await findAuditLogForTarget({
    guild,
    action: AuditLogEvent.MemberKick,
    targetUserId: "200000000000000002",
    auditWindowSec: 60,
    defaultReasonText: "理由なし",
    isProcessedAuditId: () => false,
    warn: (_meta, message) => warnings.push(message),
    retryDelaysMs: [0, 0, 0],
  });

  assert.equal(attempts, 1);
  assert.equal(warnings.length, 1);
  assert.equal(result, null);
});

test("findAuditLogForTarget retries on RateLimitError and HTTPError 429/5xx", async () => {
  let attempts = 0;
  const warnings: string[] = [];
  const debugs: string[] = [];
  const now = new Date();
  const guild = createMockGuild(async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error("You are being rate limited.");
      err.name = "RateLimitError";
      throw err;
    }
    if (attempts === 2) {
      const err = new Error("Rate limit hit on route");
      err.name = "RateLimitError[/guilds/:id/audit-logs]";
      throw err;
    }
    if (attempts === 3) {
      const err = Object.assign(new Error("Service Unavailable"), {
        name: "HTTPError",
        status: 503,
      });
      throw err;
    }
    return {
      entries: new Map([
        [
          "100000000000000010",
          {
            id: "100000000000000010",
            target: { id: "200000000000000002" },
            executor: { id: "300000000000000003", username: "mod" },
            reason: "recovered after rate limit",
            createdAt: now,
            changes: [],
          },
        ],
      ]),
    };
  });

  const result = await findAuditLogForTarget({
    guild,
    action: AuditLogEvent.MemberKick,
    targetUserId: "200000000000000002",
    auditWindowSec: 60,
    defaultReasonText: "理由なし",
    isProcessedAuditId: () => false,
    warn: (_meta, message) => warnings.push(message),
    debug: (_meta, message) => debugs.push(message),
    retryDelaysMs: [0, 0, 0, 0],
  });

  assert.equal(attempts, 4);
  assert.equal(debugs.length, 3);
  assert.equal(warnings.length, 0);
  assert.equal(result?.auditId, "100000000000000010");
});

test("findAuditLogForTarget retries when ECONNRESET is nested 4 levels deep in cause chain", async () => {
  let attempts = 0;
  const warnings: string[] = [];
  const debugs: string[] = [];
  const now = new Date();
  const level4 = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const level3 = new Error("wrap 3", { cause: level4 });
  const level2 = new Error("wrap 2", { cause: level3 });
  const level1 = new Error("wrap 1", { cause: level2 });
  const topErr = new TypeError("fetch failed", { cause: level1 });

  const guild = createMockGuild(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw topErr;
    }
    return {
      entries: new Map([
        [
          "100000000000000011",
          {
            id: "100000000000000011",
            target: { id: "200000000000000002" },
            executor: { id: "300000000000000003", username: "mod" },
            reason: "recovered after nested cause",
            createdAt: now,
            changes: [],
          },
        ],
      ]),
    };
  });

  const result = await findAuditLogForTarget({
    guild,
    action: AuditLogEvent.MemberKick,
    targetUserId: "200000000000000002",
    auditWindowSec: 60,
    defaultReasonText: "理由なし",
    isProcessedAuditId: () => false,
    warn: (_meta, message) => warnings.push(message),
    debug: (_meta, message) => debugs.push(message),
    retryDelaysMs: [0, 0, 0],
  });

  assert.equal(attempts, 2);
  assert.equal(debugs.length, 1);
  assert.equal(warnings.length, 0);
  assert.equal(result?.auditId, "100000000000000011");
});
