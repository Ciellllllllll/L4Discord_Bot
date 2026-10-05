import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const BOKERU_ODAI_PATH = resolve(process.cwd(), "Bokete.json");

const odaiSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().trim().min(1).max(64), type: z.literal("text"), text: z.string().trim().min(1).max(1_000) }),
  z.object({ id: z.string().trim().min(1).max(64), type: z.literal("image"), imageUrl: z.string().url().startsWith("https://") }),
]);

export type BokeruOdai = z.infer<typeof odaiSchema>;

export function parseBokeruOdaiList(value: unknown): BokeruOdai[] {
  const list = z.array(odaiSchema).min(1).parse(value);
  const ids = new Set<string>();
  for (const odai of list) {
    if (ids.has(odai.id)) throw new Error(`Bokete.json に重複した id があります: ${odai.id}`);
    ids.add(odai.id);
  }
  return list;
}

export async function loadBokeruOdaiList(path = BOKERU_ODAI_PATH): Promise<BokeruOdai[]> {
  return parseBokeruOdaiList(JSON.parse(await readFile(path, "utf8")));
}

// 出題回数が最も少ないお題からランダムに選ぶ。全題出し終えると自然に次の周回へ移る。
export function pickBokeruOdai(
  list: readonly BokeruOdai[],
  usage: ReadonlyMap<string, number>,
  random: () => number = Math.random,
): BokeruOdai {
  const min = Math.min(...list.map((odai) => usage.get(odai.id) ?? 0));
  const candidates = list.filter((odai) => (usage.get(odai.id) ?? 0) === min);
  return candidates[Math.floor(random() * candidates.length)]!;
}
