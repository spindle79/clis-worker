import type Anthropic from "@anthropic-ai/sdk";

export const DIVERSITY_SEEDS = [
  "Variation angle: punchy and concise — fewer words, more impact.",
  "Variation angle: vivid and specific — concrete nouns, named outcomes.",
  "Variation angle: provocative — challenge the reader's assumption.",
  "Variation angle: calm and authoritative — confident, declarative voice.",
  "Variation angle: data-led — anchor on a number, fact, or stat if plausible.",
];

export type Variation = {
  value: unknown;
  reasoning: string;
  label: string;
};

export type RunVariationsOpts = {
  prompt: string;
  system?: string;
  model: string;
  maxTokens: number;
  count: number;
  valueSchema: Record<string, unknown>;
};

export type RunVariationsResult =
  | {
      ok: true;
      variations: Variation[];
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      stopReason: string | null;
    }
  | {
      ok: false;
      error: "anthropic-error" | "no-tool-use" | "internal-error";
      message: string;
    };

type Outcome =
  | {
      ok: true;
      variation: Variation;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      stopReason: string | null;
    }
  | {
      ok: false;
      kind: "anthropic-error" | "no-tool-use" | "internal-error";
      message: string;
    };

export async function runVariations(
  anthropic: Anthropic,
  opts: RunVariationsOpts,
): Promise<RunVariationsResult> {
  const variationSchema = {
    type: "object" as const,
    properties: {
      value: opts.valueSchema,
      reasoning: {
        type: "string",
        maxLength: 280,
        description:
          "One short sentence: WHY this variation is good and what angle it's optimizing for.",
      },
      label: {
        type: "string",
        maxLength: 24,
        description:
          "Short label for this variant (e.g. 'punchy', 'vivid', 'provocative').",
      },
    },
    required: ["value", "reasoning", "label"],
    additionalProperties: false,
  };

  const seeds = DIVERSITY_SEEDS.slice(0, opts.count);

  const calls = seeds.map(async (seed): Promise<Outcome> => {
    const systemPrompt = opts.system ? `${opts.system}\n\n${seed}` : seed;
    try {
      const response = await anthropic.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: systemPrompt,
        tools: [
          {
            name: "submit_variation",
            description:
              "Submit one variant value with reasoning and a short label.",
            input_schema: variationSchema as never,
          },
        ],
        tool_choice: { type: "tool", name: "submit_variation" },
        messages: [{ role: "user", content: opts.prompt }],
      });
      const toolUse = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (!toolUse) {
        return {
          ok: false,
          kind: "no-tool-use",
          message: `stop_reason: ${response.stop_reason}`,
        };
      }
      return {
        ok: true,
        variation: toolUse.input as Variation,
        model: response.model,
        usage: response.usage,
        stopReason: response.stop_reason,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isApiError =
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        typeof (err as { status?: unknown }).status === "number";
      return {
        ok: false,
        kind: isApiError ? "anthropic-error" : "internal-error",
        message,
      };
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
    inputTokens += o.usage.input_tokens;
    outputTokens += o.usage.output_tokens;
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
