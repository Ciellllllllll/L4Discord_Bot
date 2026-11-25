import * as fs from "node:fs";
import * as path from "node:path";

export type UserPromptStoreOptions = {
  basePromptPath: string;
  userPromptDir: string;
  warn?: (meta: Record<string, unknown>, message: string) => void;
};

const DEFAULT_BASE_PROMPT = "You are a helpful assistant. 簡潔に日本語で答えてください。";

function stripText(text: string): string {
  return String(text || "").trim();
}

export function sanitizePromptFileUserName(userName: string): string {
  const base = stripText(userName)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ");
  const cleaned = base.replace(/[. ]+$/g, "");
  if (!cleaned) return "user";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `${cleaned}_user`;
  }
  return cleaned;
}

export function sanitizePromptFileUserId(userId: string): string {
  const trimmed = stripText(userId);
  if (/^\d+$/.test(trimmed)) return trimmed;
  return sanitizePromptFileUserName(trimmed || "user");
}

export function readBasePromptFile(filePath: string): { template: string; resolved: string } {
  const file = path.resolve(filePath);
  let template = DEFAULT_BASE_PROMPT;
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      if (stripText(raw)) template = raw;
    }
  } catch (err) {
    console.warn(`failed to read base prompt file: ${file}`, err);
  }
  const resolved = stripText(template) || "You are a helpful assistant.";
  return { template, resolved };
}

export class UserPromptStore {
  private readonly userPromptPaths = new Map<string, string>();
  private basePromptTemplate: string;
  private basePromptResolved: string;

  constructor(private readonly options: UserPromptStoreOptions) {
    fs.mkdirSync(path.resolve(this.options.userPromptDir), { recursive: true });
    const latest = this.refreshBasePrompt();
    this.basePromptTemplate = latest.template;
    this.basePromptResolved = latest.resolved;
  }

  refreshBasePrompt(): { template: string; resolved: string } {
    const latest = readBasePromptFile(this.options.basePromptPath);
    this.basePromptTemplate = latest.template;
    this.basePromptResolved = latest.resolved;
    return latest;
  }

  private userPromptPath(userId: string): string {
    const fileName = `${sanitizePromptFileUserId(userId)}_prompt.txt`;
    return path.join(path.resolve(this.options.userPromptDir), fileName);
  }

  private legacyUserPromptPath(userName: string): string {
    const fileName = `${sanitizePromptFileUserName(userName)}_prompt.txt`;
    return path.join(path.resolve(this.options.userPromptDir), fileName);
  }

  private ensureUserPromptFile(userId: string, resolvedUserName: string): string {
    this.refreshBasePrompt();
    const uid = String(userId);
    const nextPath = this.userPromptPath(uid);
    const prevPath = this.userPromptPaths.get(uid);
    const legacyPath = this.legacyUserPromptPath(resolvedUserName);

    if (prevPath && prevPath !== nextPath && fs.existsSync(prevPath) && !fs.existsSync(nextPath)) {
      try {
        fs.copyFileSync(prevPath, nextPath);
      } catch (err) {
        this.options.warn?.({ err, path: nextPath }, "failed to migrate user prompt file");
      }
    } else if (legacyPath !== nextPath && fs.existsSync(legacyPath) && !fs.existsSync(nextPath)) {
      try {
        fs.copyFileSync(legacyPath, nextPath);
      } catch (err) {
        this.options.warn?.({ err, path: nextPath }, "failed to migrate legacy user prompt file");
      }
    }

    if (!fs.existsSync(nextPath)) {
      try {
        fs.writeFileSync(nextPath, this.basePromptTemplate, "utf8");
      } catch (err) {
        this.options.warn?.({ err, path: nextPath }, "failed to create user prompt file");
      }
    }

    this.userPromptPaths.set(uid, nextPath);
    return nextPath;
  }

  load(userId: string, resolvedUserName: string): string {
    const filePath = this.ensureUserPromptFile(userId, resolvedUserName);
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return stripText(text) || this.basePromptResolved;
    } catch {
      return this.basePromptResolved;
    }
  }

  save(userId: string, resolvedUserName: string, promptText: string): void {
    const filePath = this.ensureUserPromptFile(userId, resolvedUserName);
    const text = stripText(promptText) || this.basePromptResolved;
    try {
      fs.writeFileSync(filePath, text, "utf8");
    } catch (err) {
      this.options.warn?.({ err, path: filePath }, "failed to write user prompt file");
    }
  }

  replaceRaw(userId: string, fullPromptText: string): void {
    const uid = String(userId);
    fs.mkdirSync(path.resolve(this.options.userPromptDir), { recursive: true });
    const filePath = this.userPromptPath(uid);
    const text = stripText(fullPromptText);
    if (!text) return;
    try {
      fs.writeFileSync(filePath, text, "utf8");
    } catch (err) {
      this.options.warn?.({ err, path: filePath }, "failed to write user prompt file");
    }
    this.userPromptPaths.set(uid, filePath);
  }

  updatedAt(userId: string, resolvedUserName: string): Date | null {
    const filePath = this.ensureUserPromptFile(userId, resolvedUserName);
    try {
      return fs.statSync(filePath).mtime;
    } catch {
      return null;
    }
  }
}
