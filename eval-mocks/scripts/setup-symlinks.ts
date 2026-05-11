import {
  existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, lstatSync, chmodSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM compat: __dirname is not defined in ES modules.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Canonical CLI list. Mirrors the SYSTEM_PROMPT in src/server.ts. When a
// new CLI is added to the worker, add it here too.
const CLIS = [
  "slack-pp-cli",
  "scrape-creators-pp-cli",
  "contentful-pp-cli",
  "ga4-pp-cli",
  "screaming-frog-pp-cli",
];

const repoRoot = path.resolve(__dirname, "..", "..");
const binDir = path.join(repoRoot, "eval-mocks", "bin");
// Built artifact path. tsc emits eval-mocks/src/cli.ts → dist/eval-mocks/src/cli.js
const target = path.join(repoRoot, "dist", "eval-mocks", "src", "cli.js");

if (!existsSync(target)) {
  console.error(
    `setup-symlinks: build artifact missing at ${target}\n` +
    `Run \`npm run build\` first.`,
  );
  process.exit(1);
}

// Ensure the built artifact is executable (tsc does not set +x).
chmodSync(target, 0o755);

if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

// Idempotent: if the link exists pointing to the right target, skip.
// If it exists pointing elsewhere, remove and recreate.
let created = 0;
let updated = 0;
for (const cli of CLIS) {
  const link = path.join(binDir, cli);
  const relTarget = path.relative(binDir, target);

  if (existsSync(link) || lstatExists(link)) {
    let existing: string | null = null;
    try { existing = readlinkSync(link); } catch { /* not a symlink */ }
    if (existing === relTarget) continue;
    unlinkSync(link);
    updated++;
  } else {
    created++;
  }
  symlinkSync(relTarget, link);
}

console.log(
  `setup-symlinks: ${created} created, ${updated} updated, ${CLIS.length - created - updated} unchanged`,
);

function lstatExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}
