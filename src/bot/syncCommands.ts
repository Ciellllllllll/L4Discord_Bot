import { REST, Routes } from "discord.js";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config.js";
import { buildSlashCommands } from "../commands/buildSlashCommands.js";

export async function syncGuildApplicationCommands(config: AppConfig, log: Logger): Promise<void> {
  const body = buildSlashCommands();
  const names = body.map((c) => c.name);

  if (config.SKIP_COMMAND_SYNC) {
    log.info({ commandCount: names.length, names, reason: "SKIP_COMMAND_SYNC" }, "guild slash command sync skipped");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.GUILD_ID), {
      body,
    });
    log.info(
      { guildId: config.GUILD_ID, commandCount: names.length, names },
      "guild slash commands registered successfully",
    );
  } catch (err) {
    log.error({ err, guildId: config.GUILD_ID, commandCount: names.length }, "guild slash command sync failed");
  }
}
