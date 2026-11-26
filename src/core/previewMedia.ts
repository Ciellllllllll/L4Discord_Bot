import { ComponentType, type APIMessageTopLevelComponent } from "discord.js";

// discord.js のコンポーネント配列を書き換えるだけで、機能固有の知識を持たない。
export function replacePreviewMedia(
  components: readonly unknown[],
  mediaUrl?: string,
  options: { fallback?: boolean; description?: string } = {},
): APIMessageTopLevelComponent[] {
  const next = structuredClone(components) as Array<Record<string, unknown>>;
  const transform = (children: unknown[]): Array<Record<string, unknown>> => children.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const component = value as Record<string, unknown>;
    if (Array.isArray(component.components)) component.components = transform(component.components);
    return [component];
  });
  const containers: Array<Record<string, unknown>> = [];
  const visit = (component: Record<string, unknown>): void => {
    if (!Array.isArray(component.components)) return;
    component.components = transform(component.components).filter((child) => child.type !== ComponentType.MediaGallery);
    if (component.type === ComponentType.Container) containers.push(component);
    for (const child of component.components as Array<Record<string, unknown>>) visit(child);
  };
  for (const component of next) visit(component);
  const container = containers[0];
  if (container && mediaUrl && Array.isArray(container.components)) {
    const children = container.components as Array<Record<string, unknown>>;
    const index = children.findIndex((child) => child.type === ComponentType.ActionRow);
    children.splice(index < 0 ? children.length : index, 0, {
      type: ComponentType.MediaGallery,
      items: [{ media: { url: mediaUrl }, description: options.description ?? "Preview media" }],
    });
  }
  return next as unknown as APIMessageTopLevelComponent[];
}
