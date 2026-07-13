// vc_time.db 形式の2ファイルを統合する（置換ではなく INSERT マージ）。
// 重複キー: (guild_id, user_id, started_at) — ベース側の行を優先。
//
// 既定: Downloads の vc_time_new.db をベースに vc_time_old.db を取り込み、
// vc_time_merged.db に出力。
//
// 使い方:
// npx tsx src/scripts/mergeVcTimeDbs.ts
// npx tsx src/scripts/mergeVcTimeDbs.ts --base pathA --donor pathB --out pathC

import Database from "better-sqlite3";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function sqlStringLiteral(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

function main(): void {
  const argv = process.argv.slice(2);
  let basePath = resolve("C:/Users/cielg/Downloads/vc_time_new.db");
  let donorPath = resolve("C:/Users/cielg/Downloads/vc_time_old.db");
  let outPath = resolve("C:/Users/cielg/Downloads/vc_time_merged.db");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) {
      basePath = resolve(argv[++i]);
    } else if (argv[i] === "--donor" && argv[i + 1]) {
      donorPath = resolve(argv[++i]);
    } else if (argv[i] === "--out" && argv[i + 1]) {
      outPath = resolve(argv[++i]);
    }
  }

  if (!existsSync(basePath)) throw new Error(`ベース DB が見つかりません: ${basePath}`);
  if (!existsSync(donorPath)) throw new Error(`ドナー DB が見つかりません: ${donorPath}`);

  copyFileSync(basePath, outPath);
  const db = new Database(outPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const donorSqlPath = donorPath.replace(/\\/g, "/");
  const beforeMain = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };

  try {
    db.exec(`ATTACH DATABASE ${sqlStringLiteral(donorSqlPath)} AS donor`);
    const donorCount = db.prepare("SELECT COUNT(*) AS n FROM donor.sessions").get() as { n: number };

    const insert = db.prepare(`
      INSERT INTO main.sessions (guild_id, user_id, channel_id, started_at, ended_at, duration_sec)
      SELECT d.guild_id, d.user_id, d.channel_id, d.started_at, d.ended_at, d.duration_sec
      FROM donor.sessions d
      WHERE NOT EXISTS (
        SELECT 1 FROM main.sessions m
        WHERE m.guild_id = d.guild_id
          AND m.user_id = d.user_id
          AND m.started_at = d.started_at
      )
    `);
    const info = insert.run();
    const afterMain = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };

    console.log(JSON.stringify({ basePath, donorPath, outPath, beforeMain: beforeMain.n, donorRows: donorCount.n, insertedFromDonor: info.changes, afterMerge: afterMain.n }, null, 2));
    db.exec("DETACH DATABASE donor");
  } finally {
    db.close();
  }
}

main();
