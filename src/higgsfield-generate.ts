import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export type MediaType = "image" | "video";

export type GeneratePlan = {
  model: string;
  enhanced_prompt: string;
  extra_args: string[];
};

export type SubmitResult = {
  job_id: string;
  status: string;
  raw: unknown;
};

export type JobStatus = {
  job_id: string;
  status: string;
  urls: string[];
  raw: unknown;
};

export class HiggsfieldError extends Error {
  constructor(
    message: string,
    readonly code:
      | "skill-missing"
      | "plan-empty"
      | "cli-non-zero"
      | "cli-malformed-json"
      | "cli-spawn-error"
      | "cli-timeout"
      | "anthropic-error",
    readonly details?: {
      exitCode?: number | null;
      stderr?: string;
      stdout?: string;
    },
  ) {
    super(message);
    this.name = "HiggsfieldError";
  }
}

const SKILL_DIR =
  process.env.HIGGSFIELD_SKILL_DIR ?? "/app/higgsfield-skills/generate";

let cachedSkill: string | null = null;

export async function loadSkill(): Promise<string> {
  if (cachedSkill !== null) return cachedSkill;
  const skillPath = path.join(SKILL_DIR, "SKILL.md");
  try {
    cachedSkill = await readFile(skillPath, "utf8");
    return cachedSkill;
  } catch (err) {
    throw new HiggsfieldError(
      `higgsfield-generate SKILL.md missing at ${skillPath}: ${err instanceof Error ? err.message : String(err)}`,
      "skill-missing",
    );
  }
}

const ENHANCE_TOOL_NAME = "submit_higgsfield_plan";

const ENHANCE_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    model: {
      type: "string",
      description:
        "The higgsfield model job_set_type to use, e.g. 'gpt_image_2', 'seedance_2_0', 'nano_banana_2'. Pick per the SKILL.md routing rules.",
    },
    enhanced_prompt: {
      type: "string",
      description:
        "The user's raw prompt rewritten per SKILL.md prompt-engineering guidance for the chosen model. Keep technical args (aspect ratios, durations) out of this field — put those in extra_args.",
    },
    extra_args: {
      type: "array",
      items: { type: "string" },
      description:
        "Additional CLI args/values to append after --prompt, e.g. ['--aspect_ratio', '16:9', '--duration', '8']. Omit --image (caller passes it separately) and --wait/--json (the worker manages those). Keep this empty unless SKILL.md prescribes a flag for the chosen model.",
    },
  },
  required: ["model", "enhanced_prompt", "extra_args"],
};

export async function enhancePrompt(opts: {
  anthropic: Anthropic;
  mediaType: MediaType;
  userPrompt: string;
  imageUploadId?: string;
  model?: string;
  enhancerModel: string;
}): Promise<GeneratePlan> {
  const skill = await loadSkill();
  const directive =
    opts.mediaType === "image"
      ? "The caller wants an IMAGE. Pick an image model only. Do NOT return a video model."
      : "The caller wants a VIDEO. Pick a video model only. Do NOT return an image model.";
  const imageNote = opts.imageUploadId
    ? `The caller has already uploaded an input ${opts.mediaType === "video" ? "image (for image-to-video)" : "reference image"} with upload_id: ${opts.imageUploadId}. The worker will append --image ${opts.imageUploadId} for you — do NOT include it in extra_args.`
    : "";
  const modelOverride = opts.model
    ? `The caller has explicitly requested model "${opts.model}". Use exactly this model — do not substitute, even if SKILL.md would route differently.`
    : "";

  const userMessage = [
    directive,
    modelOverride,
    imageNote,
    "User prompt:",
    opts.userPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  let response;
  try {
    response = await opts.anthropic.messages.create({
      model: opts.enhancerModel,
      max_tokens: 1024,
      system: skill,
      tools: [
        {
          name: ENHANCE_TOOL_NAME,
          description:
            "Return the higgsfield model + rewritten prompt + extra CLI args to use for this generation.",
          input_schema: ENHANCE_TOOL_SCHEMA as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: ENHANCE_TOOL_NAME },
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new HiggsfieldError(
        `anthropic enhancer call failed (${err.status}): ${err.message}`,
        "anthropic-error",
      );
    }
    throw err;
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new HiggsfieldError(
      `anthropic returned no tool_use; stop_reason=${response.stop_reason}`,
      "plan-empty",
    );
  }
  const input = toolUse.input as Partial<GeneratePlan>;
  if (
    typeof input.model !== "string" ||
    typeof input.enhanced_prompt !== "string" ||
    !Array.isArray(input.extra_args)
  ) {
    throw new HiggsfieldError(
      `enhancer returned malformed plan: ${JSON.stringify(input).slice(0, 300)}`,
      "plan-empty",
    );
  }
  return {
    model: input.model,
    enhanced_prompt: input.enhanced_prompt,
    extra_args: input.extra_args.filter(
      (s): s is string => typeof s === "string",
    ),
  };
}

function runHf(
  args: string[],
  opts: { timeoutSeconds?: number } = {},
): Promise<unknown> {
  const timeoutSeconds = opts.timeoutSeconds ?? 30;
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("higgsfield", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutSeconds * 1000,
      });
    } catch (err) {
      reject(
        new HiggsfieldError(
          `failed to spawn higgsfield: ${err instanceof Error ? err.message : String(err)}`,
          "cli-spawn-error",
        ),
      );
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on("error", (err) => {
      reject(
        new HiggsfieldError(
          `higgsfield process error: ${err.message}`,
          "cli-spawn-error",
        ),
      );
    });
    proc.on("close", (code, signal) => {
      if (signal === "SIGTERM") {
        reject(
          new HiggsfieldError(
            `higgsfield timed out after ${timeoutSeconds}s`,
            "cli-timeout",
            { exitCode: code, stderr: stderr.slice(0, 500) },
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new HiggsfieldError(
            `higgsfield exited with code ${code}: ${stderr.slice(0, 500)}`,
            "cli-non-zero",
            { exitCode: code, stderr: stderr.slice(0, 500) },
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(
          new HiggsfieldError(
            `failed to parse higgsfield JSON: ${err instanceof Error ? err.message : String(err)} — stdout: ${stdout.slice(0, 300)}`,
            "cli-malformed-json",
            { stdout: stdout.slice(0, 500) },
          ),
        );
      }
    });
  });
}

export async function submitJob(opts: {
  plan: GeneratePlan;
  imageUploadId?: string;
}): Promise<SubmitResult> {
  const args = ["generate", "create", opts.plan.model, "--json"];
  args.push("--prompt", opts.plan.enhanced_prompt);
  if (opts.imageUploadId) args.push("--image", opts.imageUploadId);
  for (const a of opts.plan.extra_args) args.push(a);
  const raw = await runHf(args, { timeoutSeconds: 60 });
  const job = extractJob(raw);
  return { job_id: job.id, status: job.status, raw };
}

export async function getJob(jobId: string): Promise<JobStatus> {
  const raw = await runHf(["generate", "get", jobId, "--json"], {
    timeoutSeconds: 30,
  });
  const job = extractJob(raw);
  return {
    job_id: job.id,
    status: job.status,
    urls: job.urls,
    raw,
  };
}

function extractJob(raw: unknown): {
  id: string;
  status: string;
  urls: string[];
} {
  if (!raw || typeof raw !== "object") {
    throw new HiggsfieldError(
      `higgsfield returned non-object: ${JSON.stringify(raw).slice(0, 200)}`,
      "cli-malformed-json",
    );
  }
  const obj = raw as Record<string, unknown>;
  // higgsfield returns either {id, status, jobs:[{url,...}]} or a nested
  // shape under .data; tolerate both.
  const data =
    obj.data && typeof obj.data === "object"
      ? (obj.data as Record<string, unknown>)
      : obj;
  const id = typeof data.id === "string" ? data.id : "";
  const status = typeof data.status === "string" ? data.status : "unknown";
  const urls = collectUrls(data);
  if (!id) {
    throw new HiggsfieldError(
      `higgsfield response missing id: ${JSON.stringify(raw).slice(0, 200)}`,
      "cli-malformed-json",
    );
  }
  return { id, status, urls };
}

function collectUrls(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//.test(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  const walk = (v: unknown): void => {
    if (!v) return;
    if (typeof v === "string") {
      push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(data.jobs);
  walk(data.results);
  walk(data.outputs);
  walk(data.url);
  walk(data.urls);
  return out;
}
