import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { AnonymizerRules, CliRules, GlobalRules } from "./types.js";

const DEFAULT_GLOBAL: GlobalRules = {
  patterns: [],
  field_names: [],
};

export const DEFAULT_CLI_RULES: CliRules = {
  fields: [],
  env_whitelist: [],
  arg_normalization: "flag-order-insensitive",
  doctor_emits_prose: false,
};

/**
 * Load anonymization rules from <fixtureDir>/.anonymize/. global.yaml is
 * optional (defaults to empty rules); each per-CLI file <cli-name>.yaml
 * defines that CLI's overrides. Files without a .yaml extension are
 * silently ignored.
 */
export function loadRules(fixtureDir: string): AnonymizerRules {
  const dir = path.join(fixtureDir, ".anonymize");
  if (!existsSync(dir)) {
    return { global: { ...DEFAULT_GLOBAL }, per_cli: {} };
  }

  const globalPath = path.join(dir, "global.yaml");
  let global: GlobalRules = { ...DEFAULT_GLOBAL };
  if (existsSync(globalPath)) {
    const parsed = yaml.load(readFileSync(globalPath, "utf8")) as Partial<GlobalRules> | null;
    if (parsed) {
      global = {
        patterns: parsed.patterns ?? [],
        field_names: parsed.field_names ?? [],
      };
    }
  }

  const per_cli: Record<string, CliRules> = {};
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml") || entry === "global.yaml") continue;
    const cli = entry.replace(/\.yaml$/, "");
    const parsed = yaml.load(readFileSync(path.join(dir, entry), "utf8")) as Partial<CliRules> | null;
    if (!parsed) continue;
    per_cli[cli] = {
      fields: parsed.fields ?? [],
      env_whitelist: parsed.env_whitelist ?? [],
      arg_normalization: parsed.arg_normalization ?? "flag-order-insensitive",
      doctor_emits_prose: parsed.doctor_emits_prose ?? false,
    };
  }

  return { global, per_cli };
}

export function getCliRules(rules: AnonymizerRules, cli: string): CliRules {
  return rules.per_cli[cli] ?? DEFAULT_CLI_RULES;
}
