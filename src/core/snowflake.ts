// Discord Snowflake を参照DB互換の SQLite INTEGER として扱う（64bit、JS Number は不可）


export function snowflakeToBigInt(id: string): bigint {
  return BigInt(id);
}

export function bigIntToSnowflake(v: bigint | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return typeof v === "bigint" ? v.toString() : BigInt(Math.trunc(v)).toString();
}
