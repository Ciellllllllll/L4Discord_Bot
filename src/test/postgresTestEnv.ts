export function getOptionalPostgresTestUrl(envName: "DATABASE_URL" | "TEST_DATABASE_URL", specName: string): string | null {
  const connectionString = process.env[envName];
  if (connectionString) return connectionString;

  const message = `${specName}: ${envName} is not set`;
  if (process.env.REQUIRE_POSTGRES_TESTS === "1") {
    throw new Error(`${message}; PostgreSQL integration assertions are required in this test run`);
  }
  console.log(`${message}; skipping PostgreSQL integration assertions`);
  return null;
}
