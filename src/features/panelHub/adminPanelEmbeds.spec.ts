import assert from "node:assert/strict";
import { ComponentType, MessageFlags, type MessageCreateOptions } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { PERMANENT_UI_VERSION } from "../../core/releaseVersions.js";
import { buildAiHistoryAdminPanelPayload } from "../ai/aiHistoryAdminPanel.js";
import { buildAutoModPanelPayload } from "../moderation/autoModerationPanel.js";
import { buildReactionRoleAdminPanelPayload } from "../reactionRoles/reactionRoleService.js";
import { buildReminderHubPanelPayload } from "../reminders/reminderHubPayload.js";
import { buildVcCreatorMainPayload } from "../vc/vcCreatorUi.js";
import { buildMessageLogPanelPayload } from "./adminPanelsPayload.js";
import { buildUserContactPanelPayload } from "../panels/userPanelsPayload.js";

function containerText(payload: MessageCreateOptions): string {
  assert.equal(payload.embeds?.length ?? 0, 0);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in payload, false);
  const container = payload.components?.[0] as {
    type: ComponentType;
    accent_color?: number | null;
    components?: { type: ComponentType; content?: string }[];
  };
  assert.equal(container.type, ComponentType.Container);
  assert.equal("accent_color" in container, false);
  return container.components?.find((component) => component.type === ComponentType.TextDisplay)?.content ?? "";
}

function assertPanelContainer(payload: MessageCreateOptions, heading: string): void {
  const text = containerText(payload);
  assert.ok(text.startsWith(`## ${heading}`));
}

function containerChildren(payload: MessageCreateOptions): Array<{
  type: ComponentType;
  content?: string;
  components?: Array<{
    type: ComponentType;
    options?: Array<{ label?: string; description?: string }>;
  }>;
}> {
  const container = payload.components?.[0] as {
    type: ComponentType;
    components?: Array<{
      type: ComponentType;
      content?: string;
      components?: Array<{
        type: ComponentType;
        options?: Array<{ label?: string; description?: string }>;
      }>;
    }>;
  };
  assert.equal(container.type, ComponentType.Container);
  return container.components ?? [];
}

function makeAutomodCtx(): Pick<CoreDeps, "config" | "automodDb" | "db"> {
  const emptySelect = {
    selectAll: () => emptySelect,
    where: () => emptySelect,
    executeTakeFirst: async () => undefined,
  };
  return {
    config: {
      MOD_LOG_CHANNEL_ID: "123456789012345678",
      LOGGER_CHANNEL_ID: "",
      LOG_CHANNEL_ID: "",
    },
    automodDb: {
      selectFrom: () => emptySelect,
    },
  } as unknown as Pick<CoreDeps, "config" | "automodDb" | "db">;
}

function makeAiHistoryCtx(): Pick<CoreDeps, "aiHistoryDb" | "client"> {
  const emptySelect = {
    select: () => emptySelect,
    where: () => emptySelect,
    groupBy: () => emptySelect,
    orderBy: () => emptySelect,
    execute: async () => [],
  };
  return {
    client: {
      users: {
        cache: new Map(),
      },
    },
    aiHistoryDb: {
      selectFrom: () => emptySelect,
    },
  } as unknown as Pick<CoreDeps, "aiHistoryDb" | "client">;
}

async function run(): Promise<void> {
  assertPanelContainer(buildMessageLogPanelPayload(), "メッセージログ");
  assert.match(containerText(buildMessageLogPanelPayload()), /検索条件/);
  assert.match(containerText(buildMessageLogPanelPayload()), /管理者向け/);

  assertPanelContainer(buildReminderHubPanelPayload(), "お知らせ関連管理");
  assert.match(containerText(buildReminderHubPanelPayload()), /リマインダー/);
  assert.match(containerText(buildReminderHubPanelPayload()), /確認・編集/);

  assertPanelContainer(buildVcCreatorMainPayload(), "VC作成");
  assert.match(containerText(buildVcCreatorMainPayload()), /自動削除/);
  assert.doesNotMatch(containerText(buildVcCreatorMainPayload()), /[🟢⚪🟠🔴🟣🔵]/u);

  assertPanelContainer(buildUserContactPanelPayload(), "サポート・お問い合わせ");
  const userContactText = containerText(buildUserContactPanelPayload());
  assert.match(userContactText, /スタッフへ個別に相談/);
  assert.doesNotMatch(userContactText, /Modmail|Admin panel|Role panel/);

  const reactionRole = buildReactionRoleAdminPanelPayload("<#123456789012345678>");
  assertPanelContainer(reactionRole, "リアクションロール管理");
  assert.match(containerText(reactionRole), /最大5件/);
  assert.match(containerText(reactionRole), /入力形式/);

  const automodPayload = await buildAutoModPanelPayload(makeAutomodCtx(), "guild");
  assertPanelContainer(automodPayload, "自動モデレーション管理");
  const automodText = containerText(automodPayload);
  assert.match(automodText, /Raidモード/);
  assert.doesNotMatch(automodText, /AUTO MOD|RAID MODE/);
  assert.doesNotMatch(automodText, /[🟢⚪🟠🔴🟣🔵]/u);
  assert.match(automodText, /全体: \*\*ON\*\*/);
  assert.match(automodText, /スパム判定時間: \*\*8秒\*\*/);
  const automodSelect = containerChildren(automodPayload)
    .find((component) => component.type === ComponentType.ActionRow)
    ?.components?.find((component) => component.type === ComponentType.StringSelect);
  const automodOptionLabels = automodSelect?.options?.map((option) => option.label ?? "") ?? [];
  assert.ok(automodOptionLabels.includes("全体を有効化"));
  assert.equal(automodOptionLabels.some((label) => label.includes("自動モデレーション全体")), false);

  const aiHistory = await buildAiHistoryAdminPanelPayload(makeAiHistoryCtx(), "guild");
  assertPanelContainer(aiHistory, "/q 履歴管理");
  const aiHistoryText = containerText(aiHistory);
  assert.match(aiHistoryText, /会話履歴/);
  assert.match(aiHistoryText, /現在の状態/);
  assert.doesNotMatch(aiHistoryText, /[🟢⚪🟠🔴🟣🔵]/u);

  for (const kind of [
    "reaction_role_admin",
    "message_log_panel",
    "ai_query_history_admin",
    "reminder_hub",
  ]) {
    assert.equal(PERMANENT_UI_VERSION[kind], "1.2.1");
  }
  assert.equal(PERMANENT_UI_VERSION.automod_panel, "1.2.1");
  assert.equal(PERMANENT_UI_VERSION.vc_creator, "1.2.0");
  assert.equal(PERMANENT_UI_VERSION.user_contact_panel, "1.2.0");
}

void run()
  .then(() => {
    console.log("adminPanelEmbeds.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
