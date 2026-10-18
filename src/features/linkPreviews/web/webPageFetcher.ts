import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { pipeline, type Readable } from "node:stream";

const REQUEST_TIMEOUT_MS = 10_000;
/** OGP は head にあり本文も冒頭で足りるので、上限を超えた分は読まずに打ち切る */
const MAX_BODY_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;
export function isHtmlContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "" || type === "text/html" || type === "application/xhtml+xml";
}

const USER_AGENT = "Mozilla/5.0 (compatible; L4DiscordBot/0.1; +https://discord.com) LinkPreview";

export type WebFetchErrorReason =
  | "blocked_address"
  | "unsupported_url"
  | "too_many_redirects"
  | "timeout"
  | "request_failed"
  | "http_error";

export type WebPageResponse = {
  status: number;
  finalUrl: string;
  contentType: string;
  body: Buffer;
};

export type WebFetchResult =
  | { status: "ok"; response: WebPageResponse }
  | { status: "error"; reason: WebFetchErrorReason; statusCode?: number };

export type WebPageFetcher = (url: string) => Promise<WebFetchResult>;

/** 内部ネットワークや予約済みのアドレス。ユーザーが貼った URL から BOT のサーバー内部へ届かないようにする */
const BLOCKED_ADDRESSES = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [
    ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
    ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ] as const) list.addSubnet(network, prefix, "ipv6");
  // IPv4 射影アドレス（::ffff:127.0.0.1 など）は BlockList が IPv4 の規則で照合する。
  // ::ffff:0:0/96 を IPv6 の規則に入れると、逆にすべての IPv4 アドレスが一致してしまう
  return list;
})();

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCKED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

class BlockedAddressError extends Error {}

/** 名前解決の結果を検査し、検査したアドレスにそのまま接続させる（再解決による DNS rebinding を防ぐ） */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) { callback(error, "", 0); return; }
    if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
      callback(new BlockedAddressError(`Blocked address for ${hostname}`), "", 0);
      return;
    }
    if (options.all) (callback as unknown as (err: null, list: LookupAddress[]) => void)(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/** 取得してよい URL か。HTTPS の既定ポートだけを許可し、IP 直書きは内部アドレスを拒否する */
export function checkFetchableUrl(urlText: string): URL | WebFetchErrorReason {
  let url: URL;
  try { url = new URL(urlText); } catch { return "unsupported_url"; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    return "unsupported_url";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isBlockedAddress(host)) return "blocked_address";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "blocked_address";
  }
  return url;
}

/** 圧縮された応答を展開する。pipeline で繋ぎ、接続の失敗や中断を展開側にも伝える */
function decodedStream(response: IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder = encoding === "gzip" || encoding === "x-gzip"
    ? createGunzip()
    : encoding === "deflate"
      ? createInflate()
      : encoding === "br" ? createBrotliDecompress() : null;
  return decoder ? pipeline(response, decoder, () => undefined) : response;
}

async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(buffer);
    size += buffer.byteLength;
    if (size >= maxBytes) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

type SingleResponse =
  | { kind: "redirect"; location: string }
  | { kind: "page"; response: WebPageResponse };

function requestOnce(url: URL, signal: AbortSignal): Promise<SingleResponse> {
  const options: RequestOptions = {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      "Accept-Language": "ja,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
    },
    lookup: guardedLookup,
    signal,
  };
  return new Promise((resolve, reject) => {
    const req = request(url, options, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.destroy();
        // 不正な Location でもコールバック内で例外を投げない（投げるとプロセスごと落ちる）
        try { resolve({ kind: "redirect", location: new URL(location, url).toString() }); }
        catch (error) { reject(error); }
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "");
      const page = (body: Buffer): SingleResponse => ({
        kind: "page",
        response: { status, finalUrl: url.toString(), contentType, body },
      });
      // エラー応答や HTML 以外（動画・アーカイブなど）は使わないので、本文を読まずに切る
      if (status < 200 || status >= 300 || !isHtmlContentType(contentType)) {
        response.destroy();
        resolve(page(Buffer.alloc(0)));
        return;
      }
      readLimited(decodedStream(response), MAX_BODY_BYTES)
        .finally(() => response.destroy())
        .then((body) => resolve(page(body)), reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function errorReason(error: unknown): WebFetchErrorReason {
  if (error instanceof BlockedAddressError) return "blocked_address";
  const name = (error as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "request_failed";
}

/** HTTPS のページを取得する。リダイレクト先も毎回同じ検査をしてから辿る */
export const fetchWebPage: WebPageFetcher = async (urlText) => {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let current = urlText;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const checked = checkFetchableUrl(current);
      if (typeof checked === "string") return { status: "error", reason: checked };
      const result = await requestOnce(checked, signal);
      if (result.kind === "redirect") { current = result.location; continue; }
      if (result.response.status < 200 || result.response.status >= 300) {
        return { status: "error", reason: "http_error", statusCode: result.response.status };
      }
      return { status: "ok", response: result.response };
    }
    return { status: "error", reason: "too_many_redirects" };
  } catch (error) {
    return { status: "error", reason: errorReason(error) };
  }
};
