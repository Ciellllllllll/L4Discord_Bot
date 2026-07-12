export type WerewolfRole = "werewolf" | "seer" | "knight" | "villager";
export type WerewolfThreadRole = Exclude<WerewolfRole, "villager">;
export type WerewolfPhase = "lobby" | "night" | "day_discussion" | "voting" | "ended";
export type WerewolfWinner = "villagers" | "werewolves";

export type WerewolfPlayer = {
  userId: string;
  role: WerewolfRole;
  alive: boolean;
};

export type WerewolfState = {
  participants: string[];
  players: WerewolfPlayer[];
  phase: WerewolfPhase;
  dayNumber: number;
  werewolfChannelId: string;
  hostId: string;
  rolePrivateThreadIds: Partial<Record<WerewolfThreadRole, string>>;
  roleThreadMembersByRole: Partial<Record<WerewolfThreadRole, string[]>>;
  votes: Record<string, string>;
  nightActions: {
    attack: Record<string, string>;
    inspect: Record<string, string>;
    guard: Record<string, string>;
  };
  deadUserIds: string[];
  deadlineAt: string | null;
  lobbyMessageId?: string;
  winner?: WerewolfWinner;
};

export const THREAD_ROLES: WerewolfThreadRole[] = ["werewolf", "seer", "knight"];

export const ROLE_LABELS: Record<WerewolfRole, string> = {
  werewolf: "人狼",
  seer: "占い師",
  knight: "騎士",
  villager: "村人",
};

export const ROLE_THREAD_LABELS: Record<WerewolfThreadRole, string> = {
  werewolf: "人狼",
  seer: "占い師",
  knight: "騎士",
};

export function createInitialWerewolfState(input: {
  channelId: string;
  hostId: string;
}): WerewolfState {
  return {
    participants: [],
    players: [],
    phase: "lobby",
    dayNumber: 0,
    werewolfChannelId: input.channelId,
    hostId: input.hostId,
    rolePrivateThreadIds: {},
    roleThreadMembersByRole: {},
    votes: {},
    nightActions: { attack: {}, inspect: {}, guard: {} },
    deadUserIds: [],
    deadlineAt: null,
  };
}

export function parseWerewolfState(raw: unknown): WerewolfState | null {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (!Array.isArray(rec.participants)) return null;
  if (!Array.isArray(rec.players)) return null;
  if (typeof rec.phase !== "string") return null;
  if (typeof rec.werewolfChannelId !== "string") return null;
  if (typeof rec.hostId !== "string") return null;
  return {
    participants: rec.participants.filter((v): v is string => typeof v === "string"),
    players: rec.players
      .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
      .map((v) => ({
        userId: String(v.userId ?? ""),
        role: normalizeRole(v.role),
        alive: v.alive !== false,
      }))
      .filter((p) => p.userId),
    phase: normalizePhase(rec.phase),
    dayNumber: Number.isInteger(rec.dayNumber) ? Number(rec.dayNumber) : 0,
    werewolfChannelId: rec.werewolfChannelId,
    hostId: rec.hostId,
    rolePrivateThreadIds: normalizeThreadIds(rec.rolePrivateThreadIds),
    roleThreadMembersByRole: normalizeThreadMembers(rec.roleThreadMembersByRole),
    votes: normalizeStringRecord(rec.votes),
    nightActions: normalizeNightActions(rec.nightActions),
    deadUserIds: Array.isArray(rec.deadUserIds) ? rec.deadUserIds.filter((v): v is string => typeof v === "string") : [],
    deadlineAt: typeof rec.deadlineAt === "string" ? rec.deadlineAt : null,
    lobbyMessageId: typeof rec.lobbyMessageId === "string" ? rec.lobbyMessageId : undefined,
    winner: rec.winner === "villagers" || rec.winner === "werewolves" ? rec.winner : undefined,
  };
}

export function roleCountsForPlayerCount(
  count: number,
  options: { allowSmallGame?: boolean } = {},
): Record<WerewolfRole, number> {
  if (count < 5) {
    if (!options.allowSmallGame) throw new Error("werewolf requires at least 5 players");
    if (count <= 0) return { werewolf: 0, seer: 0, knight: 0, villager: 0 };
    if (count === 1) return { werewolf: 1, seer: 0, knight: 0, villager: 0 };
    if (count === 2) return { werewolf: 1, seer: 1, knight: 0, villager: 0 };
    if (count === 3) return { werewolf: 1, seer: 1, knight: 1, villager: 0 };
    return { werewolf: 1, seer: 1, knight: 1, villager: 1 };
  }
  if (count <= 7) return { werewolf: 1, seer: 1, knight: 1, villager: count - 3 };
  if (count <= 11) return { werewolf: 2, seer: 1, knight: 1, villager: count - 4 };
  if (count <= 15) return { werewolf: 3, seer: 1, knight: 2, villager: count - 6 };
  return { werewolf: 4, seer: 2, knight: 2, villager: count - 8 };
}

export function assignRoles(
  participants: string[],
  random = Math.random,
  options: { allowSmallGame?: boolean } = {},
): WerewolfPlayer[] {
  const counts = roleCountsForPlayerCount(participants.length, options);
  const roles: WerewolfRole[] = [
    ...Array.from({ length: counts.werewolf }, () => "werewolf" as const),
    ...Array.from({ length: counts.seer }, () => "seer" as const),
    ...Array.from({ length: counts.knight }, () => "knight" as const),
    ...Array.from({ length: counts.villager }, () => "villager" as const),
  ];
  const shuffled = [...participants];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.map((userId, i) => ({ userId, role: roles[i] ?? "villager", alive: true }));
}

export function checkWinner(players: WerewolfPlayer[]): WerewolfWinner | null {
  const alive = players.filter((p) => p.alive);
  const werewolves = alive.filter((p) => p.role === "werewolf").length;
  const others = alive.length - werewolves;
  if (werewolves === 0) return "villagers";
  if (werewolves >= others) return "werewolves";
  return null;
}

export function resolveVotes(votes: Record<string, string>, aliveUserIds: string[]): string | null {
  const alive = new Set(aliveUserIds);
  const counts = new Map<string, number>();
  for (const targetId of Object.values(votes)) {
    if (!alive.has(targetId)) continue;
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  let max = 0;
  let top: string[] = [];
  for (const [targetId, count] of counts) {
    if (count > max) {
      max = count;
      top = [targetId];
    } else if (count === max) {
      top.push(targetId);
    }
  }
  return top.length === 1 ? top[0]! : null;
}

export function resolveMajorityRandom(
  selections: Record<string, string>,
  validTargetIds: string[],
  random = Math.random,
): string | null {
  const valid = new Set(validTargetIds);
  const counts = new Map<string, number>();
  for (const targetId of Object.values(selections)) {
    if (!valid.has(targetId)) continue;
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  let max = 0;
  let top: string[] = [];
  for (const [targetId, count] of counts) {
    if (count > max) {
      max = count;
      top = [targetId];
    } else if (count === max) {
      top.push(targetId);
    }
  }
  if (top.length === 0) return null;
  return top[Math.floor(random() * top.length)] ?? null;
}

export function canUseRoleThreadAction(input: {
  state: WerewolfState;
  userId: string;
  role: WerewolfThreadRole;
  channelId: string;
  phase: WerewolfPhase;
  targetUserId: string;
}): boolean {
  if (input.state.phase !== input.phase) return false;
  if (input.state.rolePrivateThreadIds[input.role] !== input.channelId) return false;
  const actor = input.state.players.find((p) => p.userId === input.userId);
  const target = input.state.players.find((p) => p.userId === input.targetUserId);
  if (!actor || !target) return false;
  return actor.alive && target.alive && actor.role === input.role;
}

function normalizeRole(value: unknown): WerewolfRole {
  return value === "werewolf" || value === "seer" || value === "knight" || value === "villager" ? value : "villager";
}

function normalizePhase(value: string): WerewolfPhase {
  return value === "lobby" || value === "night" || value === "day_discussion" || value === "voting" || value === "ended"
    ? value
    : "ended";
}

function normalizeThreadIds(value: unknown): Partial<Record<WerewolfThreadRole, string>> {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const out: Partial<Record<WerewolfThreadRole, string>> = {};
  for (const role of THREAD_ROLES) {
    if (typeof rec[role] === "string") out[role] = rec[role] as string;
  }
  return out;
}

function normalizeThreadMembers(value: unknown): Partial<Record<WerewolfThreadRole, string[]>> {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const out: Partial<Record<WerewolfThreadRole, string[]>> = {};
  for (const role of THREAD_ROLES) {
    const raw = rec[role];
    if (Array.isArray(raw)) out[role] = raw.filter((v): v is string => typeof v === "string");
  }
  return out;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function normalizeNightActions(value: unknown): WerewolfState["nightActions"] {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    attack: normalizeStringRecord(rec.attack),
    inspect: normalizeStringRecord(rec.inspect),
    guard: normalizeStringRecord(rec.guard),
  };
}
