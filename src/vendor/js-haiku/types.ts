export interface MorphToken {
  surface: string;
  features: string[];
}

export type DebugWriter = (line: string) => void;

export interface Opt {
  debug?: boolean;
  debugWriter?: DebugWriter;
}

export interface CreateTokenizerOptions {
  dicPath?: string;
  userDictPath?: string;
}

export interface HaikuTokenizer {
  match(text: string, rule: number[]): boolean;
  matchWithOpt(text: string, rule: number[], opt?: Opt): boolean;
  find(text: string, rule: number[]): string[];
  findWithOpt(text: string, rule: number[], opt?: Opt): Promise<string[]>;
}

export function useDict(_dict: unknown): void {}
