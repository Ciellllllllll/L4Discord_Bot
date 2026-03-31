import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  GUILD_ID: z.string().min(1),
  DATABASE_PATH: z.string().min(1),
  OWNER_ID: z.string().min(1),
  ADMIN_ROLE_ID: z.string().min(1),
  BOT_VERSION: z.string().min(1),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_API_BASE: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().optional(),
  ),
  DETECTER_FALLBACK_CHANNEL_ID: z.string().optional(),
  SKIP_COMMAND_SYNC: z.preprocess(
    (v) => v === "true" || v === "1",
    z.boolean().optional().default(false),
  ),
  COMMAND_SYNC_DEBOUNCE_MS: z.coerce.number().int().min(0).default(0),
  GUILD_MISMATCH_POLICY: z.enum(["warn"]).optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  return parsed.data;
}
