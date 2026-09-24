/**
 * Discord の公式 Embed はメッセージ作成後に非同期で付くため、プレビューのために抑制した後から付くことがある。
 * 抑制したメッセージをしばらく監視し、Embed が付いた更新（messageUpdate）が来たらすぐに抑制し直す。
 */

/** 監視する期間。Discord の Embed 生成（リンク先の取得）は通常数秒〜数十秒で終わる */
export const LATE_EMBED_WATCH_MS = 2 * 60 * 1000;

type MessageUpdateSource = {
  on(event: "messageUpdate", listener: (oldMessage: unknown, newMessage: unknown) => void): unknown;
  off(event: "messageUpdate", listener: (oldMessage: unknown, newMessage: unknown) => void): unknown;
};

/** 監視に必要なのは ID と抑制の操作だけ（discord.js の Message もそのまま渡せる） */
type WatchedMessage = { id: string; suppressEmbeds(suppress: boolean): Promise<unknown> };

type LoggerLike = { warn: (obj: unknown, msg?: string) => void };

/**
 * 監視中のメッセージを登録簿で管理し、messageUpdate のリスナーは1本だけ共有する
 * （メッセージごとにリスナーを足すと、同時に多くのプレビューが走ったときにリスナーが増えすぎるため）。
 */
export class LateEmbedWatcher {
  private readonly watched = new Map<string, { message: WatchedMessage; timer: NodeJS.Timeout }>();
  private listening = false;

  constructor(
    private readonly source: MessageUpdateSource,
    private readonly log: LoggerLike,
    private readonly watchMs = LATE_EMBED_WATCH_MS,
  ) {}

  /** メッセージの監視を始める（監視中なら期間を延ばす）。 */
  watch(message: WatchedMessage): void {
    const existing = this.watched.get(message.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.unwatch(message.id), this.watchMs);
    // 監視のためだけにプロセスの終了を妨げない
    timer.unref?.();
    this.watched.set(message.id, { message, timer });
    if (!this.listening) {
      this.source.on("messageUpdate", this.onUpdate);
      this.listening = true;
    }
  }

  unwatch(messageId: string): void {
    const entry = this.watched.get(messageId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.watched.delete(messageId);
    if (this.watched.size === 0 && this.listening) {
      this.source.off("messageUpdate", this.onUpdate);
      this.listening = false;
    }
  }

  private readonly onUpdate = (_oldMessage: unknown, newMessage: unknown): void => {
    if (!newMessage || typeof newMessage !== "object") return;
    const { id, embeds } = newMessage as { id?: unknown; embeds?: unknown };
    const entry = typeof id === "string" ? this.watched.get(id) : undefined;
    // 抑制したこと自体による更新は Embed が空なので何もしない
    if (!entry || !Array.isArray(embeds) || embeds.length === 0) return;
    void entry.message.suppressEmbeds(true).catch((err: unknown) => {
      this.log.warn({ err: String(err), messageId: entry.message.id }, "late embed suppression on update failed");
    });
  };
}
