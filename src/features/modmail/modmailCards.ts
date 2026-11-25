import { ComponentCardBuilder, componentCardsPayload, type ComponentCardsPayload } from "../../core/componentCard.js";
import { MM_OPEN, ticketDisplayCode, type ModmailThreadRow } from "./modmailRepository.js";

export function trimMax(text: string, n: number): string {
  const s = text.trim();
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function formatDiscordTime(isoOrDate: string | Date): string {
  const ms = new Date(isoOrDate).getTime();
  if (!Number.isFinite(ms)) return String(isoOrDate);
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

export function splitDiscordText(text: string, n = 1900): string[] {
  const src = text.trim();
  if (!src) return [""];
  const out: string[] = [];
  let left = src;
  while (left.length > n) {
    let cut = left.lastIndexOf("\n", n);
    if (cut <= 0) cut = n;
    out.push(left.slice(0, cut));
    left = left.slice(cut).replace(/^\n+/, "");
  }
  out.push(left);
  return out;
}

export function buildModmailThreadSummaryEmbed(row: ModmailThreadRow, data: Record<string, unknown>): ComponentCardBuilder {
  const code = ticketDisplayCode(row.id);
  const subject = trimMax(String(data.subject ?? "(未設定)"), 1024);
  const body = trimMax(String(data.body ?? "(本文なし)"), 1024);
  return new ComponentCardBuilder()
    .setTitle(`Modmail-${code}_対応中`)
    .addFields(
      { name: "チケットID", value: code, inline: true },
      { name: "チケット作成日時", value: formatDiscordTime(row.created_at), inline: true },
      { name: "タイトル", value: subject, inline: false },
      { name: "相談内容", value: body, inline: false },
      { name: "現在状態", value: row.status || MM_OPEN, inline: true },
      { name: "クローズ操作", value: "下のボタンからチケットをクローズできます。", inline: false },
    )
    .setTimestamp(new Date());
}

export function buildParentTicketCard(row: ModmailThreadRow, data: Record<string, unknown>): ComponentCardBuilder {
  const code = ticketDisplayCode(row.id);
  const title = trimMax(String(data.subject ?? `Modmail-${code}`), 256);
  return new ComponentCardBuilder()
    .setTitle(title)
    .setDescription(`Modmail-${code}_対応中`)
    .setTimestamp(new Date());
}

export function buildModmailStartDmPayload(rows: unknown[]): ComponentCardsPayload {
  return componentCardsPayload(
    [
      new ComponentCardBuilder()
        .setTitle("お問い合わせ受付")
        .setDescription(
          [
            "お問い合わせ受付です。",
            "下の「チケットを作成」ボタンからタイトル・詳細・任意の添付を入力すると、スタッフ側にチケットが作成されます。",
            "チケット作成前の通常メッセージはスタッフ側に送信されません。",
          ].join("\n"),
        )
        .setTimestamp(new Date()),
    ],
    rows as never,
  );
}
