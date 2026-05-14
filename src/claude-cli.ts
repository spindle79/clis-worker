import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

export type CallClaudeCliOpts = {
  userMessage: string;
  systemPrompt?: string;
  timeoutSeconds?: number;
};

export type CallClaudeCliResult = {
  result: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: "stop" | "length";
};

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing-binary"
      | "non-zero-exit"
      | "malformed-json"
      | "timeout"
      | "spawn-error",
    readonly details?: { exitCode?: number | null; stderr?: string; stdout?: string },
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

const MISSING_BINARY_MESSAGE =
  "claude CLI not found on $PATH. Install Claude Code (https://docs.claude.com/en/docs/agents-and-tools/claude-code) and run `claude` once interactively to authenticate.";

export async function whichClaude(
  binaryName = "claude",
  pathEnv = process.env.PATH,
): Promise<string | null> {
  if (!pathEnv) return null;
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = pathEnv.split(sep).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binaryName);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

type RawEnvelope = {
  result?: unknown;
  stop_reason?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  modelUsage?: Record<string, unknown>;
};

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function normalize(raw: RawEnvelope): CallClaudeCliResult {
  const result = typeof raw.result === "string" ? raw.result : "";
  const usage = raw.usage ?? {};
  const inputTokens =
    asNumber(usage.input_tokens) +
    asNumber(usage.cache_read_input_tokens) +
    asNumber(usage.cache_creation_input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const modelUsageKeys = raw.modelUsage ? Object.keys(raw.modelUsage) : [];
  const model = modelUsageKeys[0] ?? "claude-code-plan";
  const finishReason: "stop" | "length" =
    raw.stop_reason === "max_tokens" ? "length" : "stop";
  return { result, model, inputTokens, outputTokens, finishReason };
}

export async function callClaudeCli(
  opts: CallClaudeCliOpts,
): Promise<CallClaudeCliResult> {
  const timeoutSeconds = opts.timeoutSeconds ?? 600;

  const binary = await whichClaude();
  if (!binary) {
    throw new ClaudeCliError(MISSING_BINARY_MESSAGE, "missing-binary");
  }

  const args = ["-p", "--output-format", "json"];
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  // Strip ANTHROPIC_API_KEY from the subprocess env so claude always uses
  // CLAUDE_CODE_OAUTH_TOKEN (subscription billing). When both are present in
  // its env, claude prefers the API key — which silently puts you back on
  // pay-as-you-go.
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  return new Promise<CallClaudeCliResult>((resolve, reject) => {
    let proc;
    try {
      proc = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutSeconds * 1000,
        env: childEnv,
      });
    } catch (err) {
      reject(
        new ClaudeCliError(
          `failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`,
          "spawn-error",
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(
        new ClaudeCliError(
          `claude process error: ${err.message}`,
          "spawn-error",
        ),
      );
    });

    // Node's `timeout` option sends SIGTERM and emits 'close' with signal set.
    proc.on("close", (code, signal) => {
      if (signal === "SIGTERM" || timedOut) {
        reject(
          new ClaudeCliError(
            `claude timed out after ${timeoutSeconds}s`,
            "timeout",
            { exitCode: code, stderr: stderr.slice(0, 500) },
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new ClaudeCliError(
            `claude exited with code ${code}: ${stderr.slice(0, 500)}`,
            "non-zero-exit",
            { exitCode: code, stderr: stderr.slice(0, 500) },
          ),
        );
        return;
      }
      let parsed: RawEnvelope;
      try {
        parsed = JSON.parse(stdout) as RawEnvelope;
      } catch (err) {
        reject(
          new ClaudeCliError(
            `failed to parse claude JSON output: ${err instanceof Error ? err.message : String(err)} — stdout: ${stdout.slice(0, 500)}`,
            "malformed-json",
            { stdout: stdout.slice(0, 500) },
          ),
        );
        return;
      }
      resolve(normalize(parsed));
    });

    try {
      proc.stdin.end(opts.userMessage);
    } catch (err) {
      reject(
        new ClaudeCliError(
          `failed to write to claude stdin: ${err instanceof Error ? err.message : String(err)}`,
          "spawn-error",
        ),
      );
    }
  });
}
