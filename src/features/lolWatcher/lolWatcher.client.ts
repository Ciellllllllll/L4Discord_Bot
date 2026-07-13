import type { AppConfig } from "../../core/config.js";
import type {
  LolWatcherCompletedGame,
  LolWatcherApiAccount,
  LolWatcherFetchResult,
  LolWatcherLiveGame,
} from "./lolWatcher.types.js";
import { parseRiotId as parseAccountKey } from "./lolWatcher.types.js";

type RiotAccountDto = {
  puuid?: unknown;
  gameName?: unknown;
  tagLine?: unknown;
};

type RiotCurrentGameDto = {
  gameId?: unknown;
  gameQueueConfigId?: unknown;
  gameStartTime?: unknown;
  participants?: Array<{
    puuid?: unknown;
    championId?: unknown;
  }>;
};

type RiotMatchDto = {
  metadata?: {
    matchId?: unknown;
    participants?: unknown;
  };
  info?: {
    queueId?: unknown;
    gameDuration?: unknown;
    gameEndTimestamp?: unknown;
    participants?: Array<{
      puuid?: unknown;
      championName?: unknown;
      championId?: unknown;
      kills?: unknown;
      deaths?: unknown;
      assists?: unknown;
      win?: unknown;
      teamId?: unknown;
      challenges?: {
        killParticipation?: unknown;
      };
    }>;
  };
};

type RiotMatchIds = string[];

const DEFAULT_DEEPLOL_MATCH_URL_TEMPLATE = "https://www.deeplol.gg/summoner/jp/{accountKey}";

const CHAMPION_NAMES: Record<number, string> = {
  1: "Annie",
  2: "Olaf",
  3: "Galio",
  4: "Twisted Fate",
  5: "Xin Zhao",
  6: "Urgot",
  7: "LeBlanc",
  8: "Vladimir",
  9: "Fiddlesticks",
  10: "Kayle",
  11: "Master Yi",
  12: "Alistar",
  13: "Ryze",
  14: "Sion",
  15: "Sivir",
  16: "Soraka",
  17: "Teemo",
  18: "Tristana",
  19: "Warwick",
  20: "Nunu & Willump",
  21: "Miss Fortune",
  22: "Ashe",
  23: "Tryndamere",
  24: "Jax",
  25: "Morgana",
  26: "Zilean",
  27: "Singed",
  28: "Evelynn",
  29: "Twitch",
  30: "Karthus",
  31: "Cho'Gath",
  32: "Amumu",
  33: "Rammus",
  34: "Anivia",
  35: "Shaco",
  36: "Dr. Mundo",
  37: "Sona",
  38: "Kassadin",
  39: "Irelia",
  40: "Janna",
  41: "Gangplank",
  42: "Corki",
  43: "Karma",
  44: "Taric",
  45: "Veigar",
  48: "Trundle",
  50: "Swain",
  51: "Caitlyn",
  53: "Blitzcrank",
  54: "Malphite",
  55: "Katarina",
  56: "Nocturne",
  57: "Maokai",
  58: "Renekton",
  59: "Jarvan IV",
  60: "Elise",
  61: "Orianna",
  62: "Wukong",
  63: "Brand",
  64: "Lee Sin",
  67: "Vayne",
  68: "Rumble",
  69: "Cassiopeia",
  72: "Skarner",
  74: "Heimerdinger",
  75: "Nasus",
  76: "Nidalee",
  77: "Udyr",
  78: "Poppy",
  79: "Gragas",
  80: "Pantheon",
  81: "Ezreal",
  82: "Mordekaiser",
  83: "Yorick",
  84: "Akali",
  85: "Kennen",
  86: "Garen",
  89: "Leona",
  90: "Malzahar",
  91: "Talon",
  92: "Riven",
  96: "Kog'Maw",
  98: "Shen",
  99: "Lux",
  101: "Xerath",
  102: "Shyvana",
  103: "Ahri",
  104: "Graves",
  105: "Fizz",
  106: "Volibear",
  107: "Rengar",
  110: "Varus",
  111: "Nautilus",
  112: "Viktor",
  113: "Sejuani",
  114: "Fiora",
  115: "Ziggs",
  117: "Lulu",
  119: "Draven",
  120: "Hecarim",
  121: "Kha'Zix",
  122: "Darius",
  126: "Jayce",
  127: "Lissandra",
  131: "Diana",
  133: "Quinn",
  134: "Syndra",
  136: "Aurelion Sol",
  141: "Kayn",
  142: "Zoe",
  143: "Zyra",
  145: "Kai'Sa",
  147: "Seraphine",
  150: "Gnar",
  154: "Zac",
  157: "Yasuo",
  161: "Vel'Koz",
  163: "Taliyah",
  164: "Camille",
  166: "Akshan",
  200: "Bel'Veth",
  201: "Braum",
  202: "Jhin",
  203: "Kindred",
  221: "Zeri",
  222: "Jinx",
  223: "Tahm Kench",
  233: "Briar",
  234: "Viego",
  235: "Senna",
  236: "Lucian",
  238: "Zed",
  240: "Kled",
  245: "Ekko",
  246: "Qiyana",
  254: "Vi",
  266: "Aatrox",
  267: "Nami",
  268: "Azir",
  350: "Yuumi",
  360: "Samira",
  412: "Thresh",
  420: "Illaoi",
  421: "Rek'Sai",
  427: "Ivern",
  429: "Kalista",
  432: "Bard",
  497: "Rakan",
  498: "Xayah",
  516: "Ornn",
  517: "Sylas",
  518: "Neeko",
  523: "Aphelios",
  526: "Rell",
  555: "Pyke",
  711: "Vex",
  777: "Yone",
  875: "Sett",
  876: "Lillia",
  887: "Gwen",
  888: "Renata Glasc",
  895: "Nilah",
  897: "K'Sante",
  901: "Smolder",
  902: "Milio",
  910: "Hwei",
  950: "Naafiri",
};

const QUEUE_NAMES: Record<number, string> = {
  0: "カスタム",
  400: "ノーマル",
  420: "ランクソロ/デュオ",
  430: "ノーマル",
  440: "ランクフレックス",
  450: "ARAM",
  700: "Clash",
  900: "ARURF",
  1700: "アリーナ",
  1900: "URF",
};

function platformHost(config: AppConfig): string {
  return `${config.RIOT_PLATFORM_ID.toLowerCase()}.api.riotgames.com`;
}

function regionalHost(config: AppConfig): string {
  return `${config.RIOT_REGIONAL_ROUTING.toLowerCase()}.api.riotgames.com`;
}

function queueName(queueId: number): string {
  return QUEUE_NAMES[queueId] ?? `Queue ${queueId}`;
}

function championName(championId: number | null | undefined): string {
  if (!championId) return "不明";
  return CHAMPION_NAMES[championId] ?? `Champion ${championId}`;
}

function championImageUrl(champion: string): string | null {
  if (!champion || champion.startsWith("Champion ")) return null;
  const normalized = champion
    .replace(/['.]/g, "")
    .replace(/&/g, "")
    .replace(/\s+/g, "")
    .replace("NunuWillump", "Nunu")
    .replace("Wukong", "MonkeyKing")
    .replace("RenataGlasc", "Renata");
  return `https://ddragon.leagueoflegends.com/cdn/14.24.1/img/champion/${encodeURIComponent(normalized)}.png`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function riotHeaders(config: AppConfig): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Riot-Token": config.RIOT_API_KEY.trim(),
    "User-Agent": "L4_DiscordBot/1.0 LolWatcher",
  };
}

async function fetchJson<T>(url: string, config: AppConfig): Promise<
  | { ok: true; json: T }
  | { ok: false; error: string; httpStatus?: number; text?: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.RIOT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: riotHeaders(config),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, httpStatus: response.status, text };
    try {
      return { ok: true, json: JSON.parse(text) as T };
    } catch {
      return { ok: false, error: "JSON parse failed" };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.name === "AbortError" ? "request timeout" : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function completedFromMatch(account: LolWatcherApiAccount, match: RiotMatchDto): LolWatcherCompletedGame | null {
  const matchId = stringOrNull(match.metadata?.matchId);
  const info = match.info;
  if (!matchId || !info || !Array.isArray(info.participants)) return null;
  const participant = info.participants.find((value) => value.puuid === account.puuid);
  if (!participant) return null;
  const queueId = numberOrNull(info.queueId) ?? 0;
  const durationSeconds = numberOrNull(info.gameDuration) ?? 0;
  const endedAtMs = numberOrNull(info.gameEndTimestamp) ?? Date.now();
  const champion = stringOrNull(participant.championName) ?? championName(numberOrNull(participant.championId));
  const kpRaw = numberOrNull(participant.challenges?.killParticipation);
  return {
    gameId: matchId,
    detailUrl: null,
    queueName: queueName(queueId),
    championName: champion,
    championImageUrl: championImageUrl(champion),
    result: participant.win === true ? "win" : "lose",
    aiScore: null,
    kills: numberOrNull(participant.kills) ?? 0,
    deaths: numberOrNull(participant.deaths) ?? 0,
    assists: numberOrNull(participant.assists) ?? 0,
    durationSeconds,
    killParticipationPercent: kpRaw === null ? 0 : Math.round(kpRaw * 100),
    endedAt: new Date(endedAtMs).toISOString(),
  };
}

function liveFromSpectator(config: AppConfig, account: LolWatcherApiAccount, current: RiotCurrentGameDto): LolWatcherLiveGame | null {
  const gameId = numberOrNull(current.gameId);
  const queueId = numberOrNull(current.gameQueueConfigId) ?? 0;
  const startedAtMs = numberOrNull(current.gameStartTime) ?? Date.now();
  const participant = current.participants?.find((value) => value.puuid === account.puuid);
  const champion = championName(numberOrNull(participant?.championId));
  if (gameId === null) return null;
  return {
    gameId: `${config.RIOT_PLATFORM_ID.toUpperCase()}_${gameId}`,
    queueName: queueName(queueId),
    championName: champion,
    championImageUrl: championImageUrl(champion),
    startedAt: new Date(startedAtMs).toISOString(),
  };
}

function stripEnvAssignmentPrefix(value: string, key: string): string {
  const trimmed = value.trim();
  const prefix = `${key}=`;
  if (!trimmed.toUpperCase().startsWith(prefix)) return trimmed;
  return trimmed.slice(prefix.length).trim();
}

function normalizeTemplateValue(value: string | undefined): string {
  if (!value?.trim()) return DEFAULT_DEEPLOL_MATCH_URL_TEMPLATE;
  const withoutKey = stripEnvAssignmentPrefix(value, "DEEPLOL_MATCH_URL_TEMPLATE");
  if (!withoutKey) return DEFAULT_DEEPLOL_MATCH_URL_TEMPLATE;
  if (
    (withoutKey.startsWith("\"") && withoutKey.endsWith("\""))
    || (withoutKey.startsWith("'") && withoutKey.endsWith("'"))
  ) {
    return withoutKey.slice(1, -1).trim() || DEFAULT_DEEPLOL_MATCH_URL_TEMPLATE;
  }
  return withoutKey;
}

function encodeDeepLolAccountKey(input: { accountKey: string; account: LolWatcherApiAccount }): string {
  const parsed = parseAccountKey(input.accountKey);
  const gameName = parsed?.gameName ?? input.account.gameName;
  const tagLine = parsed?.tagLine ?? input.account.tagLine;
  return `${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`;
}

export function buildDeepLolDetailUrl(config: AppConfig, input: {
  accountKey: string;
  account: LolWatcherApiAccount;
  game: LolWatcherCompletedGame;
}): { ok: true; url: string; templateName: string } | { ok: false; url: string; templateName: string; error: string } {
  const templateName = "DEEPLOL_MATCH_URL_TEMPLATE";
  const template = normalizeTemplateValue(config.DEEPLOL_MATCH_URL_TEMPLATE);
  const generated = template
    .replaceAll("{gameId}", encodeURIComponent(input.game.gameId))
    .replaceAll("{accountKey}", encodeDeepLolAccountKey(input))
    .replaceAll("{gameName}", encodeURIComponent(input.account.gameName))
    .replaceAll("{tagLine}", encodeURIComponent(input.account.tagLine))
    .replaceAll("{puuid}", encodeURIComponent(input.account.puuid));
  try {
    return { ok: true, url: new URL(generated).toString(), templateName };
  } catch (err) {
    return {
      ok: false,
      url: generated,
      templateName,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export class LolWatcherRiotClient {
  constructor(private readonly config: AppConfig) {}

  async fetchState(accountKey: string): Promise<LolWatcherFetchResult> {
    const riotId = parseAccountKey(accountKey);
    if (!riotId) return { ok: false, error: "accountKey must be Riot ID format: gameName#tagLine" };
    const accountUrl = `https://${regionalHost(this.config)}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotId.gameName)}/${encodeURIComponent(riotId.tagLine)}`;
    const accountResult = await fetchJson<RiotAccountDto>(accountUrl, this.config);
    if (!accountResult.ok) return accountResult;
    const puuid = stringOrNull(accountResult.json.puuid);
    const gameName = stringOrNull(accountResult.json.gameName) ?? riotId.gameName;
    const tagLine = stringOrNull(accountResult.json.tagLine) ?? riotId.tagLine;
    if (!puuid) return { ok: false, error: "Riot account response missing puuid" };
    const account = {
      puuid,
      gameName,
      tagLine,
      displayName: `${gameName}#${tagLine}`,
    };

    const liveResult = await fetchJson<RiotCurrentGameDto>(
      `https://${platformHost(this.config)}/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`,
      this.config,
    );
    const liveGame = liveResult.ok ? liveFromSpectator(this.config, account, liveResult.json) : null;

    const idsResult = await fetchJson<RiotMatchIds>(
      `https://${regionalHost(this.config)}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?start=0&count=5`,
      this.config,
    );
    if (!idsResult.ok) {
      return {
        ok: true,
        state: { account, liveGame, completedGames: [] },
      };
    }
    const completedGames: LolWatcherCompletedGame[] = [];
    for (const matchId of idsResult.json.slice(0, 5)) {
      const matchResult = await fetchJson<RiotMatchDto>(
        `https://${regionalHost(this.config)}/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
        this.config,
      );
      if (!matchResult.ok) continue;
      const completed = completedFromMatch(account, matchResult.json);
      if (completed) completedGames.push(completed);
    }
    return { ok: true, state: { account, liveGame, completedGames } };
  }
}
