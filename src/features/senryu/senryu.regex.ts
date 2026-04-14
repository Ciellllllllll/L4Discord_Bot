import { DISCORD_TOKEN_PATTERN, SPOILER_PATTERN } from "./senryu.constants.js";

export function containsDiscordTokens(content: string): boolean {
  return DISCORD_TOKEN_PATTERN.test(content);
}

export function containsSpoiler(content: string): boolean {
  return SPOILER_PATTERN.test(content);
}

// `||` のみ除去し、中身は残す（ネストは非貪欲に繰り返し）

export function stripSpoilerMarkers(content: string): string {
  let s = content;
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/\|\|(.+?)\|\|/g, "$1");
  }
  return s;
}
