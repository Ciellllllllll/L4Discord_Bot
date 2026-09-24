import { spawnSync } from "node:child_process";

const compose = ["compose", "-f", "docker-compose.test.yml"];

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}

try {
  run("docker", [...compose, "up", "--detach", "--wait"]);
  const port = output("docker", [...compose, "port", "postgres", "5432"]).match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("Docker PostgreSQL host port could not be resolved");
  const databaseUrl = `postgres://l4discord:l4discord@127.0.0.1:${port}/l4discord_test`;
  run(process.execPath, [
    "--import", "tsx",
    "--test",
    "--test-concurrency=1",
    "--test-timeout=120000",
    "src/**/*.spec.ts",
    "scripts/**/*.spec.mjs",
  ], {
    ...process.env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    REQUIRE_POSTGRES_TESTS: "1",
  });
} finally {
  spawnSync("docker", [...compose, "down", "--volumes"], { cwd: process.cwd(), stdio: "inherit", shell: false });
}
