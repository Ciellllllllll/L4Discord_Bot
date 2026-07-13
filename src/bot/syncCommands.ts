import { REST, Routes } from "discord.js";
import type { Logger } from "pino";
import { buildSlashCommands } from "../commands/buildSlashCommands.js";
import type { AppConfig } from "../core/config.js";
import { getReleaseBundleForLog } from "../core/releaseVersions.js";

type CommandSyncDependencies = {
  createRest?(token: string): Pick<REST, "put">;
};

export async function syncGuildApplicationCommands(config: AppConfig, log: Logger, dependencies: CommandSyncDependencies = {}): Promise<void> {
  const body = buildSlashCommands(config.BOT_PROFILE);
  const names = body.map((c) => c.name);

  if (config.SKIP_COMMAND_SYNC) {
    log.info(
      { commandCount: names.length, guildId: config.GUILD_ID, reason: "SKIP_COMMAND_SYNC" },
      "Slash command synchronization skipped.",
    );
    log.debug({ names, release: getReleaseBundleForLog() }, "slash command synchronization details");
    return;
  }

  const rest = dependencies.createRest?.(config.DISCORD_TOKEN) ?? new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.GUILD_ID), {
      body,
    });
    log.info(
      {
        guildId: config.GUILD_ID,
        commandCount: names.length,
      },
      "Slash commands synchronized successfully.",
    );
    log.debug({ guildId: config.GUILD_ID, names, release: getReleaseBundleForLog() }, "slash command synchronization details");
  } catch (err) {
    log.error({ err, guildId: config.GUILD_ID, commandCount: names.length }, "guild slash command sync failed");
  }
}
