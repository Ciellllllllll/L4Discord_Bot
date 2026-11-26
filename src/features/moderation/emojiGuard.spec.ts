import assert from "node:assert/strict";
import { test } from "node:test";
import { messageContainsEmoji } from "./emojiGuard.js";

test("messageContainsEmoji does not flag non-allowlisted text-default symbols or FE0E-qualified allowlisted symbols", () => {
  for (const text of [
    "〰",
    "〽",
    "㊗",
    "㊙",
    "⌨",
    "♀",
    "♂",
    "♨",
    "©",
    "®",
    "™",
    "‼",
    "⁉",
    "↔",
    "↩",
    "↪",
    "ℹ",
    "★",
    "☆",
    "★5 レビュー",
    "1",
    "#",
    "*",
    "Copyright © 2026",
    "♥\uFE0E",
    "❤\uFE0E",
    "▶\uFE0E",
    "✉\uFE0E",
  ]) {
    assert.equal(messageContainsEmoji(text), false, `expected false for: ${text}`);
  }
});

test("messageContainsEmoji detects Emoji_Presentation, FE0F, allowlisted text-default, ZWJ, flag, keycap, skin-tone, unassigned Extended_Pictographic, and custom emojis", () => {
  for (const text of [
    "😀",
    "😀\uFE0E",
    "👍\uFE0E",
    "🔥",
    "👍🏽",
    // 明示的許可リスト（16文字すべて）
    "❤",
    "♥",
    "♠",
    "♣",
    "♦",
    "✔",
    "✌",
    "☺",
    "☀",
    "▶",
    "◀",
    "⬆",
    "⬇",
    "⬅",
    "➡",
    "✉",
    // U+FE0F 付きの Emoji
    "〰\uFE0F",
    "©\uFE0F",
    "‼️",
    "❤️",
    "♨\uFE0F",
    // ZWJ・国旗・キーキャップ
    "👨‍👩‍👧",
    "🇯🇵",
    "1️⃣",
    // Unicode 未割り当ての Extended_Pictographic 領域（将来の絵文字候補 U+1FAF9）
    "\u{1FAF9}",
    "<:custom:123456789012345678>",
    "<a:anim:123456789012345678>",
  ]) {
    assert.equal(messageContainsEmoji(text), true, `expected true for: ${text}`);
  }
});
