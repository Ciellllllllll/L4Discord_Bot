import { REST, Routes } from "discord.js";
import type { AppConfig } from "../core/config.js";
import { buildSlashCommands } from "../commands/buildSlashCommands.js";

export async function syncGuildApplicationCommands(config: AppConfig): Promise<void> {
  if (config.SKIP_COMMAND_SYNC) return;
  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  const body = buildSlashCommands();
  await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.GUILD_ID), {
    body,
  });
}
