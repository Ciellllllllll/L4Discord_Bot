export type FetchWithLimitsOptions = {
  timeoutMs: number;
  maxResponseBytes: number;
  outerSignal?: AbortSignal;
};

export async function readResponseArrayBufferWithLimit(res: Response, maxResponseBytes: number): Promise<ArrayBuffer> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxResponseBytes) {
      throw new Error(`HTTP response too large (${buf.byteLength} > ${maxResponseBytes})`);
    }
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        throw new Error(`HTTP response too large (${total} > ${maxResponseBytes})`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export async function fetchWithLimits(
  url: string,
  init: RequestInit,
  options: FetchWithLimitsOptions,
): Promise<Response> {
  const { timeoutMs, maxResponseBytes, outerSignal } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal;
  const { signal: _ignored, ...rest } = init;
  const res = await fetch(url, { ...rest, signal });
  const buf = await readResponseArrayBufferWithLimit(res, maxResponseBytes);
  return new Response(buf, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
