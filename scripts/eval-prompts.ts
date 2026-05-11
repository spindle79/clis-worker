import { readFileSync, existsSync } from "node:fs";

export interface EvalPrompt {
  category: string;
  label: string;
  prompt: string;
}

export interface FilterOpts {
  include?: string[];      // case-insensitive label substring match
  exclude?: string[];      // case-insensitive label substring match
  categories?: string[];   // exact category match
}

/**
 * Load prompts from a JSON file. Throws with a helpful error if the file
 * doesn't exist or doesn't contain an array of valid prompts.
 */
export function loadPrompts(file: string): EvalPrompt[] {
  if (!existsSync(file)) {
    throw new Error(`prompts file not found: ${file}`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`expected an array, got ${typeof parsed}: ${file}`);
  }
  for (const p of parsed) {
    if (!p.category || !p.label || !p.prompt) {
      throw new Error(`prompt missing required field (category/label/prompt): ${JSON.stringify(p)}`);
    }
  }
  return parsed as EvalPrompt[];
}

export function filterPrompts(prompts: EvalPrompt[], opts: FilterOpts): EvalPrompt[] {
  const inc = (opts.include ?? []).map((s) => s.toLowerCase());
  const exc = (opts.exclude ?? []).map((s) => s.toLowerCase());
  const cats = new Set(opts.categories ?? []);
  return prompts.filter((p) => {
    const label = p.label.toLowerCase();
    if (cats.size > 0 && !cats.has(p.category)) return false;
    if (inc.length > 0 && !inc.some((s) => label.includes(s))) return false;
    if (exc.some((s) => label.includes(s))) return false;
    return true;
  });
}
