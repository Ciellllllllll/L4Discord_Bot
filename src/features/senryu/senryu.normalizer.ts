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
  // 句読点・括弧・空白等を「空白1文字」にしない（kuromoji が読み無しの「空白」トークンを出し 5-7-5 検出が途切れるため）。
  // ASCII 読点（, . 等）は名詞扱いで誤分割されることもあるので、解析前にまとめて除去する。
  return kana.replace(/[\p{P}\p{Z}\p{Cf}]+/gu, "");
}
