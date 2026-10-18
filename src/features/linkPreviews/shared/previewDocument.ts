export type PreviewSource = "x" | "youtube" | "steam" | "github" | "tiktok" | "instagram" | "web";

export type PreviewAction = {
  label: string;
  url: string;
};

export type PreviewTextPart = {
  text: string;
  translationKey?: string;
  strong?: boolean;
};

export type PreviewTextLine = {
  prefix?: string;
  parts: PreviewTextPart[];
};

export type PreviewTextBlock = {
  type: "text";
  id: string;
  lines: PreviewTextLine[];
  thumbnailUrl?: string;
  thumbnailDescription?: string;
  /** センシティブな投稿の画像などで、サムネイルをスポイラーにする */
  thumbnailSpoiler?: boolean;
};

export type PreviewMediaItem = {
  url: string;
  description?: string;
  spoiler?: boolean;
};

export type PreviewMediaBlock = {
  type: "media";
  id: string;
  items: PreviewMediaItem[];
};

export type PreviewBlock = PreviewTextBlock | PreviewMediaBlock;

export type PreviewDocument = {
  version: 1;
  source: PreviewSource;
  url: string;
  openLabel: string;
  secondaryAction?: PreviewAction;
  /** 開くボタンの URL のページを AI で要約する「AI要約」ボタンを付ける */
  summaryAction?: boolean;
  blocks: PreviewBlock[];
};
