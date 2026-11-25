import { randomBytes } from "node:crypto";

export class TtlStore<T> {
  private readonly entries = new Map<string, { value: T; lastTouchedAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  sweep(): void {
    const current = this.now();
    for (const [key, entry] of this.entries.entries()) {
      if (current - entry.lastTouchedAt > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  get(key: string): T | null {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.lastTouchedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastTouchedAt = this.now();
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, lastTouchedAt: this.now() });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  generateId(length = 8): string {
    for (let i = 0; i < 5; i += 1) {
      const id = randomBytes(6)
        .toString("base64url")
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, length);
      if (id && !this.entries.has(id)) return id;
    }
    return `${this.now().toString(36)}${Math.floor(Math.random() * 1000)}`.slice(0, length);
  }
}
