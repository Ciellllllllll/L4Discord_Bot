/**
 * DeepSeek の応答本文からレビュー JSON を取り出す。
 * response_format=json_object でも、末尾カンマ（`"body": "...",\n}`）のような
 * 厳密でない JSON が返ることがあるため、文字列の外にある末尾カンマだけを取り除いて再解析する。
 */
export function extractJson(text) {
  const trimmed = String(text ?? "").trim();
  const candidates = [];

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push(trimmed);
  } else {
    // 本文中のコードブロックで途中が切れないよう、外側の波括弧の範囲を優先する
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }

    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);

    if (fenceMatch) {
      candidates.push(fenceMatch[1].trim());
    }
  }

  if (candidates.length === 0) {
    throw new Error("DeepSeek response did not contain JSON.");
  }

  let firstError;

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      firstError ??= error;
    }

    try {
      return JSON.parse(removeTrailingCommas(candidate));
    } catch {
      // 次の候補を試す
    }
  }

  throw new Error(`DeepSeek response was not valid JSON: ${firstError.message}\n${describeErrorContext(candidates[0], firstError)}`, { cause: firstError });
}

/** 文字列リテラルの外にある `,` のうち、直後（空白を除く）が `}` または `]` のものを削除する。 */
export function removeTrailingCommas(text) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        continue;
      }
    }

    result += ch;
  }

  return result;
}

/** 解析エラー位置の前後を短く切り出し、失敗通知から原因を追えるようにする。 */
function describeErrorContext(text, error) {
  const match = /position (\d+)/.exec(String(error?.message ?? ""));

  if (!match) {
    return "";
  }

  const position = Number(match[1]);
  const start = Math.max(0, position - 80);
  const end = Math.min(text.length, position + 40);

  return `near: ${JSON.stringify(text.slice(start, end))}`;
}
