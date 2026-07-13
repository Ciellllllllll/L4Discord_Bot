/** Runtime handler登録失敗時に、login前でもDBとDiscord clientを確実に解放する。 */
export async function initializeRuntimeHandlersWithCleanup<T>(options: {
  registerHandlers(): Promise<T>;
  closeDatabase(): Promise<void>;
  destroyClient(): void | Promise<void>;
  warn(error: unknown, message: string): void;
}): Promise<T> {
  try {
    return await options.registerHandlers();
  } catch (error) {
    await options.closeDatabase().catch((cleanupError) => {
      options.warn(cleanupError, "database runtime shutdown after handler registration failure failed");
    });
    await Promise.resolve(options.destroyClient()).catch((cleanupError) => {
      options.warn(cleanupError, "Discord client shutdown after handler registration failure failed");
    });
    throw error;
  }
}
