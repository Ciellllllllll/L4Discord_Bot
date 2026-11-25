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

test("findAuditLogForTarget retries on transient API errors", async () => {
  let attempts = 0;
  const warnings: string[] = [];
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
    retryDelaysMs: [0, 0, 0],
  });

  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1);
  assert.equal(result?.auditId, "100000000000000001");
  assert.equal(result?.actorId, "300000000000000003");
});

test("findAuditLogForTarget returns null after exhausting all retries", async () => {
  let attempts = 0;
  const guild = createMockGuild(async () => {
    attempts += 1;
    throw new Error("ECONNRESET");
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
  assert.equal(result, null);
});

test("findAuditLogForTarget stops immediately on Discord API error code (50013)", async () => {
  let attempts = 0;
  const guild = createMockGuild(async () => {
    attempts += 1;
    throw Object.assign(new Error("Missing Permissions"), { code: 50_013 });
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

  assert.equal(attempts, 1);
  assert.equal(result, null);
});

test("findAuditLogForTarget stops immediately on HTTP 403 without error code", async () => {
  let attempts = 0;
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
    warn: () => {},
    retryDelaysMs: [0, 0, 0],
  });

  assert.equal(attempts, 1);
  assert.equal(result, null);
});
