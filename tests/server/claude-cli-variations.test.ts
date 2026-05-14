import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/claude-cli.js", () => ({
  callClaudeCli: vi.fn(),
  ClaudeCliError: class ClaudeCliError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly details?: unknown,
    ) {
      super(message);
      this.name = "ClaudeCliError";
    }
  },
  whichClaude: vi.fn().mockResolvedValue("/usr/local/bin/claude"),
}));

import { callClaudeCli, ClaudeCliError } from "../../src/claude-cli.js";
import {
  buildVariationSystemPrompt,
  extractJsonObject,
  runClaudeCliVariations,
} from "../../src/claude-cli-variations.js";
import { DIVERSITY_SEEDS } from "../../src/variations.js";

const callMock = callClaudeCli as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  callMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function ok(value: string, label: string, reasoning: string) {
  return {
    result: JSON.stringify({ value, label, reasoning }),
    model: "claude-haiku-4-5-20251001",
    inputTokens: 18000,
    outputTokens: 30,
    finishReason: "stop" as const,
  };
}

describe("extractJsonObject", () => {
  it("parses bare JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in ```json fences", () => {
    const wrapped = "```json\n{\"a\":2,\"b\":\"hi\"}\n```";
    expect(extractJsonObject(wrapped)).toEqual({ a: 2, b: "hi" });
  });

  it("parses JSON wrapped in plain ``` fences", () => {
    expect(extractJsonObject("```\n{\"x\":3}\n```")).toEqual({ x: 3 });
  });

  it("extracts the outermost {..} block when there is surrounding prose", () => {
    const text = 'Here is the variation:\n{"value":"hi","reasoning":"r","label":"l"}\nDone.';
    expect(extractJsonObject(text)).toEqual({
      value: "hi",
      reasoning: "r",
      label: "l",
    });
  });

  it("throws when no JSON object is recoverable", () => {
    expect(() => extractJsonObject("nope, no JSON here")).toThrow(
      /no parseable JSON/,
    );
  });
});

describe("buildVariationSystemPrompt", () => {
  it("includes the user system, the seed, and the JSON-only instruction with the value schema", () => {
    const prompt = buildVariationSystemPrompt(
      "You are a copywriter.",
      "Variation angle: punchy.",
      { type: "string", maxLength: 120 },
    );
    expect(prompt).toContain("You are a copywriter.");
    expect(prompt).toContain("Variation angle: punchy.");
    expect(prompt).toContain("Respond with ONLY a JSON object");
    expect(prompt).toContain('"maxLength": 120');
    expect(prompt).toContain('"value"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"label"');
  });

  it("works without a user system prompt", () => {
    const prompt = buildVariationSystemPrompt(
      undefined,
      "Variation angle: vivid.",
      { type: "string" },
    );
    expect(prompt).toContain("Variation angle: vivid.");
    expect(prompt).toContain("Respond with ONLY a JSON object");
  });
});

describe("runClaudeCliVariations", () => {
  it("returns N variations, sums usage, applies a distinct diversity seed to each system prompt", async () => {
    callMock
      .mockResolvedValueOnce(ok("Punchy.", "punchy", "Short and impactful."))
      .mockResolvedValueOnce(ok("Vivid.", "vivid", "Concrete nouns."))
      .mockResolvedValueOnce(
        ok("Provocative.", "provocative", "Challenges the reader."),
      );

    const result = await runClaudeCliVariations({
      prompt: "rewrite this title",
      system: "You are a copywriter.",
      count: 3,
      valueSchema: { type: "string", maxLength: 120 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variations.map((v) => v.label)).toEqual([
      "punchy",
      "vivid",
      "provocative",
    ]);
    expect(result.usage).toEqual({ input_tokens: 54000, output_tokens: 90 });
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.stopReason).toBe("stop");

    expect(callMock).toHaveBeenCalledTimes(3);
    const systemPrompts = callMock.mock.calls.map(
      (args) => (args[0] as { systemPrompt: string }).systemPrompt,
    );
    for (let i = 0; i < 3; i++) {
      expect(systemPrompts[i]).toContain("You are a copywriter.");
      expect(systemPrompts[i]).toContain(DIVERSITY_SEEDS[i]);
    }
    expect(new Set(systemPrompts).size).toBe(3);
  });

  it("substitutes a stub for individual failures and continues when others succeed", async () => {
    callMock
      .mockResolvedValueOnce(ok("first", "punchy", "good"))
      .mockRejectedValueOnce(
        new ClaudeCliError("non-zero exit", "non-zero-exit"),
      )
      .mockResolvedValueOnce(ok("third", "provocative", "good"));

    const result = await runClaudeCliVariations({
      prompt: "x",
      count: 3,
      valueSchema: { type: "string" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variations[0].label).toBe("punchy");
    expect(result.variations[1]).toEqual({
      value: null,
      reasoning: "(generation failed: non-zero exit)",
      label: "error",
    });
    expect(result.variations[2].label).toBe("provocative");
    expect(result.usage).toEqual({ input_tokens: 36000, output_tokens: 60 });
  });

  it("substitutes a stub when the model returns malformed JSON", async () => {
    callMock
      .mockResolvedValueOnce(ok("ok-one", "punchy", "good"))
      .mockResolvedValueOnce({
        result: "I refuse to comply.",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 18000,
        outputTokens: 5,
        finishReason: "stop" as const,
      });

    const result = await runClaudeCliVariations({
      prompt: "x",
      count: 2,
      valueSchema: { type: "string" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variations[0].label).toBe("punchy");
    expect(result.variations[1].label).toBe("error");
    expect(result.variations[1].reasoning).toMatch(/no parseable JSON/);
  });

  it("recovers JSON wrapped in ```json fences", async () => {
    callMock.mockResolvedValueOnce({
      result: '```json\n{"value":"wrapped","label":"vivid","reasoning":"good"}\n```',
      model: "claude-haiku-4-5-20251001",
      inputTokens: 18000,
      outputTokens: 30,
      finishReason: "stop" as const,
    });

    const result = await runClaudeCliVariations({
      prompt: "x",
      count: 1,
      valueSchema: { type: "string" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variations[0]).toEqual({
      value: "wrapped",
      label: "vivid",
      reasoning: "good",
    });
  });

  it("returns ok:false with claude-cli-error when every call throws ClaudeCliError", async () => {
    callMock
      .mockRejectedValueOnce(
        new ClaudeCliError("missing binary", "missing-binary"),
      )
      .mockRejectedValueOnce(new ClaudeCliError("timed out", "timeout"));

    const result = await runClaudeCliVariations({
      prompt: "x",
      count: 2,
      valueSchema: { type: "string" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("claude-cli-error");
    expect(result.message).toBe("missing binary");
  });
});

describe("POST /claude-variations (HTTP)", () => {
  it("validates count and returns 400 for out-of-range values", async () => {
    process.env.CLIS_WORKER_NO_AUTO_SERVE = "1";
    const { app } = await import("../../src/server.js");

    const res = await app.request("/claude-variations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "rewrite",
        count: 99,
        responseSchema: {
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid-count");
  });

  it("returns 400 when responseSchema.schema.properties.value is missing", async () => {
    process.env.CLIS_WORKER_NO_AUTO_SERVE = "1";
    const { app } = await import("../../src/server.js");

    const res = await app.request("/claude-variations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "rewrite",
        responseSchema: {
          schema: { type: "object", properties: {} },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid-schema");
  });

  it("returns 400 when prompt is missing", async () => {
    process.env.CLIS_WORKER_NO_AUTO_SERVE = "1";
    const { app } = await import("../../src/server.js");

    const res = await app.request("/claude-variations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });

    expect(res.status).toBe(400);
  });
});
