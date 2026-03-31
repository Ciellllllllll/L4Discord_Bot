/** メッセージがプレフィックスコマンドっぽいか（自動応答と競合しないようにする） */
export function looksLikePrefixCommandLine(content: string): boolean {
  return content.trimStart().startsWith("!");
}
