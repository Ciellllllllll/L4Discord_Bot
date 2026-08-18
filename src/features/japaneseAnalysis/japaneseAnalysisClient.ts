import type {
  AnalyzeMorphResponse,
  AnalyzeSenryuResponse,
  JapaneseAnalysisClientOptions,
  JapaneseMorphToken,
  JapaneseWorkerHealth,
  WorkerResult,
} from "./japaneseAnalysis.types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateSenryuResponse(value: unknown): AnalyzeSenryuResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.matched !== "boolean") return null;
  if (!(typeof value.text === "string" || value.text === null)) return null;
  if (!isStringArray(value.phrases)) return null;
  if (!(typeof value.error === "string" || value.error === null)) return null;
  if (value.matched && value.phrases.length !== 3) return null;
  return {
    matched: value.matched,
    text: value.text,
    phrases: value.phrases,
    error: value.error,
  };
}

function validateMorphToken(value: unknown): JapaneseMorphToken | null {
  if (!isRecord(value)) return null;
  if (typeof value.surface !== "string") return null;
  if (typeof value.base !== "string") return null;
  if (typeof value.reading !== "string") return null;
  if (!isStringArray(value.pos)) return null;
  if (typeof value.isProperNoun !== "boolean") return null;
  if (typeof value.isOov !== "boolean") return null;
  return {
    surface: value.surface,
    base: value.base,
    reading: value.reading,
    pos: value.pos,
    isProperNoun: value.isProperNoun,
    isOov: value.isOov,
  };
}

function validateMorphResponse(value: unknown): AnalyzeMorphResponse | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.tokens)) return null;
  if (!(typeof value.error === "string" || value.error === null)) return null;
  const tokens: JapaneseMorphToken[] = [];
  for (const raw of value.tokens) {
    const token = validateMorphToken(raw);
    if (!token) return null;
    tokens.push(token);
  }
  return { tokens, error: value.error };
}

async function postJson<T>(
  options: JapaneseAnalysisClientOptions,
  path: string,
  body: unknown,
  validate: (value: unknown) => T | null,
): Promise<WorkerResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(new URL(path, options.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, reason: "http_error", error: response.status };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      return { ok: false, reason: "invalid_json", error };
    }
    const data = validate(json);
    if (!data) {
      return { ok: false, reason: "invalid_response", error: json };
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return { ok: false, reason: "timeout", error };
    }
    return { ok: false, reason: "unreachable", error };
  }
}

export function analyzeSenryu(
  content: string,
  options: JapaneseAnalysisClientOptions,
): Promise<WorkerResult<AnalyzeSenryuResponse>> {
  return postJson(options, "/analyze/senryu", { content, rule: [5, 7, 5] }, validateSenryuResponse);
}

export function analyzeMorph(
  content: string,
  options: JapaneseAnalysisClientOptions,
): Promise<WorkerResult<AnalyzeMorphResponse>> {
  return postJson(options, "/analyze/morph", { content }, validateMorphResponse);
}

export async function checkJapaneseWorkerHealth(
  options: JapaneseAnalysisClientOptions,
): Promise<WorkerResult<JapaneseWorkerHealth>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  try {
    const response = await fetchImpl(new URL("/health", options.baseUrl), {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, reason: "http_error", error: response.status };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      return { ok: false, reason: "invalid_json", error };
    }
    if (!isRecord(json) || json.ok !== true) {
      return { ok: false, reason: "invalid_response", error: json };
    }
    return { ok: true, data: { ok: true, ms: Date.now() - started } };
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return { ok: false, reason: "timeout", error };
    }
    return { ok: false, reason: "unreachable", error };
  }
}
