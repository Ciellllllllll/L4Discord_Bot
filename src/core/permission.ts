import type { GuildMember } from "discord.js";
import { PermissionFlagsBits } from "discord.js";

export type AdminCheckConfig = {
  OWNER_ID: string;
  ADMIN_ROLE_ID: string;
};

export function isOwner(userId: string, cfg: AdminCheckConfig): boolean {
  return userId === cfg.OWNER_ID;
}

export function memberHasAdminRole(member: GuildMember | null, adminRoleId: string): boolean {
  if (!member) return false;
  return member.roles.cache.has(adminRoleId);
}

export function isAdmin(member: GuildMember | null, cfg: AdminCheckConfig): boolean {
  if (!member) return false;
  if (member.id === cfg.OWNER_ID) return true;
  if (member.guild.ownerId === member.id) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return memberHasAdminRole(member, cfg.ADMIN_ROLE_ID);
}
