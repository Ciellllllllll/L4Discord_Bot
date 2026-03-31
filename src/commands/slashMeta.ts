import { SLASH_COMMAND_MIN_BOT_VERSION } from "../core/releaseVersions.js";

export type SlashCommandMeta = {
  name: string;
  introducedIn: string;
};

function buildSlashMeta(): Record<string, SlashCommandMeta> {
  const out: Record<string, SlashCommandMeta> = {};
  for (const [name, introducedIn] of Object.entries(SLASH_COMMAND_MIN_BOT_VERSION)) {
    out[name] = { name, introducedIn };
  }
  return out;
}

export const SLASH_META: Record<string, SlashCommandMeta> = buildSlashMeta();
