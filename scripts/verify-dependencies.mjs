import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import semver from "semver";

const require = createRequire(import.meta.url);
const SOURCE_DIRS = ["src", "scripts"];
const SOURCE_FILES = ["bot.ts"];
const REQUIRED_DISCORD_RANGE = ">=14.0.0 <15.0.0";
const DISCORD_V14_EXPORTS = [
  "ActionRowBuilder",
  "ButtonBuilder",
  "ChannelSelectMenuBuilder",
  "ChannelType",
  "EmbedBuilder",
  "GatewayIntentBits",
  "MessageFlags",
  "ModalBuilder",
  "Partials",
  "PermissionFlagsBits",
  "SlashCommandBuilder",
  "StringSelectMenuBuilder",
  "TextInputBuilder",
];
const RUNTIME_EXPORT_CONTRACTS = {
  "better-sqlite3": [["default", "function"]],
  bottleneck: [["default", "function"]],
  cheerio: [["load", "function"]],
  dotenv: [["config", "function"]],
  kuromoji: [["default", "object"]],
  kysely: [
    ["Kysely", "function"],
    ["SqliteDialect", "function"],
    ["sql", "function"],
  ],
  pino: [["default", "function"]],
  semver: [
    ["default", "object"],
    ["minVersion", "function"],
    ["satisfies", "function"],
    ["subset", "function"],
    ["coerce", "function"],
    ["gte", "function"],
  ],
  ulid: [["ulid", "function"]],
  zod: [["z", "object"]],
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageJsonPath(packageName) {
  return join("node_modules", ...packageName.split("/"), "package.json");
}

function readInstalledPackageJson(packageName) {
  const direct = packageJsonPath(packageName);
  if (existsSync(direct)) return readJson(direct);

  let current = dirname(require.resolve(packageName));
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return readJson(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`package.json not found for ${packageName}`);
}

function fail(message) {
  console.error(`dependency verification failed: ${message}`);
  process.exitCode = 1;
}

function assertDiscordRange(label, range) {
  if (typeof range !== "string" || !range.trim()) {
    fail(`${label} does not declare discord.js`);
    return;
  }
  const min = semver.minVersion(range);
  if (!min || !semver.satisfies(min, REQUIRED_DISCORD_RANGE)) {
    fail(`${label} must target discord.js ${REQUIRED_DISCORD_RANGE}; found ${range}`);
  }
  if (!semver.subset(range, REQUIRED_DISCORD_RANGE, { includePrerelease: false })) {
    fail(`${label} must not allow discord.js outside ${REQUIRED_DISCORD_RANGE}; found ${range}`);
  }
}

function collectSourceFiles(path) {
  if (!existsSync(path)) return [];
  const out = [];
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(child));
    } else if (/\.(?:c|m)?[jt]s$/.test(entry.name)) {
      out.push(child);
    }
  }
  return out;
}

function externalPackageName(specifier) {
  if (
    specifier.startsWith("node:") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  ) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0];
}

function collectExternalImports() {
  const files = [...SOURCE_FILES, ...SOURCE_DIRS.flatMap((dir) => collectSourceFiles(dir))];
  const packages = new Set();
  const importPattern = /^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const requirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [importPattern, dynamicImportPattern, requirePattern]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        const packageName = externalPackageName(specifier);
        if (packageName) packages.add(packageName);
      }
    }
    for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
      const specifier = match[1];
      const packageName = externalPackageName(specifier);
      if (packageName) packages.add(packageName);
    }
  }
  return packages;
}

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const declaredDependencies = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
};
const rootLockDependencies = {
  ...(lock.packages?.[""]?.dependencies ?? {}),
  ...(lock.packages?.[""]?.devDependencies ?? {}),
};

for (const [name, range] of Object.entries(declaredDependencies)) {
  const lockRange = rootLockDependencies[name];
  if (lockRange !== range) {
    fail(`package-lock root dependency mismatch for ${name}: package.json=${range}, package-lock=${lockRange ?? "missing"}`);
  }

  const lockedVersion = lock.packages?.[`node_modules/${name}`]?.version;
  if (!lockedVersion) {
    fail(`package-lock is missing node_modules/${name}`);
    continue;
  }
  if (!semver.satisfies(lockedVersion, range)) {
    fail(`locked ${name}@${lockedVersion} does not satisfy declared range ${range}`);
  }

  try {
    const installedVersion = readInstalledPackageJson(name).version;
    if (!semver.satisfies(installedVersion, range)) {
      fail(`installed ${name}@${installedVersion} does not satisfy declared range ${range}`);
    }
    if (installedVersion !== lockedVersion) {
      fail(`installed ${name}@${installedVersion} does not match package-lock ${lockedVersion}`);
    }
  } catch (err) {
    fail(`installed package check failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const name of collectExternalImports()) {
  if (!(name in declaredDependencies)) {
    fail(`external import "${name}" is used but not declared in package.json dependencies/devDependencies`);
  }
}

for (const [packageName, contracts] of Object.entries(RUNTIME_EXPORT_CONTRACTS)) {
  if (!(packageName in declaredDependencies)) continue;
  try {
    const mod = await import(packageName);
    for (const [exportName, expectedType] of contracts) {
      const actualType = typeof mod[exportName];
      if (actualType !== expectedType) {
        fail(`${packageName} export "${exportName}" must be ${expectedType}; found ${actualType}`);
      }
    }
  } catch (err) {
    fail(`runtime import failed for ${packageName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  await import("dotenv/config");
} catch (err) {
  fail(`runtime import failed for dotenv/config: ${err instanceof Error ? err.message : String(err)}`);
}

assertDiscordRange("package.json dependencies", pkg.dependencies?.["discord.js"]);
assertDiscordRange("package-lock root dependencies", lock.packages?.[""]?.dependencies?.["discord.js"]);

const lockedDiscordVersion = lock.packages?.["node_modules/discord.js"]?.version;
if (!lockedDiscordVersion || !semver.satisfies(lockedDiscordVersion, REQUIRED_DISCORD_RANGE)) {
  fail(`package-lock node_modules/discord.js must be ${REQUIRED_DISCORD_RANGE}; found ${lockedDiscordVersion ?? "missing"}`);
}

let discord;
let installedVersion;
try {
  discord = await import("discord.js");
  installedVersion = readInstalledPackageJson("discord.js").version;
} catch (err) {
  fail(`discord.js is not installed or cannot be imported: ${err instanceof Error ? err.message : String(err)}`);
}

if (installedVersion && !semver.satisfies(installedVersion, REQUIRED_DISCORD_RANGE)) {
  fail(`installed discord.js must be ${REQUIRED_DISCORD_RANGE}; found ${installedVersion}`);
}

if (discord) {
  const missing = DISCORD_V14_EXPORTS.filter((name) => !(name in discord));
  if (missing.length) {
    fail(`installed discord.js is missing v14 exports used by this codebase: ${missing.join(", ")}`);
  }
}

if (process.exitCode) {
  process.exit();
}

console.log(`dependency verification passed: ${Object.keys(declaredDependencies).length} declared packages; discord.js ${installedVersion ?? lockedDiscordVersion}`);
