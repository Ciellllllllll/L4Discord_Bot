import type { SenryuCandidate } from "./senryu.types.js";

export type SenryuContextExcerptOptions = {
  radiusBefore?: number;
  radiusAfter?: number;
  maxTotal?: number;
};

// AI レビュー用に、検出候補付近だけを抜粋する（全文先頭バイアスを避ける）

function indexOfCandidateInNormalized(normalized: string, candidate: SenryuCandidate): number {
  const compact = `${candidate.kamigo}${candidate.nakashichi}${candidate.shimogo}`;
  const formattedNoSpace = candidate.formatted.replace(/\s+/g, "");
  const needles = [formattedNoSpace, compact, candidate.formatted, candidate.kamigo];
  for (const n of needles) {
    if (!n) continue;
    const i = normalized.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

export function buildSenryuReviewContextExcerpt(
  normalized: string,
  candidate: SenryuCandidate,
  opts?: SenryuContextExcerptOptions,
): string {
  const radiusBefore = opts?.radiusBefore ?? 100;
  const radiusAfter = opts?.radiusAfter ?? 100;
  const maxTotal = opts?.maxTotal ?? 400;

  const compact = `${candidate.kamigo}${candidate.nakashichi}${candidate.shimogo}`;
  let idx = indexOfCandidateInNormalized(normalized, candidate);
  if (idx < 0) {
    idx = 0;
  }

  const spanLen = Math.max(compact.length, candidate.kamigo.length);
  const start = Math.max(0, idx - radiusBefore);
  const end = Math.min(normalized.length, idx + spanLen + radiusAfter);
  let excerpt = normalized.slice(start, end);
  if (start > 0) excerpt = `…${excerpt}`;
  if (end < normalized.length) excerpt = `${excerpt}…`;

  if (excerpt.length > maxTotal) {
    excerpt = normalized.slice(0, Math.min(maxTotal, normalized.length));
    if (normalized.length > maxTotal) excerpt = `${excerpt}…`;
  }
  return excerpt;
}
