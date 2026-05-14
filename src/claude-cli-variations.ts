import { callClaudeCli, ClaudeCliError } from "./claude-cli.js";
import { DIVERSITY_SEEDS, type Variation } from "./variations.js";

export type RunClaudeCliVariationsOpts = {
  prompt: string;
  system?: string;
  count: number;
  valueSchema: Record<string, unknown>;
  timeoutSeconds?: number;
};

export type RunClaudeCliVariationsResult =
  | {
      ok: true;
      variations: Variation[];
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      stopReason: string | null;
    }
  | {
      ok: false;
      error: "claude-cli-error" | "no-parseable-json" | "internal-error";
      message: string;
    };

type Outcome =
  | {
      ok: true;
      variation: Variation;
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
    }
  | {
      ok: false;
      kind: "claude-cli-error" | "no-parseable-json" | "internal-error";
      message: string;
    };

export function buildVariationSystemPrompt(
  userSystem: string | undefined,
  seed: string,
  valueSchema: Record<string, unknown>,
): string {
  const parts: string[] = [];
  if (userSystem) parts.push(userSystem);
  parts.push(seed);
  parts.push(
    [
      "Respond with ONLY a JSON object — no prose, no code fences, no commentary — matching this exact shape:",
      "{",
      '  "value": (matches the value schema below),',
      '  "reasoning": "one short sentence (max 280 chars) explaining the angle this variant takes",',
      '  "label": "short label, max 24 chars (e.g. \'punchy\', \'vivid\', \'provocative\')"',
      "}",
      "",
      "Value schema (the `value` field must conform):",
      JSON.stringify(valueSchema, null, 2),
      "",
      "Return ONLY the JSON object, nothing else.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  // Greedy match — outer-most {..} block. Sufficient for the
  // single-object output we asked the model for; not a full JSON parser.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
  }
  throw new Error("no parseable JSON object found");
}

function toVariation(parsed: unknown): Variation {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("parsed JSON is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (!("value" in obj)) {
    throw new Error("parsed JSON missing required `value` field");
  }
  const reasoning =
    typeof obj.reasoning === "string" ? obj.reasoning : "(no reasoning given)";
  const label = typeof obj.label === "string" ? obj.label : "unlabeled";
  return { value: obj.value, reasoning, label };
}

export async function runClaudeCliVariations(
  opts: RunClaudeCliVariationsOpts,
): Promise<RunClaudeCliVariationsResult> {
  const seeds = DIVERSITY_SEEDS.slice(0, opts.count);

  const calls = seeds.map(async (seed): Promise<Outcome> => {
    const systemPrompt = buildVariationSystemPrompt(
      opts.system,
      seed,
      opts.valueSchema,
    );
    try {
      const cliResult = await callClaudeCli({
        userMessage: opts.prompt,
        systemPrompt,
        timeoutSeconds: opts.timeoutSeconds,
      });
      let parsed: unknown;
      try {
        parsed = extractJsonObject(cliResult.result);
      } catch (err) {
        return {
          ok: false,
          kind: "no-parseable-json",
          message: `${err instanceof Error ? err.message : String(err)} — output: ${cliResult.result.slice(0, 500)}`,
        };
      }
      let variation: Variation;
      try {
        variation = toVariation(parsed);
      } catch (err) {
        return {
          ok: false,
          kind: "no-parseable-json",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        ok: true,
        variation,
        model: cliResult.model,
        inputTokens: cliResult.inputTokens,
        outputTokens: cliResult.outputTokens,
        stopReason: cliResult.finishReason,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind: "claude-cli-error" | "internal-error" =
        err instanceof ClaudeCliError ? "claude-cli-error" : "internal-error";
      return { ok: false, kind, message };
    }
  });

  const outcomes = await Promise.all(calls);
  const successes = outcomes.filter(
    (o): o is Extract<Outcome, { ok: true }> => o.ok,
  );

  if (successes.length === 0) {
    const firstFail = outcomes[0] as Extract<Outcome, { ok: false }>;
    return {
      ok: false,
      error: firstFail.kind,
      message: firstFail.message,
    };
  }

  const variations: Variation[] = outcomes.map((o) =>
    o.ok
      ? o.variation
      : {
          value: null,
          reasoning: `(generation failed: ${o.message})`,
          label: "error",
        },
  );

  let inputTokens = 0;
  let outputTokens = 0;
  for (const o of successes) {
    inputTokens += o.inputTokens;
    outputTokens += o.outputTokens;
  }

  const first = successes[0]!;
  return {
    ok: true,
    variations,
    model: first.model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    stopReason: first.stopReason,
  };
}
