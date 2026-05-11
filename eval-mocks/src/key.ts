import { createHash } from "node:crypto";
import type { FixtureKey } from "./types.js";

export type ArgNormalization = "flag-order-insensitive" | "preserve-order";

/**
 * Normalize argv so that semantically-equivalent invocations produce the
 * same key. In flag-order-insensitive mode, pairs of (--flag, value) are
 * sorted alphabetically by flag name; positional args keep their order.
 *
 * `--flag=value` is canonicalized to ["--flag", "value"] before sorting.
 * Boolean flags (--flag with no following value or with a following flag)
 * are sorted as standalone tokens.
 *
 * Repeated flags (--include a --include b) keep their relative order
 * within the repetition group, which matters when the CLI treats order
 * as semantically meaningful.
 */
export function normalizeArgv(argv: string[], mode: ArgNormalization): string[] {
  if (mode === "preserve-order") return [...argv];

  // Step 1: split = forms (--flag=val → --flag val)
  const expanded: string[] = [];
  for (const tok of argv) {
    const eq = tok.indexOf("=");
    if (tok.startsWith("--") && eq > 2) {
      expanded.push(tok.slice(0, eq), tok.slice(eq + 1));
    } else {
      expanded.push(tok);
    }
  }

  // Step 2: walk tokens. Positionals stay in order; flag pairs are
  // collected, then sorted, then re-emitted after the positionals.
  const positionals: string[] = [];
  type Pair = { flag: string; value: string | null; order: number };
  const pairs: Pair[] = [];
  let order = 0;
  for (let i = 0; i < expanded.length; i++) {
    const tok = expanded[i]!;
    if (tok.startsWith("--")) {
      const next = expanded[i + 1];
      if (next === undefined || next.startsWith("--")) {
        pairs.push({ flag: tok, value: null, order: order++ });
      } else {
        pairs.push({ flag: tok, value: next, order: order++ });
        i++;
      }
    } else {
      positionals.push(tok);
    }
  }

  // Stable sort by flag name; preserve original order within same flag
  // (handles --include a --include b correctly).
  pairs.sort((a, b) => {
    if (a.flag !== b.flag) return a.flag < b.flag ? -1 : 1;
    return a.order - b.order;
  });

  const out = [...positionals];
  for (const p of pairs) {
    out.push(p.flag);
    if (p.value !== null) out.push(p.value);
  }
  return out;
}

const SLUG_UNSAFE = /[^a-zA-Z0-9._-]/g;

/**
 * Build a filesystem-safe slug from the first ~5 argv tokens. Aim is
 * human readability when browsing the cassette dir; uniqueness is
 * provided by the hash.
 */
export function slugify(argv: string[]): string {
  return argv
    .slice(0, 5)
    .map((a) => a.replace(SLUG_UNSAFE, ""))
    .filter((a) => a.length > 0)
    .join("-")
    .replace(/-{3,}/g, "--");
}

/**
 * Compute the cassette key for a CLI invocation. The hash includes
 * normalized argv, stdin, and env vars from the CLI's whitelist. The
 * slug is human-readable; the hash disambiguates collisions.
 */
export function computeKey(opts: {
  cli: string;
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  envWhitelist: string[];
  normalizeArgs: ArgNormalization;
}): FixtureKey {
  const normArgv = normalizeArgv(opts.argv, opts.normalizeArgs);
  const envSubset: Record<string, string> = {};
  for (const k of opts.envWhitelist.slice().sort()) {
    if (opts.env[k] !== undefined) envSubset[k] = opts.env[k];
  }
  const payload = JSON.stringify({
    cli: opts.cli,
    argv: normArgv,
    stdin: opts.stdin,
    env: envSubset,
  });
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 8);
  return { cli: opts.cli, slug: slugify(normArgv), hash };
}
