import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { DIVERSITY_SEEDS, runVariations } from "../../src/variations.js";

function mockToolUseResponse(
  value: string,
  label: string,
  reasoning: string,
  overrides: Partial<{
    input_tokens: number;
    output_tokens: number;
    model: string;
    stop_reason: string;
  }> = {},
) {
  return {
    content: [
      {
        type: "tool_use",
        id: `toolu_${label}`,
        name: "submit_variation",
        input: { value, reasoning, label },
      },
    ],
    usage: {
      input_tokens: overrides.input_tokens ?? 100,
      output_tokens: overrides.output_tokens ?? 50,
    },
    model: overrides.model ?? "claude-haiku-4-5-20251001",
    stop_reason: overrides.stop_reason ?? "tool_use",
  };
}

describe("runVariations", () => {
  it("returns N variations, sums usage, and applies a distinct diversity seed to each system prompt", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        mockToolUseResponse("Punchy headline.", "punchy", "Short and impactful."),
      )
      .mockResolvedValueOnce(
        mockToolUseResponse("Vivid headline.", "vivid", "Concrete nouns."),
      )
      .mockResolvedValueOnce(
        mockToolUseResponse(
          "Provocative headline.",
          "provocative",
          "Challenges the reader.",
        ),
      );
    const anthropic = { messages: { create } } as unknown as Anthropic;

    const result = await runVariations(anthropic, {
      prompt: "rewrite this title",
      system: "You are a copywriter.",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 512,
      count: 3,
      valueSchema: { type: "string", maxLength: 120 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.variations).toHaveLength(3);
    expect(result.variations.map((v) => v.label)).toEqual([
      "punchy",
      "vivid",
      "provocative",
    ]);
    expect(result.usage).toEqual({ input_tokens: 300, output_tokens: 150 });
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.stopReason).toBe("tool_use");

    expect(create).toHaveBeenCalledTimes(3);
    const systemPrompts = create.mock.calls.map(
      (args) => (args[0] as { system: string }).system,
    );
    for (let i = 0; i < 3; i++) {
      expect(systemPrompts[i]).toContain("You are a copywriter.");
      expect(systemPrompts[i]).toContain(DIVERSITY_SEEDS[i]);
    }
    // Each variation got a *different* seed
    expect(new Set(systemPrompts).size).toBe(3);
  });

  it("forces tool_choice on submit_variation and wraps the user's value schema with reasoning + label", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(mockToolUseResponse("ok", "punchy", "good"));
    const anthropic = { messages: { create } } as unknown as Anthropic;

    await runVariations(anthropic, {
      prompt: "x",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 512,
      count: 1,
      valueSchema: { type: "string", maxLength: 120 },
    });

    const call = create.mock.calls[0][0] as {
      tool_choice: unknown;
      tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
    };
    expect(call.tool_choice).toEqual({
      type: "tool",
      name: "submit_variation",
    });
    expect(call.tools[0].name).toBe("submit_variation");
    const schema = call.tools[0].input_schema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.value).toEqual({
      type: "string",
      maxLength: 120,
    });
    expect(schema.properties.reasoning.type).toBe("string");
    expect(schema.properties.label.type).toBe("string");
    expect(schema.required).toEqual(["value", "reasoning", "label"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("substitutes a stub for individual failures and continues when others succeed", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(mockToolUseResponse("first", "punchy", "good"))
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockResolvedValueOnce(
        mockToolUseResponse("third", "provocative", "good"),
      );
    const anthropic = { messages: { create } } as unknown as Anthropic;

    const result = await runVariations(anthropic, {
      prompt: "x",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 512,
      count: 3,
      valueSchema: { type: "string" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variations[0].label).toBe("punchy");
    expect(result.variations[1]).toEqual({
      value: null,
      reasoning: "(generation failed: rate limit)",
      label: "error",
    });
    expect(result.variations[2].label).toBe("provocative");
    expect(result.usage).toEqual({ input_tokens: 200, output_tokens: 100 });
  });

  it("returns ok:false with anthropic-error if every call failed with an APIError-shaped throw", async () => {
    const apiError = Object.assign(new Error("rate limit"), { status: 429 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError)
      .mockRejectedValueOnce(new Error("timeout"));
    const anthropic = { messages: { create } } as unknown as Anthropic;

    const result = await runVariations(anthropic, {
      prompt: "x",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 512,
      count: 2,
      valueSchema: { type: "string" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("anthropic-error");
    expect(result.message).toBe("rate limit");
  });

  it("flags no-tool-use when the model returns text instead of calling the tool", async () => {
    const create = vi.fn().mockResolvedValueOnce({
      content: [{ type: "text", text: "I refuse." }],
      usage: { input_tokens: 50, output_tokens: 10 },
      model: "claude-haiku-4-5-20251001",
      stop_reason: "end_turn",
    });
    const anthropic = { messages: { create } } as unknown as Anthropic;

    const result = await runVariations(anthropic, {
      prompt: "x",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 512,
      count: 1,
      valueSchema: { type: "string" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("no-tool-use");
  });
});

describe("POST /variations (HTTP)", () => {
  it("validates count and returns 400 for out-of-range values", async () => {
    // Prevent the worker module from booting an HTTP server on import
    process.env.CLIS_WORKER_NO_AUTO_SERVE = "1";
    const { app } = await import("../../src/server.js");

    const res = await app.request("/variations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "rewrite",
        count: 99,
        responseSchema: {
          name: "submit_value",
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid-count");
  });

  it("returns 400 when responseSchema is missing", async () => {
    process.env.CLIS_WORKER_NO_AUTO_SERVE = "1";
    const { app } = await import("../../src/server.js");

    const res = await app.request("/variations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "rewrite", count: 3 }),
    });

    expect(res.status).toBe(400);
  });
});
