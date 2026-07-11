import type { PacchiRepositoryLike } from "./pacchi.repository.js";
import { buildPacchiReply, pick } from "./pacchi.reply.js";
import { isSafePacchiReply } from "./pacchi.safety.js";

const slotTemplates = [
  "{PROPER_NOUN}、たぶんすごいやつ",
  "{NOUN}、ぼくの辞書に入れた",
  "{NOUN}は、えっと…だいじ？",
  "{ADJECTIVE}のやつ、ちょっとこわい",
  "{VERB}の、むずかしいかも",
  "{RELATED_WORD}、それっぽい",
] as const;

const lastRepliesByGuild = new Map<string, string>();

async function pickLexicon(repo: PacchiRepositoryLike, guildId: string, pos: string): Promise<string | null> {
  let rows = await repo.topLexiconByPos(guildId, pos, 20);
  if (pos === "名詞") {
    rows = rows.filter((row) => row.is_proper_noun !== 1);
  }
  if (pos === "固有名詞") {
    rows = rows.filter((row) => row.is_proper_noun === 1);
  }
  if (rows.length === 0) return null;
  const weighted = rows.flatMap((row) => Array.from({ length: Math.min(row.count, 5) }, () => row.base));
  return weighted[Math.floor(Math.random() * weighted.length)] ?? rows[0]!.base;
}

async function fillSlots(repo: PacchiRepositoryLike, guildId: string, template: string, topic: string | null): Promise<string | null> {
  const replacements: Record<string, string | null> = {
    NOUN: await pickLexicon(repo, guildId, "名詞"),
    PROPER_NOUN: await pickLexicon(repo, guildId, "固有名詞"),
    VERB: await pickLexicon(repo, guildId, "動詞"),
    ADJECTIVE: await pickLexicon(repo, guildId, "形容詞"),
    ADVERB: await pickLexicon(repo, guildId, "副詞"),
    TOPIC: topic,
    RELATED_WORD: topic ? (await repo.relatedWords(guildId, topic, 10))[0] ?? null : null,
  };
  let out = template;
  for (const [slot, value] of Object.entries(replacements)) {
    if (!out.includes(`{${slot}}`)) continue;
    if (!value) return null;
    out = out.replaceAll(`{${slot}}`, value);
  }
  return toPacchiTone(out);
}

function toPacchiTone(content: string): string {
  let text = content.replace(/です。?$/u, "").replace(/ます。?$/u, "").replace(/と思います/u, "かも");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 45) text = text.slice(0, 42) + "…";
  if (Math.random() < 0.15 && !/(たぶん|かも|えっと)/.test(text)) {
    text = `${text}、たぶん`;
  }
  return text;
}

function chooseMixedLayer(): "fixed" | "slot" | "pattern" {
  const roll = Math.random() * 100;
  if (roll < 60) return "fixed";
  if (roll < 90) return "slot";
  return "pattern";
}

function fallbackReply(fixed: () => string, previous: string | undefined): string {
  for (let i = 0; i < 5; i++) {
    const candidate = fixed();
    if (candidate !== previous && isSafePacchiReply(candidate)) {
      return candidate;
    }
  }
  return previous === "えっと" ? "たぶん" : "えっと";
}

export function buildPacchiGeneratedReply(
  repo: PacchiRepositoryLike,
  guildId: string,
  mode: "template" | "slot-template" | "learned-pattern" | "mixed",
  preferWord = false,
): Promise<string> {
  return buildPacchiGeneratedReplyAsync(repo, guildId, mode, preferWord);
}

async function buildPacchiGeneratedReplyAsync(
  repo: PacchiRepositoryLike,
  guildId: string,
  mode: "template" | "slot-template" | "learned-pattern" | "mixed",
  preferWord = false,
): Promise<string> {
  const topic = await repo.pickWord(guildId);
  const fixed = () => buildPacchiReply(topic, preferWord);
  const slot = async () => (await fillSlots(repo, guildId, pick(slotTemplates), topic)) ?? fixed();
  const pattern = async () => {
    const row = await repo.randomSentencePattern(guildId);
    if (!row) return fixed();
    return (await fillSlots(repo, guildId, row.surface_pattern, topic)) ?? fixed();
  };

  let reply: string;
  if (mode === "slot-template") reply = await slot();
  else if (mode === "learned-pattern") reply = await pattern();
  else if (mode === "mixed") {
    const layer = chooseMixedLayer();
    reply = layer === "slot" ? await slot() : layer === "pattern" ? await pattern() : fixed();
  } else {
    reply = fixed();
  }

  const previous = lastRepliesByGuild.get(guildId);
  if (!isSafePacchiReply(reply) || previous === reply) {
    reply = fallbackReply(fixed, previous);
  }
  lastRepliesByGuild.set(guildId, reply);
  return reply;
}
