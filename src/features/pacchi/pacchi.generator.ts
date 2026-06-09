import type { PacchiRepository } from "./pacchi.repository.js";
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

function pickLexicon(repo: PacchiRepository, guildId: string, pos: string): string | null {
  let rows = repo.topLexiconByPos(guildId, pos, 20);
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

function fillSlots(repo: PacchiRepository, guildId: string, template: string, topic: string | null): string | null {
  const replacements: Record<string, string | null> = {
    NOUN: pickLexicon(repo, guildId, "名詞"),
    PROPER_NOUN: pickLexicon(repo, guildId, "固有名詞"),
    VERB: pickLexicon(repo, guildId, "動詞"),
    ADJECTIVE: pickLexicon(repo, guildId, "形容詞"),
    ADVERB: pickLexicon(repo, guildId, "副詞"),
    TOPIC: topic,
    RELATED_WORD: topic ? repo.relatedWords(guildId, topic, 10)[0] ?? null : null,
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
  repo: PacchiRepository,
  guildId: string,
  mode: "template" | "slot-template" | "learned-pattern" | "mixed",
  preferWord = false,
): string {
  const topic = repo.pickWord(guildId);
  const fixed = () => buildPacchiReply(topic, preferWord);
  const slot = () => fillSlots(repo, guildId, pick(slotTemplates), topic) ?? fixed();
  const pattern = () => {
    const row = repo.randomSentencePattern(guildId);
    if (!row) return fixed();
    return fillSlots(repo, guildId, row.surface_pattern, topic) ?? fixed();
  };

  let reply: string;
  if (mode === "slot-template") reply = slot();
  else if (mode === "learned-pattern") reply = pattern();
  else if (mode === "mixed") {
    const layer = chooseMixedLayer();
    reply = layer === "slot" ? slot() : layer === "pattern" ? pattern() : fixed();
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
