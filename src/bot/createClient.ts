import { Client, GatewayIntentBits, Partials } from "discord.js";

export const CLIENT_INTENT_NAMES = [
  "Guilds",
  "GuildMessages",
  "GuildMessageReactions",
  "DirectMessages",
  "MessageContent",
  "GuildMembers",
  "GuildModeration",
  "GuildVoiceStates",
] as const;

export function createDiscordClient(): Client {
  return new Client({
    intents: CLIENT_INTENT_NAMES.map((name) => GatewayIntentBits[name]),
    partials: [Partials.Message, Partials.Reaction, Partials.Channel],
  });
}
