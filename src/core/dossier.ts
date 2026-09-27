import type { NormalizedRequest } from "./types";

/** Hard caps on what leaves the process toward the judge. */
export const DOSSIER_LIMITS = {
  taskChars: 2000,
  intentChars: 400,
  maxTools: 40,
  toolNameChars: 64,
  maxToolEntries: 8,
  excerptChars: 200,
  totalChars: 12_000,
} as const;

export interface DossierTool {
  readonly name: string;
  readonly error: boolean;
  readonly excerpt?: string;
}

export interface Dossier {
  readonly harness: string;
  readonly task: string;
  readonly intent?: string;
  readonly tools: readonly string[];
  readonly recent_tools: readonly DossierTool[];
  readonly images: boolean;
}

export interface DossierOptions {
  /** Applied to every string before it enters the dossier. */
  readonly redact?: (s: string) => string;
}

const head = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const tail = (s: string, n: number): string => (s.length > n ? s.slice(-n) : s);

export function buildDossier(req: NormalizedRequest, opts: DossierOptions = {}): Dossier {
  const redact = opts.redact ?? ((s: string) => s);
  const ordered = [...req.toolOutcomes].reverse().sort((a, b) => Number(b.isError) - Number(a.isError));
  const recent = ordered.slice(0, DOSSIER_LIMITS.maxToolEntries).map((o): DossierTool => {
    const text = o.errorText ?? o.excerpt;
    return { name: redact(o.name), error: o.isError, ...(text ? { excerpt: redact(tail(text, DOSSIER_LIMITS.excerptChars)) } : {}) };
  });
  const intent = req.assistantIntentTail ? redact(tail(req.assistantIntentTail, DOSSIER_LIMITS.intentChars)) : undefined;
  let dossier: Dossier = {
    harness: req.harness,
    task: redact(head(req.lastUserText ?? "", DOSSIER_LIMITS.taskChars)),
    ...(intent ? { intent } : {}),
    tools: req.toolNames.slice(0, DOSSIER_LIMITS.maxTools).map((n) => redact(head(n, DOSSIER_LIMITS.toolNameChars))),
    recent_tools: recent,
    images: req.hasImages,
  };
  // Degrade toward the total cap: tool entries, then the tool list, then the intent, then the task.
  while (JSON.stringify(dossier).length > DOSSIER_LIMITS.totalChars) {
    if (dossier.recent_tools.length > 0) dossier = { ...dossier, recent_tools: dossier.recent_tools.slice(0, -1) };
    else if (dossier.tools.length > 0) dossier = { ...dossier, tools: [] };
    else if (dossier.intent !== undefined) {
      const { intent: _dropped, ...rest } = dossier;
      dossier = rest;
    } else if (dossier.task.length > 100) dossier = { ...dossier, task: head(dossier.task, Math.floor(dossier.task.length / 2)) };
    else break;
  }
  return dossier;
}
