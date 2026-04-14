declare module "kuromoji" {
  export interface IpadicToken {
    word_id: number;
        // KNOWN | UNKNOWN | …

    word_type: string;
    word_position: number;
    surface_form: string;
    pos: string;
    pos_detail_1: string;
    pos_detail_2: string;
    pos_detail_3: string;
    conjugated_type: string;
    conjugated_form: string;
    basic_form: string;
    reading: string;
    pronunciation: string;
  }

  export interface Tokenizer {
    tokenize(text: string): IpadicToken[];
  }

  export interface TokenizerBuilder {
    build(cb: (err: Error | null, tokenizer: Tokenizer) => void): void;
  }

  export interface KuromojiModule {
    builder(options?: { dicPath?: string }): TokenizerBuilder;
  }

  const kuromoji: KuromojiModule;
  export default kuromoji;
}
