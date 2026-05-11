// eval-mocks/src/types.ts
//
// Shared types across the dispatcher, store, and anonymizer.
// Schema version is embedded in cassettes so future migrations are detectable.

export const DISPATCHER_SCHEMA_VERSION = "1.0.0" as const;

export type MockMode = "replay" | "record" | "record-missing";

export interface FixtureKey {
  cli: string;       // e.g. "slack-pp-cli"
  slug: string;      // e.g. "channels-list--agent" (filesystem-safe)
  hash: string;      // 8-char hex of normalized request
}

export interface CassetteRequest {
  cli: string;
  argv: string[];               // normalized argv (sorted flag pairs)
  argv_raw: string[];           // original argv as received
  stdin: string;                // raw stdin captured at record time
  env_subset: Record<string, string>; // only env vars from CLI's whitelist
}

export interface CassetteResponse {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface CassetteMeta {
  recorded_at: string;          // ISO8601 UTC
  cli_version: string;          // captured via `<cli> --version`
  dispatcher_version: string;   // matches DISPATCHER_SCHEMA_VERSION
}

export interface Cassette {
  request: CassetteRequest;
  response: CassetteResponse;
  meta: CassetteMeta;
}

export interface AuditEntry {
  jsonpath: string;             // e.g. "$.users[0].email"
  rule: string;                 // e.g. "global:email-pattern" or "cli:slack-pp-cli:user.id"
  original_hash: string;        // hash(real_value) — verifies which fake was used
  replacement: string;          // e.g. "user_a4b9c2d1"
}

export interface AuditLog {
  cassette: string;             // sibling cassette filename, e.g. "channels-list--agent__a4b9c2d1.json"
  redactions: AuditEntry[];
  notes: string[];              // e.g. "skipped: non-JSON output"
}

export interface GlobalPattern {
  name: string;               // human label, e.g. "email"
  regex: string;              // compiled with default flags
  strategy: "hash" | "redact";
  prefix: string;             // e.g. "email_" → "email_a4b9c2d1"
}

export interface GlobalRules {
  patterns: GlobalPattern[];
  field_names: string[];      // case-insensitive field names always scrubbed
}

export interface CliField {
  jsonpath: string;           // simple JSON-path subset (see anonymizer.ts)
  strategy: "hash" | "redact";
  prefix?: string;
}

export interface CliRules {
  fields: CliField[];
  env_whitelist: string[];    // env vars that affect output
  arg_normalization: "flag-order-insensitive" | "preserve-order";
  doctor_emits_prose: boolean; // if true, the CLI's `doctor` subcommand emits prose, not JSON
}

export interface AnonymizerRules {
  global: GlobalRules;
  per_cli: Record<string, CliRules>;
}

export interface AnonymizeResult {
  output: string;               // possibly-anonymized stdout
  redactions: AuditEntry[];
  notes: string[];
}
