import { randomBytes } from "node:crypto";

/** customId 用（DiscordBOTv2 の IDS 相当。UUID はドットを含まないため 3 段分割でスコープ化） */
export const MM_IDS = {
  START_ATTACHMENT_PREFIX: "mm_satt:",
  START_ATTACHMENT_MODAL_PREFIX: "mm_sattm:",
  USER_ATTACHMENT_PREFIX: "mm_uatt:",
  USER_ATTACHMENT_MODAL_PREFIX: "mm_uattm:",
  CLOSE_PREFIX: "mm_close:",
  CLOSE_MODAL_PREFIX: "mm_closem:",
  APPROVE_PREFIX: "mm_yes:",
  REJECT_PREFIX: "mm_no:",
  REPLY_ATTACHMENT_PREFIX: "mm_ratt:",
  REPLY_ATTACHMENT_MODAL_PREFIX: "mm_rattm:",
  USER_REPLY_PREFIX: "mm_urep:",
  USER_REPLY_MODAL_PREFIX: "mm_urepm:",
  ATTACHMENT_MODAL_FILES_ID: "mm_files",
  USER_REPLY_MODAL_FILES_ID: "mm_urep_files",
} as const;

export const MODMAIL_REPLY_COMMAND = "!reply";

export function makeModmailNonce(): string {
  return randomBytes(6).toString("base64url").replace(/=/g, "").slice(0, 12);
}

/** `prefix + partA.partB.nonce`（partA は UUID、partB は snowflake を想定） */
export function buildThreePartId(prefix: string, partA: string, partB: string): string {
  return `${prefix}${partA}.${partB}.${makeModmailNonce()}`;
}

export function parseThreePartId(
  customId: string,
  prefix: string,
): { partA: string; partB: string; nonce: string } | null {
  if (!customId.startsWith(prefix)) return null;
  const rest = customId.slice(prefix.length);
  const parts = rest.split(".");
  if (parts.length !== 3) return null;
  return { partA: parts[0]!, partB: parts[1]!, nonce: parts[2]! };
}

/** 承認・却下・クローズ: `prefix + <uuid>` */
export function parseUuidTail(customId: string, prefix: string): string | null {
  if (!customId.startsWith(prefix)) return null;
  const id = customId.slice(prefix.length).trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return id;
}
