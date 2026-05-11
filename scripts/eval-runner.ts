import type { EvalPrompt } from "./eval-prompts.js";

export interface PromptResult {
  category: string;
  label: string;
  prompt: string;
  session_id?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  // Local-eval-only:
  tool_calls?: number;
  mock_misses?: number;
  // For debugging:
  raw_events?: any[];
}

/**
 * Send one prompt to the worker's /agent endpoint, parse the NDJSON
 * stream, and synthesize a PromptResult from the events.
 */
export async function runOnePrompt(
  workerUrl: string,
  prompt: EvalPrompt,
  apiKey: string,
): Promise<PromptResult> {
  const start = Date.now();
  const res = await fetch(`${workerUrl}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ prompt: prompt.prompt }),
  });

  if (!res.ok) {
    return {
      category: prompt.category,
      label: prompt.label,
      prompt: prompt.prompt,
      is_error: true,
      duration_ms: Date.now() - start,
      raw_events: [{ http_error: res.status, body: await res.text() }],
    };
  }

  const events: any[] = [];
  let toolCalls = 0;
  let mockMisses = 0;
  let resultEvent: any = null;

  const decoder = new TextDecoder();
  let buffer = "";
  const reader = res.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        events.push(evt);
        if (evt.type === "result") resultEvent = evt;
        // Count tool_use events from agent messages
        if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block.type === "tool_use") toolCalls++;
          }
        }
        // Count EVAL_MOCK_MISS occurrences in tool_result content
        if (evt.type === "user" && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block.type === "tool_result" && typeof block.content === "string"
                && block.content.includes("EVAL_MOCK_MISS")) {
              mockMisses++;
            }
            if (block.type === "tool_result" && Array.isArray(block.content)) {
              for (const sub of block.content) {
                if (sub.type === "text" && sub.text?.includes("EVAL_MOCK_MISS")) {
                  mockMisses++;
                }
              }
            }
          }
        }
      } catch {
        /* skip non-JSON lines */
      }
    }
  }

  return {
    category: prompt.category,
    label: prompt.label,
    prompt: prompt.prompt,
    session_id: resultEvent?.session_id,
    num_turns: resultEvent?.num_turns,
    duration_ms: resultEvent?.duration_ms ?? (Date.now() - start),
    total_cost_usd: resultEvent?.total_cost_usd,
    is_error: resultEvent?.is_error ?? !resultEvent,
    tool_calls: toolCalls,
    mock_misses: mockMisses,
    raw_events: events,
  };
}

/**
 * Run all prompts serially. Serial is critical: concurrent runs each
 * cache-miss the worker's system prompt and inflate baseline cost.
 */
export async function runAllPrompts(
  workerUrl: string,
  prompts: EvalPrompt[],
  apiKey: string,
  onProgress?: (idx: number, total: number, result: PromptResult) => void,
): Promise<PromptResult[]> {
  const out: PromptResult[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const r = await runOnePrompt(workerUrl, prompts[i]!, apiKey);
    out.push(r);
    onProgress?.(i + 1, prompts.length, r);
  }
  return out;
}
