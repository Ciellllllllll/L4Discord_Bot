const SYMBOL_REPLACE_PATTERN = /[\[\]［］「」『』、。？！]/g;

// 半角カタカナ → 全角（U+FF61–FF9F ブロック）

export function toFullWidthKana(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const code = c.codePointAt(0)!;
    if (code >= 0xff61 && code <= 0xff9f) {
      out += String.fromCodePoint(code - 0xff61 + 0x30a1);
    } else {
      out += c;
    }
  }
  return out;
}

export function normalizeSenryuText(content: string): string {
  const nfc = content.normalize("NFC");
  const kana = toFullWidthKana(nfc);
  return kana.replace(SYMBOL_REPLACE_PATTERN, " ");
}
