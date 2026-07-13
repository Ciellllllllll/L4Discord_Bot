export async function loginWithCleanup(options: {
  login(): Promise<unknown>;
  shutdownHandlers(): Promise<void>;
  closeDatabase(): Promise<void>;
  warn(error: unknown, message: string): void;
}): Promise<void> {
  try {
    await options.login();
  } catch (error) {
    await options.shutdownHandlers().catch((shutdownError) => {
      options.warn(shutdownError, "runtime handler shutdown after login failure failed");
    });
    await options.closeDatabase().catch((closeError) => {
      options.warn(closeError, "database runtime shutdown after login failure failed");
    });
    throw error;
  }
}
