export type JapaneseWorkerFailureReason =
  | "timeout"
  | "unreachable"
  | "http_error"
  | "invalid_json"
  | "invalid_response";

export type WorkerResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: JapaneseWorkerFailureReason; error?: unknown };

export type AnalyzeSenryuRequest = {
  content: string;
  rule?: [number, number, number];
};

export type AnalyzeSenryuResponse = {
  matched: boolean;
  text: string | null;
  phrases: string[];
  error: string | null;
};

export type JapaneseMorphToken = {
  surface: string;
  base: string;
  reading: string;
  pos: string[];
  isProperNoun: boolean;
  isOov: boolean;
};

export type AnalyzeMorphResponse = {
  tokens: JapaneseMorphToken[];
  error: string | null;
};

export type JapaneseAnalysisClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export type JapaneseWorkerHealth = {
  ok: true;
  ms: number;
};
