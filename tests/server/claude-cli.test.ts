import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  return { ...actual, access: vi.fn() };
});

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
const accessMock = access as unknown as ReturnType<typeof vi.fn>;

class FakeProc extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  stdin: Writable;
  private writtenStdin = "";

  constructor() {
    super();
    const self = this;
    this.stdin = new Writable({
      write(chunk, _enc, cb) {
        self.writtenStdin += chunk.toString();
        cb();
      },
    });
  }

  emitStdout(s: string) {
    this.stdout.push(Buffer.from(s));
    this.stdout.push(null);
  }
  emitStderr(s: string) {
    this.stderr.push(Buffer.from(s));
    this.stderr.push(null);
  }
  finish(code: number | null, signal: NodeJS.Signals | null = null) {
    setImmediate(() => this.emit("close", code, signal));
  }
  getStdin() {
    return this.writtenStdin;
  }
}

beforeEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
  accessMock.mockReset();
  // Default: claude exists at the first PATH entry.
  accessMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadModule() {
  return import("../../src/claude-cli.js");
}

describe("callClaudeCli", () => {
  it("happy path: pipes prompt to stdin, parses envelope, normalizes fields", async () => {
    const { callClaudeCli } = await loadModule();
    const fake = new FakeProc();
    spawnMock.mockReturnValue(fake);

    const envelope = {
      result: "Hello there.",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
      modelUsage: { "claude-opus-4-7[1m]": { input_tokens: 17 } },
    };

    const promise = callClaudeCli({
      userMessage: "hi",
      systemPrompt: "you are terse",
    });

    fake.emitStdout(JSON.stringify(envelope));
    fake.finish(0);

    const result = await promise;
    expect(result).toEqual({
      result: "Hello there.",
      model: "claude-opus-4-7[1m]",
      inputTokens: 17, // 10 + 5 + 2
      outputTokens: 20,
      finishReason: "stop",
    });

    // Check spawn args
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--append-system-prompt",
      "you are terse",
    ]);
    // Stdin received the user message
    expect(fake.getStdin()).toBe("hi");
  });

  it("strips ANTHROPIC_API_KEY from the subprocess env so the subscription token wins", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    try {
      const { callClaudeCli } = await loadModule();
      const fake = new FakeProc();
      spawnMock.mockReturnValue(fake);

      const promise = callClaudeCli({ userMessage: "x" });
      fake.emitStdout(
        JSON.stringify({
          result: "ok",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: { "claude-haiku-4-5-20251001": {} },
        }),
      );
      fake.finish(0);
      await promise;

      const opts = spawnMock.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
      expect(opts.env).toBeDefined();
      expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("omits --append-system-prompt when no systemPrompt is provided", async () => {
    const { callClaudeCli } = await loadModule();
    const fake = new FakeProc();
    spawnMock.mockReturnValue(fake);

    const promise = callClaudeCli({ userMessage: "ping" });
    fake.emitStdout(
      JSON.stringify({
        result: "pong",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { "claude-haiku-4-5-20251001": {} },
      }),
    );
    fake.finish(0);

    await promise;
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(["-p", "--output-format", "json"]);
  });

  it("maps stop_reason=max_tokens → finishReason=length and falls back to claude-code-plan when modelUsage is missing", async () => {
    const { callClaudeCli } = await loadModule();
    const fake = new FakeProc();
    spawnMock.mockReturnValue(fake);

    const promise = callClaudeCli({ userMessage: "x" });
    fake.emitStdout(
      JSON.stringify({
        result: "truncated",
        stop_reason: "max_tokens",
        usage: { input_tokens: 1, output_tokens: 999 },
      }),
    );
    fake.finish(0);

    const result = await promise;
    expect(result.finishReason).toBe("length");
    expect(result.model).toBe("claude-code-plan");
    expect(result.inputTokens).toBe(1);
    expect(result.outputTokens).toBe(999);
  });

  it("non-zero exit: rejects with non-zero-exit code, exitCode and first 500 chars of stderr", async () => {
    const { callClaudeCli, ClaudeCliError } = await loadModule();
    const fake = new FakeProc();
    spawnMock.mockReturnValue(fake);

    const longErr = "boom! ".repeat(200); // > 500 chars
    const promise = callClaudeCli({ userMessage: "x" });
    fake.emitStderr(longErr);
    fake.finish(2);

    await expect(promise).rejects.toBeInstanceOf(ClaudeCliError);
    try {
      await promise;
    } catch (err) {
      const e = err as InstanceType<typeof ClaudeCliError>;
      expect(e.code).toBe("non-zero-exit");
      expect(e.details?.exitCode).toBe(2);
      expect(e.details?.stderr?.length).toBeLessThanOrEqual(500);
      expect(e.message).toContain("exited with code 2");
    }
  });

  it("malformed JSON: rejects with malformed-json and includes first 500 chars of stdout", async () => {
    const { callClaudeCli, ClaudeCliError } = await loadModule();
    const fake = new FakeProc();
    spawnMock.mockReturnValue(fake);

    const badJson = "this is not JSON at all { ";
    const promise = callClaudeCli({ userMessage: "x" });
    fake.emitStdout(badJson);
    fake.finish(0);

    await expect(promise).rejects.toBeInstanceOf(ClaudeCliError);
    try {
      await promise;
    } catch (err) {
      const e = err as InstanceType<typeof ClaudeCliError>;
      expect(e.code).toBe("malformed-json");
      expect(e.details?.stdout).toContain("this is not JSON");
    }
  });

  it("missing binary: rejects with missing-binary and a docs pointer when whichClaude returns null", async () => {
    const { callClaudeCli, ClaudeCliError } = await loadModule();
    accessMock.mockRejectedValue(new Error("ENOENT"));
    spawnMock.mockImplementation(() => {
      throw new Error("spawn should not be called when binary is missing");
    });

    await expect(
      callClaudeCli({ userMessage: "x" }),
    ).rejects.toBeInstanceOf(ClaudeCliError);

    try {
      await callClaudeCli({ userMessage: "x" });
    } catch (err) {
      const e = err as InstanceType<typeof ClaudeCliError>;
      expect(e.code).toBe("missing-binary");
      expect(e.message).toContain("docs.claude.com");
      expect(e.message).toContain("authenticate");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("whichClaude", () => {
  it("returns the first PATH directory containing an executable claude", async () => {
    const { whichClaude } = await loadModule();
    accessMock.mockImplementation(async (p: string) => {
      if (p === "/usr/local/bin/claude") return undefined;
      throw new Error("ENOENT");
    });
    const found = await whichClaude("claude", "/opt/bin:/usr/local/bin:/usr/bin");
    expect(found).toBe("/usr/local/bin/claude");
  });

  it("returns null when no PATH directory contains claude", async () => {
    const { whichClaude } = await loadModule();
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const found = await whichClaude("claude", "/opt/bin:/usr/local/bin");
    expect(found).toBeNull();
  });
});
