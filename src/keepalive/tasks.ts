import { execFileSync } from "node:child_process";
import fs from "node:fs";

export interface RepoContext {
  /** Models currently believed usable — work is only ever sent to these. */
  models: string[];
  gitLog: string;
  files: Record<string, string>;
}

export interface Task {
  label: string;
  model: string;
  maxTokens: number;
  prompt: string;
}

const MAX_MATERIAL = 6_000;
const MAX_OUTPUT = 600;

const clip = (s: string) => (s.length > MAX_MATERIAL ? `${s.slice(0, MAX_MATERIAL)}\n…[truncated]` : s);

/**
 * Turn real repository material into real work.
 *
 * These requests exist to keep the accounts exercised, but nothing about them is
 * synthetic: the inputs are this repo's actual code and history, and the answers
 * are worth reading. That is deliberate — traffic that is genuinely useful needs
 * no resemblance to anything, and the output justifies the tokens it costs.
 */
export function buildTasks(ctx: RepoContext): Task[] {
  if (!ctx.models.length) return [];
  const tasks: Task[] = [];
  const pick = (i: number) => ctx.models[i % ctx.models.length]!;

  if (ctx.gitLog.trim())
    tasks.push({
      label: "commit-digest",
      model: pick(tasks.length),
      maxTokens: MAX_OUTPUT,
      prompt:
        "Here is recent git history from a TypeScript gateway service. Summarise what changed and " +
        "flag anything that looks risky or unfinished. Be concise and specific.\n\n" +
        clip(ctx.gitLog),
    });

  const entries = Object.entries(ctx.files).filter(([, body]) => body.trim());
  const lenses = [
    ["review", "Review this file for correctness bugs. Report only defects you can justify, with line references."],
    ["tests", "What behaviour in this file is not covered by tests? List the specific cases worth adding."],
    ["clarity", "Point out anything in this file that would mislead a new reader, and say why."],
  ] as const;

  entries.forEach(([path, body], i) => {
    const [suffix, instruction] = lenses[i % lenses.length]!;
    tasks.push({
      label: `${suffix}:${path}`,
      model: pick(tasks.length),
      maxTokens: MAX_OUTPUT,
      prompt: `${instruction}\n\nFile: ${path}\n\n\`\`\`typescript\n${clip(body)}\n\`\`\``,
    });
  });

  return tasks;
}

/**
 * Where the material comes from. Injected so gathering is testable without a
 * filesystem or a git checkout — and so the container, which has neither git nor
 * this repo's history, degrades to file-only material instead of failing.
 */
export interface MaterialSource {
  /** Null when unreadable, rather than throwing. */
  readText(path: string): string | null;
  /** Recent history as text; empty when unavailable. */
  gitLog(): string;
}

/**
 * The files a keep-alive round reviews. Deciding this belongs with the module that
 * builds the tasks — it used to live in the CLI, so changing what the keep-alive
 * looked at meant editing a command.
 */
export const REVIEWED_FILES = [
  "src/models/classify.ts",
  "src/accounts/pool.ts",
  "src/models/prober.ts",
  "src/gateway/app.ts",
  "src/keepalive/summary.ts",
];

export function gatherMaterial(src: MaterialSource): { gitLog: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const path of REVIEWED_FILES) {
    const text = src.readText(path);
    if (text != null) files[path] = text;
  }
  return { gitLog: src.gitLog(), files };
}

/** Reads the working tree it is running in. */
export const nodeMaterialSource: MaterialSource = {
  readText: (path) => {
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  gitLog: () => {
    try {
      return execFileSync("git", ["log", "--oneline", "-12", "--stat"], { encoding: "utf8" });
    } catch {
      return "";
    }
  },
};
