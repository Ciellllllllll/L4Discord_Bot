export interface MorphToken {
  surface: string;
  features: string[];
}

export type DebugWriter = (line: string) => void;

export interface Opt {
  debug?: boolean;
  debugWriter?: DebugWriter;
}
