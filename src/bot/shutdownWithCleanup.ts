export async function shutdownWithCleanup(options: {
  shutdownHandlers(): Promise<void>;
  closeDatabase(): Promise<void>;
  warn(error: unknown, message: string): void;
}): Promise<void> {
  let firstError: unknown;
  try {
    await options.shutdownHandlers();
  } catch (error) {
    firstError = error;
    options.warn(error, "runtime handler shutdown failed");
  }
  try {
    await options.closeDatabase();
  } catch (error) {
    firstError ??= error;
    options.warn(error, "database runtime shutdown failed");
  }
  if (firstError) throw firstError;
}
