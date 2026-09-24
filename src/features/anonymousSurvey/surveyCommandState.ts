import {
  ApplicationCommandOptionType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type CommandInteractionOption,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type User,
} from "discord.js";

export type StoredCommandOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
  user?: {
    id: string;
    username: string;
    tag: string;
  };
  options?: StoredCommandOption[];
};

export type StoredSlashCommand = {
  commandName: string;
  guildId: string;
  channelId: string;
  userId: string;
  options: StoredCommandOption[];
};

function storeOption(option: CommandInteractionOption): StoredCommandOption {
  const stored: StoredCommandOption = {
    name: option.name,
    type: option.type,
  };
  if (typeof option.value === "string" || typeof option.value === "number" || typeof option.value === "boolean") {
    stored.value = option.value;
  }
  if (option.user) {
    stored.user = {
      id: option.user.id,
      username: option.user.username,
      tag: option.user.tag,
    };
    stored.value ??= option.user.id;
  }
  if (option.options && option.options.length > 0) {
    stored.options = option.options.map(storeOption);
  }
  return stored;
}

export function storeSlashCommand(interaction: ChatInputCommandInteraction): StoredSlashCommand {
  return {
    commandName: interaction.commandName,
    guildId: interaction.guildId!,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    options: interaction.options.data.map(storeOption),
  };
}

function activeOptions(options: StoredCommandOption[]): StoredCommandOption[] {
  const subcommand = options.find((option) => option.type === ApplicationCommandOptionType.Subcommand);
  return subcommand?.options ?? options;
}

function findOption(options: StoredCommandOption[], name: string): StoredCommandOption | undefined {
  return activeOptions(options).find((option) => option.name === name);
}

function requireValue<T>(value: T | null, required?: boolean): T | null {
  if (value === null && required) throw new Error("Required option missing");
  return value;
}

function storedUserToUser(stored: StoredCommandOption["user"]): User | null {
  if (!stored) return null;
  return {
    id: stored.id,
    username: stored.username,
    tag: stored.tag,
    bot: false,
    system: false,
    toString: () => `<@${stored.id}>`,
  } as unknown as User;
}

function createStoredOptionsResolver(options: StoredCommandOption[]) {
  return {
    data: options,
    getString(name: string, required?: boolean) {
      const value = findOption(options, name)?.value;
      return requireValue(typeof value === "string" ? value : null, required);
    },
    getInteger(name: string, required?: boolean) {
      const value = findOption(options, name)?.value;
      return requireValue(typeof value === "number" ? Math.trunc(value) : null, required);
    },
    getBoolean(name: string, required?: boolean) {
      const value = findOption(options, name)?.value;
      return requireValue(typeof value === "boolean" ? value : null, required);
    },
    getUser(name: string, required?: boolean) {
      const user = storedUserToUser(findOption(options, name)?.user);
      return requireValue(user, required);
    },
    getSubcommand(required?: boolean) {
      const subcommand = options.find((option) => option.type === ApplicationCommandOptionType.Subcommand)?.name ?? null;
      return requireValue(subcommand, required);
    },
  };
}

function hasEphemeralFlag(payload?: InteractionReplyOptions | string): boolean {
  if (!payload || typeof payload === "string") return false;
  if (payload.flags === MessageFlags.Ephemeral) return true;
  return Boolean(payload.ephemeral);
}

export function createSurveyReplayInteraction(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  command: StoredSlashCommand,
  options: { preferFollowUp?: boolean } = {},
): ChatInputCommandInteraction {
  const replay = {
    commandName: command.commandName,
    guildId: command.guildId,
    channelId: command.channelId,
    guild: interaction.guild,
    channel: interaction.channel,
    client: interaction.client,
    user: interaction.user,
    member: interaction.member,
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: createStoredOptionsResolver(command.options),
    reply: async (payload: InteractionReplyOptions | string) => {
      replay.replied = true;
      if (options.preferFollowUp) return interaction.followUp(payload as InteractionReplyOptions);
      return interaction.reply(payload as InteractionReplyOptions);
    },
    deferReply: async (payload?: InteractionReplyOptions) => {
      replay.deferred = true;
      if (options.preferFollowUp) return undefined;
      return interaction.deferReply({ ephemeral: hasEphemeralFlag(payload) });
    },
    editReply: async (payload: InteractionReplyOptions | string) => {
      if (options.preferFollowUp) return interaction.followUp(payload as InteractionReplyOptions);
      return interaction.editReply(payload as Parameters<ButtonInteraction["editReply"]>[0]);
    },
    followUp: async (payload: InteractionReplyOptions | string) => interaction.followUp(payload as InteractionReplyOptions),
    showModal: async (modal: Parameters<ButtonInteraction["showModal"]>[0]) => {
      // モーダル送信への応答として別のモーダルは開けない
      if (interaction.isModalSubmit()) throw new Error("Cannot show a modal in response to a modal submit");
      const result = await interaction.showModal(modal);
      replay.replied = true;
      return result;
    },
  };
  return replay as unknown as ChatInputCommandInteraction;
}
