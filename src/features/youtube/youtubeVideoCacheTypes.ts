import type { YouTubeVideoCacheMediaMode, YouTubeVideoCacheReference } from "./youtubeVideoCache.repository.js";

// YouTube 動画キャッシュで共有する型。

export type CacheReferenceRepository = {
  listVpsVideoCacheReferences(videoId?: string): Promise<YouTubeVideoCacheReference[]>;
  listVideoCacheReferences(videoId: string, mediaMode?: YouTubeVideoCacheMediaMode): Promise<YouTubeVideoCacheReference[]>;
  updateVideoCacheReferenceMedia(messageId: string, mediaMode: YouTubeVideoCacheMediaMode, lastError: string | null): Promise<void>;
  deleteVideoCacheReference(messageId: string): Promise<void>;
  listDueGoogleVideoRetries?(cutoff: Date, limit: number): Promise<YouTubeVideoCacheReference[]>;
};

export type CacheReferenceLockingRepository = CacheReferenceRepository & {
  withVideoCacheLock?<T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T>;
  withGoogleVideoRetryLock?<T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T>;
};

export type EditableMessage = {
  author?: { id?: string };
  components?: readonly { toJSON?: () => unknown }[];
  edit(payload: unknown): Promise<unknown>;
};

export type MaintenanceDependencies = {
  repo: CacheReferenceLockingRepository;
  client: {
    user?: { id?: string } | null;
    channels: { fetch(channelId: string): Promise<{ messages?: { fetch(messageId: string): Promise<EditableMessage> } } | null> };
  };
  resolveMedia(url: string): Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }>;
  cleanup(): Promise<{ evictedVideoIds: string[] }>;
  videoExists(videoId: string): Promise<boolean>;
  withLock?<T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T>;
  withRetryLock?<T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T>;
  setInterval?(callback: () => void, delay: number): NodeJS.Timeout;
  clearInterval?(timer: NodeJS.Timeout): void;
  onError?(error: unknown): void;
  enableVpsMaintenance?: boolean;
  now?: () => Date;
};

export type YouTubeVideoCacheMaintenanceController = { stop(): void };
