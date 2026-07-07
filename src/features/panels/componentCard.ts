import {
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIContainerComponent,
  type APIMediaGalleryComponent,
  type APIMessageTopLevelComponent,
  type APITextDisplayComponent,
} from "discord.js";

type ActionRowLike = {
  toJSON(): APIActionRowComponent<APIComponentInMessageActionRow>;
};

type CardField = {
  name: string;
  value: string;
  inline?: boolean;
};

type FooterData = {
  text: string;
  iconURL?: string;
};

type ImageData = {
  url?: string;
};

type AuthorData = {
  name: string;
  iconURL?: string;
  url?: string;
};

export class ComponentCardBuilder {
  public data: {
    title?: string;
    description?: string;
    fields?: CardField[];
    footer?: FooterData;
    author?: AuthorData;
    thumbnail?: ImageData;
    image?: ImageData;
    timestamp?: string;
    url?: string;
    actionRows?: ActionRowLike[];
    bottomActionRows?: ActionRowLike[];
    textDisplays?: string[];
  } = {};

  setTitle(title: string): this {
    this.data.title = title;
    return this;
  }

  setDescription(description: string): this {
    this.data.description = description;
    return this;
  }

  setColor(_color: number): this {
    return this;
  }

  setTimestamp(date = new Date()): this {
    this.data.timestamp = date.toISOString();
    return this;
  }

  setFooter(footer: FooterData): this {
    this.data.footer = footer;
    return this;
  }

  setAuthor(author: AuthorData): this {
    this.data.author = author;
    return this;
  }

  setURL(url: string | null | undefined): this {
    if (url) this.data.url = url;
    return this;
  }

  setThumbnail(url: string | null | undefined): this {
    if (url) this.data.thumbnail = { url };
    return this;
  }

  setImage(url: string | null | undefined): this {
    if (url) this.data.image = { url };
    return this;
  }

  addFields(...fields: (CardField | CardField[])[]): this {
    const flat = fields.flat();
    this.data.fields = [...(this.data.fields ?? []), ...flat];
    return this;
  }

  addActionRows(...rows: ActionRowLike[]): this {
    this.data.actionRows = [...(this.data.actionRows ?? []), ...rows];
    return this;
  }

  addBottomActionRows(...rows: ActionRowLike[]): this {
    this.data.bottomActionRows = [...(this.data.bottomActionRows ?? []), ...rows];
    return this;
  }

  addTextDisplays(...contents: string[]): this {
    const filtered = contents.map((content) => content.slice(0, 4000)).filter((content) => content.length > 0);
    this.data.textDisplays = [...(this.data.textDisplays ?? []), ...filtered];
    return this;
  }

  private toTextParts(): { body: string; footer: string } {
    const lines: string[] = [];
    if (this.data.author?.name) {
      lines.push(`**${this.data.author.name}**`);
    }
    if (this.data.title) {
      lines.push(`## ${this.data.title}`);
    }
    if (this.data.url) {
      lines.push(this.data.url);
    }
    if (this.data.description) {
      if (lines.length) lines.push("");
      lines.push(this.data.description);
    }
    for (const field of this.data.fields ?? []) {
      if (lines.length) lines.push("");
      lines.push(`**${field.name}**`);
      lines.push(field.value || "-");
    }
    let footer = "";
    if (this.data.footer?.text || this.data.timestamp) {
      footer = [this.data.footer?.text, this.data.timestamp].filter(Boolean).join(" / ");
    }
    return { body: lines.join("\n").slice(0, 4000), footer };
  }

  toText(): string {
    const { body, footer } = this.toTextParts();
    return [body, footer].filter(Boolean).join("\n\n").slice(0, 4000);
  }

  toContainer(): APIContainerComponent {
    const { body, footer } = this.toTextParts();
    const mediaComponents = [this.data.image, this.data.thumbnail]
      .filter((image): image is ImageData & { url: string } => Boolean(image?.url))
      .map((image): APIMediaGalleryComponent => ({
        type: ComponentType.MediaGallery,
        items: [
          {
            media: { url: image.url },
          },
        ],
      }));
    const actionRows = (this.data.actionRows ?? []).map((row) => row.toJSON());
    const bottomActionRows = (this.data.bottomActionRows ?? []).map((row) => row.toJSON());
    const textDisplays = (this.data.textDisplays ?? []).map((content): APITextDisplayComponent => ({
      type: ComponentType.TextDisplay,
      content,
    }));
    const components: APIContainerComponent["components"] = [
      ...(body
        ? [{
          type: ComponentType.TextDisplay,
          content: body,
        } satisfies APITextDisplayComponent]
        : []),
      ...textDisplays,
      ...actionRows,
      ...(footer
        ? [{
          type: ComponentType.TextDisplay,
          content: footer,
        } satisfies APITextDisplayComponent]
        : []),
      ...mediaComponents,
      ...bottomActionRows,
    ];
    if (components.length === 0) {
      components.push({
        type: ComponentType.TextDisplay,
        content: "\u200b",
      });
    }
    return {
      type: ComponentType.Container,
      components,
    };
  }
}

export type ComponentCardsPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
};

export type EphemeralComponentCardsPayload = Omit<ComponentCardsPayload, "flags"> & {
  flags: readonly [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral];
};

export function componentCardsPayload(
  cards: readonly ComponentCardBuilder[],
  rows: readonly ActionRowLike[] = [],
): ComponentCardsPayload {
  const containers = cards.map((card) => card.toContainer());
  const rowComponents = rows.map((row) => row.toJSON());
  if (containers.length > 0 && rowComponents.length > 0) {
    containers[containers.length - 1]!.components.push(...rowComponents);
  }
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: containers.length > 0 ? containers : rowComponents,
  };
}

export function singleComponentCardPayload(
  card: ComponentCardBuilder,
  rows: readonly ActionRowLike[] = [],
): ComponentCardsPayload {
  return componentCardsPayload([card], rows);
}

export function ephemeralComponentCardsPayload(
  cards: readonly ComponentCardBuilder[],
  rows: readonly ActionRowLike[] = [],
): EphemeralComponentCardsPayload {
  return ephemeralComponentPayload(componentCardsPayload(cards, rows));
}

export function ephemeralComponentPayload(payload: ComponentCardsPayload): EphemeralComponentCardsPayload {
  return {
    embeds: [],
    components: payload.components,
    flags: [payload.flags, MessageFlags.Ephemeral] as const,
  };
}
