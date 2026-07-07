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

  toText(): string {
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
    if (this.data.footer?.text || this.data.timestamp) {
      if (lines.length) lines.push("");
      const footer = [this.data.footer?.text, this.data.timestamp].filter(Boolean).join(" / ");
      lines.push(footer);
    }
    return lines.join("\n").slice(0, 4000);
  }

  toContainer(): APIContainerComponent {
    const content = this.toText();
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
    const components: APIContainerComponent["components"] = [
      ...(content
        ? [{
          type: ComponentType.TextDisplay,
          content,
        } satisfies APITextDisplayComponent]
        : []),
      ...mediaComponents,
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
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: [
      ...cards.map((card) => card.toContainer()),
      ...rows.map((row) => row.toJSON()),
    ],
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
    ...payload,
    flags: [payload.flags, MessageFlags.Ephemeral] as const,
  };
}
