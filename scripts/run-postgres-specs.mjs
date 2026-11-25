import { spawn, spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const compose = ["compose", "-f", "docker-compose.test.yml"];
const SERIAL_SPEC_PATTERN =
  /TEST_DATABASE_URL|REQUIRE_POSTGRES_TESTS|DATABASE_URL|postgres|kysely|migrations|createDatabase|databaseRuntime|\bPool\b/i;

function runAsync(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
      }
    });
  });
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function collectSpecs() {
  const files = [
    ...globSync("src/**/*.spec.ts"),
    ...globSync("scripts/**/*.spec.mjs"),
  ].sort();

  const parallelSpecs = [];
  const serialSpecs = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    if (SERIAL_SPEC_PATTERN.test(file) || SERIAL_SPEC_PATTERN.test(content)) {
      serialSpecs.push(file);
    } else {
      parallelSpecs.push(file);
    }
  }

  return { parallelSpecs, serialSpecs };
}

const { parallelSpecs, serialSpecs } = collectSpecs();
const concurrency = Math.max(1, availableParallelism());

let postgresStarted = false;

try {
  // Start Docker PostgreSQL while running pure unit tests in parallel across CPU cores
  const postgresReady = runAsync("docker", [...compose, "up", "--detach", "--wait"]).then(() => {
    postgresStarted = true;
    const port = output("docker", [...compose, "port", "postgres", "5432"]).match(/:(\d+)$/)?.[1];
    if (!port) {
      throw new Error("Docker PostgreSQL host port could not be resolved");
    }
    return `postgres://l4discord:l4discord@127.0.0.1:${port}/l4discord_test`;
  });

  const parallelTask =
    parallelSpecs.length > 0
      ? runAsync(process.execPath, [
          "--import",
          "tsx",
          "--test",
          `--test-concurrency=${concurrency}`,
          "--test-timeout=120000",
          ...parallelSpecs,
        ])
      : Promise.resolve();

  const serialTask = postgresReady.then((databaseUrl) => {
    if (serialSpecs.length === 0) {
      return;
    }
    return runAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-timeout=120000",
        ...serialSpecs,
      ],
      {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TEST_DATABASE_URL: databaseUrl,
        REQUIRE_POSTGRES_TESTS: "1",
      },
    );
  });

  const results = await Promise.allSettled([parallelTask, serialTask]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw failures[0].reason;
  }
} finally {
  if (postgresStarted) {
    spawnSync("docker", [...compose, "down", "--volumes"], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
    });
  } else {
    spawnSync("docker", [...compose, "down", "--volumes"], {
      cwd: process.cwd(),
      stdio: "ignore",
      shell: false,
    });
  }
}
