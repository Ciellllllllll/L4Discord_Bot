// 外部 HTTP: タイムアウトとレスポンス最大バイト（arrayBuffer 読み込み後検査）
// DiscordBOTv2 の fetchWithLimits と同等。

export type FetchWithLimitsOptions = {
  timeoutMs: number;
  maxResponseBytes: number;
    // 呼び出し側のキャンセル（併用時はいずれかで中断）

  outerSignal?: AbortSignal;
};

export async function fetchWithLimits(
  url: string,
  init: RequestInit,
  options: FetchWithLimitsOptions,
): Promise<Response> {
  const { timeoutMs, maxResponseBytes, outerSignal } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal =
    outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
  try {
    const { signal: _ignored, ...rest } = init;
    const res = await fetch(url, { ...rest, signal });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxResponseBytes) {
      throw new Error(`HTTP response too large (${buf.byteLength} > ${maxResponseBytes})`);
    }
    return new Response(buf, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}
