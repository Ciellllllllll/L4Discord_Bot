// Discord Snowflake は64bit整数のため、JavaScriptのNumberではなく文字列で扱う。

export function normalizeSnowflake(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return /^\d+$/.test(s) ? s : null;
}

export function snowflakeToBigInt(id: string): bigint {
  return BigInt(id);
}

export function bigIntToSnowflake(v: bigint | number | string | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^\d+$/.test(s)) return "";
    return s;
  }
  if (!Number.isSafeInteger(v)) return "";
  return BigInt(Math.trunc(v)).toString();
}
