import { ComponentCardBuilder, componentCardsPayload, type ComponentCardsPayload } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Message,
} from "discord.js";
import {
  buildContainerPanelPayload,
  messageComponentsHaveCustomId,
  type ContainerPanelPayload,
} from "../panels/componentPanelPayload.js";
import {
  cut,
  dueToInput,
  EDIT_MODAL_PREFIX,
  EVENT_META,
  EVENT_TYPES,
  formatDue,
  formatRecurrenceLabel,
  normalizeEventType,
  RECURRENCE_INPUT_MAX,
  recurrenceToInput,
  type ReminderEvType,
} from "./reminderHubTypes.js";
import type { ReminderHubRowView } from "./reminderHubRepo.js";

export type ReminderHubPanelPayload = ContainerPanelPayload;
export type ReminderHubMessagePayload = ComponentCardsPayload;

const HUB_IDS = new Set(["reminder_create", "todo_create", "notice_create", "reminder_manage", "reminder_list"]);

function messageHasAnyCustomId(message: Message, customIds: Set<string>): boolean {
  if (!message.components?.length) return false;
  return messageComponentsHaveCustomId(message.components, customIds);
}

export function reminderHubPanelMessageMatches(message: Message, botUserId: string): boolean {
  if (message.author?.id !== botUserId) return false;
  return messageHasAnyCustomId(message, HUB_IDS);
}

export function buildReminderHubPanelPayload(): ReminderHubPanelPayload {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("reminder_create").setLabel("リマインダー作成").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("todo_create").setLabel("TODO作成").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("notice_create").setLabel("運営お知らせ").setStyle(ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("reminder_manage").setLabel("確認・編集").setStyle(ButtonStyle.Secondary),
  );

  return buildContainerPanelPayload(
    [
      "## お知らせ関連管理",
      "リマインダー、TODO、運営お知らせを作成・確認できます。",
      "",
      "**作成**   リマインダー   TODO   運営お知らせ",
      "**管理**   確認・編集   即時投稿   削除",
      "日時入力: `+10m` `+2h` `2026-03-20 09:00`",
      "",
    ].join("\n"),
    [row1, row2],
  );
}

export function buildCreateChannelPayload(kind: ReminderEvType): ReminderHubMessagePayload {
  const normalized = normalizeEventType(kind);
  const meta = EVENT_META[normalized];

  const embed = new ComponentCardBuilder()
    .setTitle(`${meta.createLabel}: 投稿先チャンネルを選択`)
    .setDescription("投稿先チャンネルを選択してください。選択後に入力画面を開きます。")

  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`rem_create_channel:${normalized}`)
      .setPlaceholder("投稿先チャンネルを選択")
      .setMinValues(1)
      .setMaxValues(1)
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ),
  );

  return componentCardsPayload([embed], [channelRow]);
}

function buildManageTabsRow(activeKind: ReminderEvType): ActionRowBuilder<ButtonBuilder> {
  const buttons = EVENT_TYPES.map((k) =>
    new ButtonBuilder()
      .setCustomId(`rem_manage_tab:${k}`)
      .setLabel(EVENT_META[k].label)
      .setStyle(k === activeKind ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );

  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

export function buildManageListPayload(
  kind: ReminderEvType,
  rows: ReminderHubRowView[],
  noticeText = "",
): ReminderHubMessagePayload {
  const normalized = normalizeEventType(kind);
  const title = `${EVENT_META[normalized].label}の確認・編集`;
  const descriptionLines: string[] = [];

  if (noticeText) {
    descriptionLines.push(noticeText);
    descriptionLines.push("");
  }

  if (!rows.length) {
    descriptionLines.push(`有効な${EVENT_META[normalized].label}はありません。`);
  } else {
    descriptionLines.push("下のプルダウンから対象を選択してください。");
    descriptionLines.push("");
    for (const row of rows.slice(0, 10)) {
      descriptionLines.push(
        `#${row.id} ${cut(row.title || "(無題)", 40)} | ${formatDue(row.fire_at)} | <#${row.channel_id}>`,
      );
    }
    if (rows.length > 10) {
      descriptionLines.push(`...他 ${rows.length - 10} 件`);
    }
  }

  const embed = new ComponentCardBuilder()
    .setTitle(title)
    .setDescription(descriptionLines.join("\n"))

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [buildManageTabsRow(normalized)];

  if (rows.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rem_manage_pick:${normalized}`)
      .setPlaceholder(`${EVENT_META[normalized].label}を選択`)
      .addOptions(
        rows.slice(0, 25).map((row) => ({
          label: `#${cut(row.id, 20)} ${cut(row.title || "(無題)", 60)}`,
          description: cut(`${formatDue(row.fire_at)} / ${row.channel_id}`, 100),
          value: row.id,
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rem_manage_refresh:${normalized}`).setLabel("再読み込み").setStyle(ButtonStyle.Secondary),
    ),
  );

  return componentCardsPayload([embed], components);
}

export function buildManageDetailPayload(row: ReminderHubRowView, noticeText = ""): ReminderHubMessagePayload {
  const kind = normalizeEventType(row.ev_type);

  const embed = new ComponentCardBuilder()
    .setTitle(`${EVENT_META[kind].label} #${row.id}`)
    .addFields(
      { name: "タイトル", value: cut(row.title || "(無題)", 1024) },
      { name: "本文", value: cut(row.body || "(本文なし)", 1024) },
      { name: "期限", value: formatDue(row.fire_at), inline: true },
      { name: "繰り返し", value: formatRecurrenceLabel(row.recurrence_json), inline: true },
      { name: "投稿先", value: `<#${row.channel_id}>`, inline: true },
    );

  if (noticeText) {
    embed.setDescription(noticeText);
  } else {
    embed.setDescription("下のボタンで編集・削除・即時投稿を行えます。");
  }

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rem_manage_edit:${row.id}`).setLabel("編集").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rem_manage_delete:${row.id}`).setLabel("削除").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rem_manage_post:${row.id}`).setLabel("即時投稿").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rem_manage_back:${kind}`).setLabel("一覧に戻る").setStyle(ButtonStyle.Secondary),
  );

  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`rem_manage_channel_pick:${row.id}`)
      .setPlaceholder("投稿先チャンネルを変更")
      .setMinValues(1)
      .setMaxValues(1)
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ),
  );

  return componentCardsPayload([embed], [buildManageTabsRow(kind), actionRow, channelRow]);
}

export function buildCreateModal(kind: ReminderEvType, channelId: string): ModalBuilder {
  const normalized = normalizeEventType(kind);
  const modalTitle = EVENT_META[normalized].createLabel;
  const initialTitleMap: Record<ReminderEvType, string> = {
    reminder: "📅リマインダー",
    todo: "📌TODO",
    notice: "📢運営お知らせ",
  };

  return new ModalBuilder()
    .setCustomId(`reminder_modal:${normalized}:${channelId}`)
    .setTitle(modalTitle.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("タイトル")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(initialTitleMap[normalized]),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("body")
          .setLabel("本文")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("due_at")
          .setLabel("期限 (+10m / +2h / 2026-03-20 09:00)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("recurrence")
          .setLabel("繰り返し (任意: 10m / 1h / 1d)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(RECURRENCE_INPUT_MAX),
      ),
    );
}

export function buildEditModal(row: ReminderHubRowView): ModalBuilder {
  const kind = normalizeEventType(row.ev_type);

  return new ModalBuilder()
    .setCustomId(`${EDIT_MODAL_PREFIX}:${row.id}`)
    .setTitle(`${EVENT_META[kind].label}編集`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("タイトル")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(cut(row.title || "", 100)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("body")
          .setLabel("本文")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500)
          .setValue(cut(row.body || "", 1500)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("due_at")
          .setLabel("期限 (+10m / +2h / 2026-03-20 09:00)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(cut(dueToInput(row.fire_at), 80)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("recurrence")
          .setLabel("繰り返し (任意: 10m / 1h / 1d)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(RECURRENCE_INPUT_MAX)
          .setValue(cut(recurrenceToInput(row.recurrence_json), RECURRENCE_INPUT_MAX)),
      ),
    );
}
