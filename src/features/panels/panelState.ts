export type PanelMessageState = {
  /** 常設 UI の論理版（releaseVersions.PERMANENT_UI_VERSION と照合） */
  ui_version: string;
  status: "pending" | "sent" | "error";
  last_error?: string;
  last_sent_at?: string;
};

export function parsePanelState(raw: unknown): PanelMessageState {
  const o =
    typeof raw === "string"
      ? (JSON.parse(raw) as Record<string, unknown>)
      : (raw as Record<string, unknown> | null) ?? {};
  const ui =
    typeof o.ui_version === "string"
      ? o.ui_version
      : typeof o.panel_version === "string"
        ? o.panel_version
        : "0.0.0";
  return {
    ui_version: ui,
    status: o.status === "sent" || o.status === "error" || o.status === "pending" ? o.status : "pending",
    last_error: typeof o.last_error === "string" ? o.last_error : undefined,
    last_sent_at: typeof o.last_sent_at === "string" ? o.last_sent_at : undefined,
  };
}

export function serializePanelState(s: PanelMessageState): Record<string, unknown> {
  return {
    ui_version: s.ui_version,
    status: s.status,
    last_error: s.last_error,
    last_sent_at: s.last_sent_at,
  };
}
