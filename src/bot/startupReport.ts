import type { Logger } from "pino";

export class StartupReport {
  private readonly completedComponents: string[] = [];
  private readonly failedComponents: string[] = [];

  constructor(
    private readonly log: Logger,
    private readonly guildId: string,
  ) {}

  async run(component: string, operation: () => Promise<void>): Promise<boolean> {
    try {
      await operation();
      this.completedComponents.push(component);
      return true;
    } catch (err) {
      const failedComponents = getFailedComponents(err, component);
      this.failedComponents.push(...failedComponents);
      this.log.error({ err, component, failedComponents, guildId: this.guildId }, "startup task failed");
      return false;
    }
  }

  logSummary(): void {
    if (this.failedComponents.length === 0) {
      this.log.info(
        {
          completedComponents: this.completedComponents,
          completedCount: this.completedComponents.length,
          guildId: this.guildId,
        },
        "Startup reconciliation completed successfully.",
      );
      return;
    }

    this.log.warn(
      {
        completedCount: this.completedComponents.length,
        failedComponents: this.failedComponents,
        guildId: this.guildId,
      },
      "Startup reconciliation completed with issues.",
    );
  }
}

function getFailedComponents(err: unknown, fallback: string): string[] {
  if (typeof err !== "object" || err === null || !("failedComponents" in err)) return [fallback];
  const value = (err as { failedComponents?: unknown }).failedComponents;
  return Array.isArray(value) && value.every((component) => typeof component === "string") && value.length > 0
    ? value
    : [fallback];
}
