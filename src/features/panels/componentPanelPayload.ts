import {
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APITextDisplayComponent,
} from "discord.js";

type ActionRowLike = {
  toJSON(): APIActionRowComponent<APIComponentInMessageActionRow>;
};

export type ContainerPanelPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: [
    {
      type: ComponentType.Container;
      components: (APITextDisplayComponent | APIActionRowComponent<APIComponentInMessageActionRow>)[];
    },
  ];
};

export function componentTreeHasCustomId(component: unknown, customIds: Set<string>): boolean {
  if (!component || typeof component !== "object") return false;
  const c = component as { customId?: string; custom_id?: string; components?: unknown[] };
  const customId = c.customId ?? c.custom_id;
  if (customId && customIds.has(String(customId))) return true;
  return Array.isArray(c.components) && c.components.some((child) => componentTreeHasCustomId(child, customIds));
}

export function messageComponentsHaveCustomId(
  components: readonly unknown[] | undefined,
  customIds: Set<string>,
): boolean {
  return Boolean(components?.some((component) => componentTreeHasCustomId(component, customIds)));
}

export function buildContainerPanelPayload(text: string, rows: readonly ActionRowLike[]): ContainerPanelPayload {
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: text,
          },
          ...rows.map((row) => row.toJSON()),
        ],
      },
    ],
  };
}
