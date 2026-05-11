import { createHash } from "node:crypto";
import type { AuditEntry, GlobalPattern } from "./types.js";

/**
 * Stable hash → human prefix replacement. Same `value` always produces
 * the same replacement, which gives us reference integrity across all
 * cassettes for free (no shared identity-map needed).
 */
export function hashReplacement(value: string, prefix: string): string {
  const h = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${prefix}${h}`;
}

/**
 * Hash of just the original value, used in audit entries to verify
 * (post-hoc) which fake corresponds to which real value during review.
 * Storing the full original would defeat the anonymization.
 */
function originalHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Walk a string, applying every pattern's regex. Each match is replaced
 * with hash or redacted (literal "[redacted]"). Order: patterns applied
 * sequentially; inside a single pattern, all matches replaced.
 *
 * Returns the modified text and one AuditEntry per replacement made.
 */
export function applyPatterns(
  text: string,
  patterns: GlobalPattern[],
): { text: string; redactions: AuditEntry[] } {
  let out = text;
  const redactions: AuditEntry[] = [];

  for (const p of patterns) {
    const re = new RegExp(p.regex, "g");
    out = out.replace(re, (match) => {
      const replacement = p.strategy === "redact"
        ? "[redacted]"
        : hashReplacement(match, p.prefix);
      redactions.push({
        jsonpath: "(string-pattern)",
        rule: `global:${p.name}`,
        original_hash: originalHash(match),
        replacement,
      });
      return replacement;
    });
  }

  return { text: out, redactions };
}
