import semver from "semver";

export function isVersionAllowed(botVersion: string, introducedIn: string): boolean {
  const bot = semver.coerce(botVersion);
  const intro = semver.coerce(introducedIn);
  if (!bot || !intro) return true;
  return semver.gte(bot, intro);
}

export function versionBlockedMessage(): string {
  return "現在のVerではそのコマンドは使用できません！";
}
