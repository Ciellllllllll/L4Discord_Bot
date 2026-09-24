import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxVideoWithFfmpeg } from "./ffmpegMux.js";

async function muxTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("l4-preview-mux-"));
}

// ffmpeg が無ければ理由を返し、一時ファイルを残さない
{
  const before = await muxTempDirs();
  const result = await muxVideoWithFfmpeg(Buffer.from([1]), Buffer.from([2]), {
    maxOutputBytes: 1024,
    ffmpegPath: "l4-ffmpeg-does-not-exist",
  });
  assert.deepEqual(result, { ok: false, reason: "ffmpeg_unavailable" });
  assert.deepEqual(await muxTempDirs(), before);
}

// 中断済みなら ffmpeg を起動しない
assert.deepEqual(
  await muxVideoWithFfmpeg(Buffer.from([1]), undefined, { maxOutputBytes: 1024, signal: AbortSignal.abort() }),
  { ok: false, reason: "aborted" },
);

// ffmpeg がある環境では、映像だけ・音声だけのファイルを再エンコードせずに1本にまとめる
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0) {
  const dir = await mkdtemp(join(tmpdir(), "l4-mux-spec-"));
  try {
    const videoPath = join(dir, "video.mp4");
    const audioPath = join(dir, "audio.mp4");
    const make = (args: string[]) => {
      const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "ignore" });
      assert.equal(made.status, 0);
    };
    make(["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10", "-c:v", "mpeg4", "-an", videoPath]);
    make(["-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", "-vn", audioPath]);
    const video = await readFile(videoPath);
    const audio = await readFile(audioPath);

    const result = await muxVideoWithFfmpeg(video, audio, { maxOutputBytes: 10 * 1024 * 1024 });
    assert.equal(result.ok, true);
    if (result.ok) {
      const outputPath = join(dir, "muxed.mp4");
      await writeFile(outputPath, result.buffer);
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", outputPath], { encoding: "utf8" });
      if (probe.status === 0) assert.deepEqual(probe.stdout.trim().split(/\r?\n/).sort(), ["audio", "video"]);
    }

    // 音声が無い投稿は映像だけをまとめ直す
    assert.equal((await muxVideoWithFfmpeg(video, undefined, { maxOutputBytes: 10 * 1024 * 1024 })).ok, true);
    // 出力が上限を超えたら添付できないので理由を返す
    assert.deepEqual(await muxVideoWithFfmpeg(video, audio, { maxOutputBytes: 1 }), { ok: false, reason: "too_large" });
    // 壊れた入力は失敗として返す
    assert.deepEqual(
      await muxVideoWithFfmpeg(Buffer.from("not a video"), undefined, { maxOutputBytes: 1024 }),
      { ok: false, reason: "ffmpeg_failed" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
