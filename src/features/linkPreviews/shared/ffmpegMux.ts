import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 再エンコードせずにコンテナを組み直すだけなので、通常は数秒で終わる */
const MUX_TIMEOUT_MS = 20_000;

export type MuxVideoOptions = {
  /** 出力の上限。超えたら undefined（添付できないため） */
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** テスト用。既定は PATH 上の ffmpeg */
  ffmpegPath?: string;
};

export type MuxVideoFailureReason = "ffmpeg_unavailable" | "ffmpeg_failed" | "too_large" | "aborted";

export type MuxVideoResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: MuxVideoFailureReason };

export type MuxVideo = (video: Buffer, audio: Buffer | undefined, options: MuxVideoOptions) => Promise<MuxVideoResult>;

function runFfmpeg(ffmpegPath: string, args: string[], signal: AbortSignal): Promise<"ok" | "unavailable" | "failed"> {
  return new Promise((resolve) => {
    // 出力は読まない（パイプに溜めない）。中断時は signal で子プロセスを止める
    const child = spawn(ffmpegPath, args, { stdio: "ignore", signal, windowsHide: true });
    child.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "ENOENT" ? "unavailable" : "failed"));
    child.once("close", (code) => resolve(code === 0 ? "ok" : "failed"));
  });
}

/**
 * 映像だけのファイルと音声だけのファイル（DASH の各トラック）を、再エンコードせずに1本の mp4 にまとめる。
 * ffmpeg が無い・失敗した・上限を超えた場合は理由を返す（呼び出し側はサムネイル表示にフォールバックする）。
 */
export const muxVideoWithFfmpeg: MuxVideo = async (video, audio, options) => {
  const signal = AbortSignal.any([AbortSignal.timeout(MUX_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  if (signal.aborted) return { ok: false, reason: "aborted" };
  const dir = await mkdtemp(join(tmpdir(), "l4-preview-mux-"));
  try {
    const videoPath = join(dir, "video.mp4");
    const audioPath = join(dir, "audio.mp4");
    const outputPath = join(dir, "output.mp4");
    await writeFile(videoPath, video);
    if (audio) await writeFile(audioPath, audio);
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", videoPath,
      ...(audio ? ["-i", audioPath, "-map", "0:v:0", "-map", "1:a:0"] : ["-map", "0:v:0"]),
      "-c", "copy",
      // Discord で読み込み途中から再生できるよう、先頭にインデックスを置く
      "-movflags", "+faststart",
      "-f", "mp4",
      outputPath,
    ];
    const result = await runFfmpeg(options.ffmpegPath ?? "ffmpeg", args, signal);
    if (result === "unavailable") return { ok: false, reason: "ffmpeg_unavailable" };
    if (signal.aborted) return { ok: false, reason: "aborted" };
    if (result !== "ok") return { ok: false, reason: "ffmpeg_failed" };
    const { size } = await stat(outputPath);
    if (size <= 0) return { ok: false, reason: "ffmpeg_failed" };
    if (size > options.maxOutputBytes) return { ok: false, reason: "too_large" };
    return { ok: true, buffer: await readFile(outputPath) };
  } catch {
    return { ok: false, reason: signal.aborted ? "aborted" : "ffmpeg_failed" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};
