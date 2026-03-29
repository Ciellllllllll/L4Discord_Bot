export type ParsedCustomId = {
  domain: string;
  action: string;
  shortId: string;
};

export function parseCustomId(customId: string): ParsedCustomId | null {
  const parts = customId.split(":");
  if (parts.length < 3) return null;
  const [domain, action, ...rest] = parts;
  const shortId = rest.join(":");
  if (!domain || !action || !shortId) return null;
  return { domain, action, shortId };
}
