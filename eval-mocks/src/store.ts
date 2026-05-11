import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import type { AuditLog, Cassette, FixtureKey } from "./types.js";

export function cassettePath(dir: string, key: FixtureKey): string {
  return path.join(dir, key.cli, `${key.slug}__${key.hash}.json`);
}

export function auditPath(dir: string, key: FixtureKey): string {
  return path.join(dir, key.cli, `${key.slug}__${key.hash}.audit.json`);
}

export function readCassette(dir: string, key: FixtureKey): Cassette | null {
  const p = cassettePath(dir, key);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Cassette;
}

/**
 * Atomic write: writes to <name>.tmp then renames. If the process dies
 * before the rename, a stale .tmp may remain — we delete any pre-existing
 * .tmp at the same target path before writing. The audit file is written
 * after the cassette so a half-written pair leaves only the cassette.
 */
export function writeCassette(
  dir: string,
  key: FixtureKey,
  cassette: Cassette,
  audit: AuditLog,
): void {
  const cliDir = path.join(dir, key.cli);
  if (!existsSync(cliDir)) mkdirSync(cliDir, { recursive: true });

  const cp = cassettePath(dir, key);
  const ap = auditPath(dir, key);
  const cpTmp = `${cp}.tmp`;
  const apTmp = `${ap}.tmp`;

  if (existsSync(cpTmp)) unlinkSync(cpTmp);
  if (existsSync(apTmp)) unlinkSync(apTmp);

  writeFileSync(cpTmp, JSON.stringify(cassette, null, 2));
  renameSync(cpTmp, cp);

  writeFileSync(apTmp, JSON.stringify(audit, null, 2));
  renameSync(apTmp, ap);
}

interface IndexEntry {
  cli: string;
  filename: string;
  hash: string;
  slug: string;
  recorded_at: string;
  cli_version: string;
}

/**
 * Walk every <cli>/ subdirectory of `dir`, collect cassette files
 * (matching the `<slug>__<hash>.json` pattern, excluding .audit.json),
 * and emit INDEX.md grouping by CLI.
 */
export function regenerateIndex(dir: string): void {
  const entries: IndexEntry[] = [];
  if (!existsSync(dir)) {
    writeFileSync(path.join(dir, "INDEX.md"), "# Eval cassettes\n\nNo cassettes recorded yet.\n");
    return;
  }
  const cliDirs = readdirSync(dir).filter((name) => {
    const p = path.join(dir, name);
    return name !== ".anonymize" && !name.startsWith(".") && statSync(p).isDirectory();
  });

  for (const cli of cliDirs) {
    const cliPath = path.join(dir, cli);
    for (const f of readdirSync(cliPath)) {
      if (!f.endsWith(".json") || f.endsWith(".audit.json") || f.endsWith(".tmp")) continue;
      const m = f.match(/^(.+)__([0-9a-f]{8})\.json$/);
      if (!m) continue;
      try {
        const cassette = JSON.parse(readFileSync(path.join(cliPath, f), "utf8")) as Cassette;
        entries.push({
          cli,
          filename: f,
          slug: m[1]!,
          hash: m[2]!,
          recorded_at: cassette.meta.recorded_at,
          cli_version: cassette.meta.cli_version,
        });
      } catch {
        // skip unparseable
      }
    }
  }

  let md = "# Eval cassettes\n\n";
  if (entries.length === 0) {
    md += "No cassettes recorded yet.\n";
  } else {
    md += `${entries.length} cassettes across ${new Set(entries.map((e) => e.cli)).size} CLIs.\n\n`;
    md += "| CLI | Slug | Hash | Recorded | CLI version |\n";
    md += "|---|---|---|---|---|\n";
    entries.sort((a, b) => a.cli.localeCompare(b.cli) || a.slug.localeCompare(b.slug));
    for (const e of entries) {
      md += `| ${e.cli} | ${e.slug} | \`${e.hash}\` | ${e.recorded_at} | ${e.cli_version} |\n`;
    }
  }
  writeFileSync(path.join(dir, "INDEX.md"), md);
}
