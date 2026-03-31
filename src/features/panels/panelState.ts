export type PanelMessageState = {
  panel_version: string;
  status: "pending" | "sent" | "error";
  last_error?: string;
  last_sent_at?: string;
};

export function parsePanelState(raw: unknown): PanelMessageState {
  const o =
    typeof raw === "string"
      ? (JSON.parse(raw) as Record<string, unknown>)
      : (raw as Record<string, unknown> | null) ?? {};
  return {
    panel_version: typeof o.panel_version === "string" ? o.panel_version : "0.0.0",
    status: o.status === "sent" || o.status === "error" || o.status === "pending" ? o.status : "pending",
    last_error: typeof o.last_error === "string" ? o.last_error : undefined,
    last_sent_at: typeof o.last_sent_at === "string" ? o.last_sent_at : undefined,
  };
}

export function serializePanelState(s: PanelMessageState): Record<string, unknown> {
  return {
    panel_version: s.panel_version,
    status: s.status,
    last_error: s.last_error,
    last_sent_at: s.last_sent_at,
  };
}
