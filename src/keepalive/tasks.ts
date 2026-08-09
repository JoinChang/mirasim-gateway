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
