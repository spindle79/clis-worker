import type {
  AnonymizerRules,
  AnonymizeResult,
  AuditEntry,
} from "./types.js";
import { applyPatterns, hashReplacement } from "./anonymizer-patterns.js";
import { getCliRules } from "./anonymizer-rules.js";
import { createHash } from "node:crypto";

const ANON_MARKER_RE = /^[a-z]+_[0-9a-f]{8}$/;

function isAlreadyAnonymized(value: string): boolean {
  return ANON_MARKER_RE.test(value) || value === "[redacted]";
}

function originalHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Tiny JSONPath subset used by per-CLI rules:
 *   $.foo           — top-level "foo"
 *   $.foo.bar       — chained
 *   $.foo[*].bar    — array-element step
 *   $..bar          — recursive descent finding any "bar"
 *
 * Anything more exotic is intentionally not supported; rules can be
 * decomposed into multiple paths instead.
 */
type Step =
  | { kind: "key"; name: string }
  | { kind: "any-array" }
  | { kind: "descend"; name: string };

function parsePath(path: string): Step[] {
  if (!path.startsWith("$")) {
    throw new Error(`anonymizer: jsonpath must start with $: ${path}`);
  }
  const rest = path.slice(1);
  const steps: Step[] = [];
  let i = 0;
  while (i < rest.length) {
    const c = rest[i];
    if (c === ".") {
      if (rest[i + 1] === ".") {
        // recursive descent: ..name
        const m = rest.slice(i + 2).match(/^([A-Za-z0-9_]+)/);
        if (!m) throw new Error(`anonymizer: bad descent in ${path}`);
        steps.push({ kind: "descend", name: m[1] });
        i += 2 + m[1].length;
      } else {
        const m = rest.slice(i + 1).match(/^([A-Za-z0-9_]+)/);
        if (!m) throw new Error(`anonymizer: bad key in ${path}`);
        steps.push({ kind: "key", name: m[1] });
        i += 1 + m[1].length;
      }
    } else if (c === "[" && rest[i + 1] === "*" && rest[i + 2] === "]") {
      steps.push({ kind: "any-array" });
      i += 3;
    } else {
      throw new Error(`anonymizer: unsupported jsonpath construct at ${i} in ${path}`);
    }
  }
  return steps;
}

/**
 * Walk steps over `obj`, calling `visit` with (parent, key) for every
 * value the path resolves to. parent[key] is mutable so visitors can
 * replace in place.
 */
function walk(
  obj: unknown,
  steps: Step[],
  visit: (parent: any, key: string | number) => void,
): void {
  if (steps.length === 0) return;
  const [step, ...rest] = steps;

  const recurse = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    walk(node, rest, visit);
  };

  if (step.kind === "key") {
    if (obj && typeof obj === "object" && !Array.isArray(obj) && step.name in (obj as object)) {
      if (rest.length === 0) {
        visit(obj as any, step.name);
      } else {
        recurse((obj as any)[step.name]);
      }
    }
  } else if (step.kind === "any-array") {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (rest.length === 0) visit(obj as any, i);
        else recurse((obj as any)[i]);
      }
    }
  } else if (step.kind === "descend") {
    // Find any occurrence of step.name anywhere in the tree.
    const stack: unknown[] = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === null || typeof cur !== "object") continue;
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      const o = cur as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k === step.name) {
          if (rest.length === 0) visit(o, k);
          else walk(o[k], rest, visit);
        }
        stack.push(o[k]);
      }
    }
  }
}

/**
 * Apply per-CLI field rules and global field_names to a parsed JSON tree.
 * Mutates `obj` in place; returns the audit entries.
 */
function applyJsonRules(
  obj: any,
  cli: string,
  rules: AnonymizerRules,
): AuditEntry[] {
  const cliRules = getCliRules(rules, cli);
  const audit: AuditEntry[] = [];

  // Per-CLI jsonpath rules
  for (const field of cliRules.fields) {
    const steps = parsePath(field.jsonpath);
    walk(obj, steps, (parent, key) => {
      const value = parent[key];
      if (typeof value !== "string") return;
      if (isAlreadyAnonymized(value)) return; // already anonymized
      const replacement = field.strategy === "redact"
        ? "[redacted]"
        : hashReplacement(value, field.prefix ?? "val_");
      parent[key] = replacement;
      audit.push({
        jsonpath: field.jsonpath,
        rule: `cli:${cli}:${field.jsonpath}`,
        original_hash: originalHash(value),
        replacement,
      });
    });
  }

  // Global field_names: walk every key of every object
  const globalNames = new Set(rules.global.field_names.map((n) => n.toLowerCase()));
  if (globalNames.size > 0) {
    const stack: { node: any; jp: string }[] = [{ node: obj, jp: "$" }];
    while (stack.length) {
      const { node, jp } = stack.pop()!;
      if (node === null || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          stack.push({ node: node[i], jp: `${jp}[${i}]` });
        }
        continue;
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (globalNames.has(k.toLowerCase()) && typeof v === "string" && !ANON_MARKER_RE.test(v)) {
          const replacement = hashReplacement(v, `${k.toLowerCase()}_`);
          node[k] = replacement;
          audit.push({
            jsonpath: `${jp}.${k}`,
            rule: `global:field:${k}`,
            original_hash: originalHash(v),
            replacement,
          });
        }
        stack.push({ node: v, jp: `${jp}.${k}` });
      }
    }
  }

  return audit;
}

/**
 * Apply global string patterns to every string value in a JSON tree.
 */
function applyJsonPatterns(
  obj: any,
  rules: AnonymizerRules,
): AuditEntry[] {
  const audit: AuditEntry[] = [];
  const stack: { node: any; jp: string }[] = [{ node: obj, jp: "$" }];
  while (stack.length) {
    const { node, jp } = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (typeof child === "string") {
          const r = applyPatterns(child, rules.global.patterns);
          if (r.redactions.length > 0) {
            node[i] = r.text;
            audit.push(...r.redactions.map((e) => ({ ...e, jsonpath: `${jp}[${i}]` })));
          }
        } else {
          stack.push({ node: child, jp: `${jp}[${i}]` });
        }
      }
      continue;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "string") {
        const r = applyPatterns(v, rules.global.patterns);
        if (r.redactions.length > 0) {
          node[k] = r.text;
          audit.push(...r.redactions.map((e) => ({ ...e, jsonpath: `${jp}.${k}` })));
        }
      } else {
        stack.push({ node: v, jp: `${jp}.${k}` });
      }
    }
  }
  return audit;
}

export function anonymize(opts: {
  cli: string;
  output: string;
  rules: AnonymizerRules;
  isJson: boolean;
}): AnonymizeResult {
  const notes: string[] = [];

  if (!opts.isJson) {
    const r = applyPatterns(opts.output, opts.rules.global.patterns);
    notes.push("non-JSON: pattern scan only");
    return { output: r.text, redactions: r.redactions, notes };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.output);
  } catch {
    const r = applyPatterns(opts.output, opts.rules.global.patterns);
    notes.push("declared JSON but failed to parse: pattern scan only");
    return { output: r.text, redactions: r.redactions, notes };
  }

  const audit: AuditEntry[] = [];
  audit.push(...applyJsonRules(parsed, opts.cli, opts.rules));
  audit.push(...applyJsonPatterns(parsed, opts.rules));

  return {
    output: JSON.stringify(parsed),
    redactions: audit,
    notes,
  };
}
