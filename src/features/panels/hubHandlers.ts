import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { isAdmin, isOwner } from "../../core/permission.js";
import { reconcilePanelsForGuild } from "./panelService.js";

const ML_INPUT = "ml_query";

async function hubCreateModmail(ctx: BotContext, guildId: string, uid: string, from: string): Promise<void> {
  await ctx.db
    .insertInto("modmail_threads")
    .values({
      id: randomUUID(),
      guild_id: guildId,
      user_id: uid,
      channel_id: null,
      thread_id: null,
      status: "open",
      data: JSON.stringify({ from }) as unknown as Record<string, unknown>,
      created_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();
}

async function hubCreateTicket(ctx: BotContext, guildId: string, uid: string, from: string): Promise<void> {
  await ctx.db
    .insertInto("tickets")
    .values({
      id: randomUUID(),
      guild_id: guildId,
      kind: "user",
      status: "open",
      opener_id: uid,
      assignee_id: null,
      data: JSON.stringify({ from }) as unknown as Record<string, unknown>,
      created_at: sqliteTimestamp() as unknown as Date,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();
}

async function dispatchSharedHubSelect(
  v: string,
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
  guildId: string,
  uid: string,
): Promise<boolean> {
  if (v === "bl") {
    const row = await ctx.db
      .selectFrom("economy_accounts")
      .select(["balance", "xp"])
      .where("guild_id", "=", guildId)
      .where("user_id", "=", uid)
      .executeTakeFirst();
    await interaction.reply({
      content: row ? `残高: **${row.balance}** / XP: **${row.xp}**` : "口座がありません（0扱い）。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "vc") {
    const rows = await ctx.db
      .selectFrom("vc_panel_configs")
      .select(["name", "category_id"])
      .where("guild_id", "=", guildId)
      .execute();
    const lines = rows.map((r) => `- **${r.name}** → <#${r.category_id}>`);
    await interaction.reply({
      content:
        rows.length > 0
          ? `次のカテゴリでボイスチャンネルを作成できます。\n${lines.join("\n")}`.slice(0, 1900)
          : "ボイスチャンネル作成の案内は、いまは準備中です。ご利用になりたい場合はモデレーターまでお知らせください。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "wj") {
    const g = await ctx.db
      .selectFrom("werewolf_games")
      .select(["id", "channel_id"])
      .where("guild_id", "=", guildId)
      .where("phase", "=", "lobby")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (!g) {
      await interaction.reply({ content: "募集中の人狼はありません。", ephemeral: true });
      return true;
    }
    const row = await ctx.db
      .selectFrom("werewolf_games")
      .selectAll()
      .where("id", "=", g.id)
      .executeTakeFirst();
    if (!row) {
      await interaction.reply({ content: "取得に失敗しました。", ephemeral: true });
      return true;
    }
    const rawSt = row.state;
    const st =
      typeof rawSt === "string"
        ? (JSON.parse(rawSt) as Record<string, unknown>)
        : (rawSt as Record<string, unknown>);
    const participants: string[] = Array.isArray(st.participants) ? (st.participants as string[]) : [];
    if (!participants.includes(uid)) participants.push(uid);
    await ctx.db
      .updateTable("werewolf_games")
      .set({
        state: JSON.stringify({ ...st, participants }) as unknown as Record<string, unknown>,
        updated_at: sqliteTimestamp() as unknown as Date,
      })
      .where("id", "=", row.id)
      .execute();
    await interaction.reply({ content: `ロビーに参加しました。募集チャンネル: <#${g.channel_id}>`, ephemeral: true });
    return true;
  }
  if (v === "st") {
    const rows = await ctx.db
      .selectFrom("stamp_usage")
      .select("count")
      .where("guild_id", "=", guildId)
      .where("user_id", "=", uid)
      .execute();
    const total = rows.reduce((a, r) => a + Number(r.count), 0);
    await interaction.reply({ content: `スタンプ利用合計: **${total}**`, ephemeral: true });
    return true;
  }
  if (v === "vr") {
    const rows = await ctx.vcRanking.getRanking(guildId, "week");
    if (rows.length === 0) {
      await interaction.reply({ content: "VCランキングデータがありません。", ephemeral: true });
      return true;
    }
    const lines = rows.slice(0, 10).map((r, i) => `${i + 1}. <@${r.userId}> — ${r.seconds}s`);
    await interaction.reply({ content: lines.join("\n").slice(0, 1900), ephemeral: true });
    return true;
  }
  return false;
}

async function dispatchAdminOnlyHubSelect(
  v: string,
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<boolean> {
  if (v === "ml") {
    const modal = new ModalBuilder()
      .setCustomId("panels:m:ml")
      .setTitle("メッセージログ検索")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(ML_INPUT)
            .setLabel("検索語")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }
  if (v === "tk") {
    const rows = await ctx.db
      .selectFrom("tickets")
      .select(["id", "kind", "status", "created_at"])
      .where("guild_id", "=", guildId)
      .orderBy("created_at", "desc")
      .limit(15)
      .execute();
    const lines = rows.map((r) => `- \`${r.id.slice(0, 8)}\` ${r.kind} / ${r.status}`);
    await interaction.reply({
      content: lines.length ? lines.join("\n").slice(0, 1900) : "チケットはありません。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "mm") {
    const rows = await ctx.db
      .selectFrom("modmail_threads")
      .select(["id", "user_id", "status", "created_at"])
      .where("guild_id", "=", guildId)
      .orderBy("created_at", "desc")
      .limit(15)
      .execute();
    const lines = rows.map((r) => `- <@${r.user_id}> \`${r.id.slice(0, 8)}\` ${r.status}`);
    await interaction.reply({
      content: lines.length ? lines.join("\n").slice(0, 1900) : "Modmail はありません。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "dm") {
    const inc = await ctx.db
      .selectFrom("detecter_incidents")
      .select(["id", "target_id", "action_type", "created_at"])
      .where("guild_id", "=", guildId)
      .orderBy("created_at", "desc")
      .limit(10)
      .execute();
    const tks = await ctx.db
      .selectFrom("tickets")
      .select(["id", "kind", "status"])
      .where("guild_id", "=", guildId)
      .where("kind", "=", "appeal")
      .orderBy("created_at", "desc")
      .limit(10)
      .execute();
    const a = inc.map((r) => `- inc \`${r.id.slice(0, 8)}\` <@${r.target_id}> ${r.action_type}`);
    const b = tks.map((r) => `- appeal \`${r.id.slice(0, 8)}\` ${r.status}`);
    await interaction.reply({
      content: [...a, ...b].join("\n").slice(0, 1900) || "データなし。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "em") {
    const s = await getGuildSettingsData(ctx.db, guildId);
    const ids = s.emoji_restricted_user_ids ?? [];
    await interaction.reply({
      content: ids.length ? `制限中: ${ids.map((x) => `<@${x}>`).join(", ")}`.slice(0, 1900) : "制限ユーザーはいません。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "ec") {
    const rows = await ctx.db
      .selectFrom("economy_accounts")
      .select(["user_id", "balance"])
      .where("guild_id", "=", guildId)
      .orderBy("balance", "desc")
      .limit(10)
      .execute();
    const lines = rows.map((r, i) => `${i + 1}. <@${r.user_id}> — ${r.balance}`);
    await interaction.reply({
      content: lines.length ? lines.join("\n") : "経済データなし。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "wl") {
    const rows = await ctx.db
      .selectFrom("werewolf_games")
      .select(["id", "phase", "channel_id", "host_id"])
      .where("guild_id", "=", guildId)
      .orderBy("updated_at", "desc")
      .limit(10)
      .execute();
    const lines = rows.map((r) => `- \`${r.id.slice(0, 8)}\` ${r.phase} ch:${r.channel_id} host:<@${r.host_id}>`);
    await interaction.reply({
      content: lines.length ? lines.join("\n").slice(0, 1900) : "人狼ゲームなし。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "pl") {
    const rows = await ctx.db
      .selectFrom("polls")
      .select(["id", "kind", "status", "ends_at"])
      .where("guild_id", "=", guildId)
      .orderBy("created_at", "desc")
      .limit(10)
      .execute();
    const lines = rows.map((r) => `- \`${r.id.slice(0, 8)}\` ${r.kind} ${r.status}`);
    await interaction.reply({
      content: lines.length ? lines.join("\n") : "投票なし。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "rm") {
    const rows = await ctx.db
      .selectFrom("reminders")
      .select(["id", "body", "fire_at", "status"])
      .where("guild_id", "=", guildId)
      .orderBy("fire_at", "asc")
      .limit(15)
      .execute();
    const lines = rows.map((r) => `- \`${r.id.slice(0, 8)}\` ${r.fire_at} ${r.status}: ${r.body.slice(0, 60)}`);
    await interaction.reply({
      content: lines.length ? lines.join("\n").slice(0, 1900) : "リマインダーなし。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "an") {
    const rows = await ctx.db
      .selectFrom("announcements")
      .select(["id", "title", "status", "scheduled_at"])
      .where("guild_id", "=", guildId)
      .orderBy("created_at", "desc")
      .limit(10)
      .execute();
    const lines = rows.map((r) => `- \`${r.id.slice(0, 8)}\` [${r.status}] ${r.title}`);
    await interaction.reply({
      content: lines.length ? lines.join("\n").slice(0, 1900) : "お知らせなし。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "rr") {
    const rows = await ctx.db
      .selectFrom("reaction_role_messages")
      .select(["id", "channel_id", "message_id"])
      .where("guild_id", "=", guildId)
      .execute();
    const lines = rows.map((r) => `- \`${r.id.slice(0, 8)}\` <#${r.channel_id}> / ${r.message_id}`);
    await interaction.reply({
      content: lines.length ? lines.join("\n").slice(0, 1900) : "リアクションロール登録なし。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "ah") {
    const rows = await ctx.db.selectFrom("ai_history").select("id").where("guild_id", "=", guildId).execute();
    await interaction.reply({ content: `AI履歴件数: **${rows.length}**`, ephemeral: true });
    return true;
  }
  if (v === "vc_cfg") {
    const rows = await ctx.db
      .selectFrom("vc_panel_configs")
      .select(["id", "name", "category_id"])
      .where("guild_id", "=", guildId)
      .execute();
    if (rows.length === 0) {
      await interaction.reply({
        content:
          "**VCパネル（管理）**\n登録済みのカテゴリはありません。ユーザーパネル「ボイスチャンネル作成の案内」に表示するには、DB の `vc_panel_configs` に `name`（表示名）と `category_id`（DiscordカテゴリID）を登録してください。",
        ephemeral: true,
      });
      return true;
    }
    const lines = rows.map(
      (r) => `- \`${r.id.slice(0, 8)}\` **${r.name}** → <#${r.category_id}>（category_id: \`${r.category_id}\`）`,
    );
    await interaction.reply({
      content: `**VCパネル登録一覧**（ユーザー向け案内と同じ内容の元データ）\n${lines.join("\n")}`.slice(0, 1900),
      ephemeral: true,
    });
    return true;
  }
  return false;
}

export async function handleAdminHubSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId !== "panels:s:admin") return false;
  const member = interaction.member && "roles" in interaction.member ? interaction.member : null;
  if (!isAdmin(member as never, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return true;
  }
  const v = interaction.values[0];
  const guildId = interaction.guildId ?? ctx.config.GUILD_ID;
  if (await dispatchAdminOnlyHubSelect(v, interaction, ctx, guildId)) return true;
  await interaction.reply({ content: "未実装のメニューです。", ephemeral: true });
  return true;
}

export async function handleUserHubSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId !== "panels:s:user") return false;
  const v = interaction.values[0];
  const guildId = interaction.guildId ?? ctx.config.GUILD_ID;
  const uid = interaction.user.id;

  if (await dispatchSharedHubSelect(v, interaction, ctx, guildId, uid)) return true;

  if (v === "mm") {
    await hubCreateModmail(ctx, guildId, uid, "user_hub");
    await interaction.reply({
      content: "Modmail を受け付けました。スタッフからの連絡をお待ちください。",
      ephemeral: true,
    });
    return true;
  }
  if (v === "tk") {
    await hubCreateTicket(ctx, guildId, uid, "user_hub");
    await interaction.reply({ content: "チケットを作成しました。", ephemeral: true });
    return true;
  }
  await interaction.reply({ content: "未実装です。", ephemeral: true });
  return true;
}

export async function handlePanelModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  if (interaction.customId !== "panels:m:ml") return false;
  const member = interaction.member && "roles" in interaction.member ? interaction.member : null;
  if (!isAdmin(member as never, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return true;
  }
  const q = interaction.fields.getTextInputValue(ML_INPUT);
  const guildId = interaction.guildId ?? ctx.config.GUILD_ID;
  const hits = await ctx.messageLog.search({ guildId, query: q, limit: 10 });
  if (hits.length === 0) {
    await interaction.reply({ content: "ヒットなし。", ephemeral: true });
    return true;
  }
  const lines = hits.map((h) => `- \`${h.id}\` <#${h.channelId}> <@${h.authorId}>: ${h.snippet.slice(0, 80)}`);
  await interaction.reply({ content: lines.join("\n").slice(0, 1900), ephemeral: true });
  return true;
}

export async function handleAdminHubButton(
  interaction: import("discord.js").ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId !== "panels:b:rec") return false;
  const member = interaction.member && "roles" in interaction.member ? interaction.member : null;
  if (!isAdmin(member as never, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return true;
  }
  if (!interaction.guildId) return true;
  await interaction.deferReply({ ephemeral: true });
  await reconcilePanelsForGuild(ctx, interaction.guildId);
  await interaction.editReply({ content: "パネルを再同期しました。" });
  return true;
}

/** OWNER: AI履歴全削除（管理メニュー拡張用・将来ボタンから） */
export async function purgeAiHistory(ctx: BotContext, guildId: string, userId: string): Promise<number> {
  if (!isOwner(userId, ctx.config)) return 0;
  const r = await ctx.db.deleteFrom("ai_history").where("guild_id", "=", guildId).executeTakeFirst();
  return Number(r.numDeletedRows ?? 0);
}
