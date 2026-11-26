import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";
import { TOGGLE_PREFIX } from "./reactionRoleConstants.js";

// リアクションロールの権限・付与可否の検証。

const DANGEROUS_REACTION_ROLE_PERMISSION_ENTRIES = [
  ["Administrator", PermissionFlagsBits.Administrator],
  ["ManageGuild", PermissionFlagsBits.ManageGuild],
  ["ManageRoles", PermissionFlagsBits.ManageRoles],
  ["ManageChannels", PermissionFlagsBits.ManageChannels],
  ["ManageWebhooks", PermissionFlagsBits.ManageWebhooks],
  ["BanMembers", PermissionFlagsBits.BanMembers],
  ["KickMembers", PermissionFlagsBits.KickMembers],
  ["ModerateMembers", PermissionFlagsBits.ModerateMembers],
  ["MentionEveryone", PermissionFlagsBits.MentionEveryone],
  ["ManageMessages", PermissionFlagsBits.ManageMessages],
  ["ManageNicknames", PermissionFlagsBits.ManageNicknames],
  ["ManageGuildExpressions", PermissionFlagsBits.ManageGuildExpressions],
  ["ManageEvents", PermissionFlagsBits.ManageEvents],
  ["ManageThreads", PermissionFlagsBits.ManageThreads],
  ["ViewAuditLog", PermissionFlagsBits.ViewAuditLog],
] as const;

export function getDangerousReactionRolePermissionNames(role: Pick<Role, "permissions">): string[] {
  return DANGEROUS_REACTION_ROLE_PERMISSION_ENTRIES
    .filter(([, perm]) => role.permissions.has(perm, false))
    .map(([name]) => name);
}

export function hasDangerousReactionRolePermission(role: Pick<Role, "permissions">): boolean {
  return getDangerousReactionRolePermissionNames(role).length > 0;
}

export async function findDangerousRolesNotice(guild: Guild, roleIds: string[]): Promise<string | null> {
  const dangerousLabels: string[] = [];
  const seen = new Set<string>();
  for (const roleId of roleIds) {
    if (seen.has(roleId)) continue;
    seen.add(roleId);
    const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
    if (!role) continue;
    const perms = getDangerousReactionRolePermissionNames(role);
    if (perms.length > 0) {
      dangerousLabels.push(`${role.name} (${role.id}: ${perms.join(", ")})`);
    }
  }
  if (!dangerousLabels.length) return null;
  return `\n⚠️ 付与できないロール: ${dangerousLabels.join(" / ")}`;
}

export function parseToggleCustomId(customId: string): { entryId: string; roleId: string } | null {
  if (!customId.startsWith(TOGGLE_PREFIX)) return null;
  const rest = customId.slice(TOGGLE_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0 || lastColon >= rest.length - 1) return null;
  const entryId = rest.slice(0, lastColon).trim();
  const roleId = rest.slice(lastColon + 1).trim();
  if (!entryId || !/^\d+$/.test(roleId)) return null;
  return { entryId, roleId };
}

export async function validateAssignableReactionRoles(
  guild: Guild,
  actor: GuildMember,
  roleIds: string[],
): Promise<string | null> {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "Bot にロール管理権限がありません。";
  }
  const isOwner = guild.ownerId === actor.id;
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      return `指定されたロールが見つかりません: ${roleId}`;
    }
    if (role.id === guild.id || role.managed) {
      return `このロールはリアクションロールに設定できません: ${role.name}`;
    }
    if (hasDangerousReactionRolePermission(role)) {
      return `危険な権限を持つロールはリアクションロールに設定できません: ${role.name}`;
    }
    if (!isOwner && role.position >= actor.roles.highest.position) {
      return `自身の最上位ロール以上のロールは設定できません: ${role.name}`;
    }
    if (role.position >= me.roles.highest.position) {
      return `Bot の最上位ロール以上のロールは設定できません: ${role.name}`;
    }
  }
  return null;
}

export function canManageRoles(
  interaction: { memberPermissions?: { has(permission: bigint): boolean } | null },
): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false;
}
