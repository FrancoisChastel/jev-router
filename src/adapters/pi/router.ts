import { type Concluded, plan } from "../../core/decide";
import type { Policy } from "../../core/policy/types";
import { type ApplyOutcome, buildDecisionRecord, type DecisionRecord, type JudgeTrace } from "../../core/record";
import { emptySession } from "../../core/session";
import { scoreStage } from "../../core/signals/stage";
import type { Decision, Effort, NormalizedRequest, SessionState, ToolOutcome } from "../../core/types";
import type { Judge } from "../../judge/types";

export interface PiModelRef {
  readonly provider: string;
  readonly id: string;
}
export interface PiToolResult {
  readonly toolName: string;
  readonly isError: boolean;
  readonly text?: string;
}
export type PiModelSelectSource = "set" | "cycle" | "restore";

/** Everything the router needs from Pi, injected so the loop is testable without the harness. */
export interface PiRouterDeps<TModel extends PiModelRef = PiModelRef> {
  readonly policy: Policy;
  readonly policyId: string;
  readonly judge: Judge | undefined;
  findModel(provider: string, id: string): TModel | undefined;
  setModel(model: TModel): Promise<boolean>;
  setThinkingLevel(level: Effort): void;
  currentModel(): TModel | undefined;
  getActiveTools(): readonly string[];
  getContextTokens(): number | null;
  notify(message: string, level: "info" | "warning" | "error"): void;
  status(text: string | undefined): void;
  log(record: DecisionRecord): void;
  now(): number;
  randomId(): string;
}

const DEFAULT_PI_PROVIDER: Readonly<Record<string, string>> = { openrouter: "openrouter", vercel: "vercel-ai-gateway" };
const EXCERPT_TAIL = 200;
const INTENT_TAIL = 400;
const CHARS_PER_TOKEN = 4;

const tail = (s: string, n: number): string => (s.length > n ? s.slice(-n) : s);

/**
 * In-process routing loop for Pi. Holds the per-session state that the pure core cannot,
 * serializes routing so decisions never interleave, and fails open on every error.
 */
export class PiRouter<TModel extends PiModelRef = PiModelRef> {
  private session: SessionState = emptySession();
  private sessionKey = "";
  private enabled = true;
  private paused = false;
  private ownSwitch = false;
  private pendingCompaction = false;
  private intentTail: string | undefined;
  private lastTokens: number | undefined;
  private lastDecision: Decision | undefined;
  private lastApplyError: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PiRouterDeps<TModel>) {}

  get isActive(): boolean {
    return this.enabled && !this.paused;
  }

  onSessionStart(_reason: string): void {
    this.session = emptySession();
    this.sessionKey = this.deps.randomId();
    this.paused = false;
    this.pendingCompaction = false;
    this.intentTail = undefined;
    this.lastTokens = undefined;
    this.lastDecision = undefined;
    this.deps.status(this.statusText());
  }

  onBeforeAgentStart(event: { readonly prompt: string; readonly images?: readonly unknown[] }): Promise<void> {
    if (!this.isActive) return Promise.resolve();
    const request = this.request({
      isNewUserTurn: true,
      lastUserText: event.prompt,
      hasImages: (event.images?.length ?? 0) > 0,
      toolOutcomes: [],
    });
    return this.enqueue(request);
  }

  onTurnEnd(event: { readonly assistantText?: string; readonly toolResults: readonly PiToolResult[] }): Promise<void> {
    if (event.assistantText) this.intentTail = tail(event.assistantText, INTENT_TAIL);
    if (!this.isActive || event.toolResults.length === 0) return Promise.resolve();
    const toolOutcomes: ToolOutcome[] = event.toolResults.map((r) => ({
      name: r.toolName,
      isError: r.isError,
      ...(r.text ? (r.isError ? { errorText: tail(r.text, EXCERPT_TAIL) } : { excerpt: tail(r.text, EXCERPT_TAIL) }) : {}),
    }));
    return this.enqueue(this.request({ isNewUserTurn: false, hasImages: false, toolOutcomes }));
  }

  onSessionCompact(): void {
    this.pendingCompaction = true;
  }

  /** A model change we did not cause is a manual override: pause until the user resumes. */
  onModelSelect(event: { readonly model: PiModelRef; readonly source: PiModelSelectSource }): void {
    if (this.ownSwitch || event.source === "restore") return;
    if (!this.paused) {
      this.paused = true;
      this.deps.notify(
        `jev-router paused after manual model selection (${event.model.provider}/${event.model.id}). Run /jev-router on to resume.`,
        "info",
      );
    }
    this.deps.status(this.statusText());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.paused = false;
    this.deps.status(this.statusText());
  }

  statusText(): string {
    if (!this.enabled) return "jev-router off";
    if (this.paused) return "jev-router paused (manual model)";
    const d = this.lastDecision;
    if (!d) return "jev-router ready";
    return `jev-router ${d.candidate}${d.effort ? ` · ${d.effort}` : ""} · ${d.source}`;
  }

  private request(
    part: Pick<NormalizedRequest, "isNewUserTurn" | "hasImages" | "toolOutcomes"> & { readonly lastUserText?: string },
  ): NormalizedRequest {
    const current = this.deps.currentModel();
    const reported = this.deps.getContextTokens();
    if (reported !== null && reported > 0) this.lastTokens = reported;
    const estimated = this.lastTokens ?? Math.ceil((part.lastUserText?.length ?? 0) / CHARS_PER_TOKEN);
    // The compaction flag is consumed here, at construction, so an in-flight request cannot clear it.
    const compacted = this.pendingCompaction;
    this.pendingCompaction = false;
    return {
      harness: "pi",
      sessionKey: this.sessionKey,
      requestedModel: current?.id ?? "auto",
      isNewUserTurn: part.isNewUserTurn,
      ...(part.lastUserText !== undefined ? { lastUserText: part.lastUserText } : {}),
      ...(this.intentTail ? { assistantIntentTail: this.intentTail } : {}),
      toolNames: this.deps.getActiveTools(),
      hasImages: part.hasImages,
      estimatedInputTokens: estimated,
      ...(compacted ? { contextCompacted: true } : {}),
      toolOutcomes: part.toolOutcomes,
    };
  }

  private enqueue(request: NormalizedRequest): Promise<void> {
    this.queue = this.queue
      .then(() => this.route(request))
      .catch((e: unknown) => {
        this.deps.notify(`jev-router: routing error, request left unchanged (${e instanceof Error ? e.message : String(e)})`, "warning");
      });
    return this.queue;
  }

  private async route(request: NormalizedRequest): Promise<void> {
    const { policy, policyId, judge } = this.deps;
    const outcome = plan({ request, session: this.session, policy, policyId });
    let concluded: Concluded;
    let judgeTrace: JudgeTrace | undefined;
    if (outcome.kind === "decision") {
      concluded = outcome;
    } else {
      const questions = Object.keys(outcome.judgeRequest.questions);
      if (!judge) {
        judgeTrace = { questions, error: "no_judge_configured" };
        concluded = outcome.conclude(null);
      } else {
        try {
          const res = await judge.evaluate(outcome.judgeRequest);
          judgeTrace = {
            questions,
            model: res.model,
            latencyMs: res.latencyMs,
            answers: res.answers,
            ...(res.usage.costUsd !== undefined ? { costUsd: res.usage.costUsd } : {}),
          };
          concluded = outcome.conclude(res.answers);
        } catch (e) {
          judgeTrace = { questions, error: e instanceof Error ? e.message : String(e) };
          concluded = outcome.conclude(null);
        }
      }
    }
    // Apply first; only a decision that took effect advances the session.
    const apply = await this.apply(concluded.decision);
    if (apply.ok) {
      this.session = concluded.session;
      this.lastDecision = concluded.decision;
      this.lastApplyError = undefined;
    } else if (apply.error !== this.lastApplyError) {
      // Report each distinct failure once rather than on every turn.
      this.lastApplyError = apply.error;
      this.deps.notify(`jev-router: decision not applied, session unchanged (${apply.error ?? "unknown error"})`, "warning");
    }
    const stage = scoreStage([...concluded.session.ledger], request.harness, {
      recentTurnWindow: policy.policies[policyId]?.recent_turn_window ?? 3,
    });
    this.deps.log(
      buildDecisionRecord({
        id: this.deps.randomId(),
        ts: this.deps.now(),
        request,
        session: concluded.session,
        decision: concluded.decision,
        stage,
        apply,
        ...(judgeTrace ? { judge: judgeTrace } : {}),
      }),
    );
    this.deps.status(this.statusText());
  }

  private async apply(decision: Decision): Promise<ApplyOutcome> {
    const ref = this.resolve(decision.candidate);
    if (!ref) return { ok: false, error: `model for candidate '${decision.candidate}' not found in Pi's registry` };
    try {
      const current = this.deps.currentModel();
      if (!current || current.provider !== ref.provider || current.id !== ref.id) {
        this.ownSwitch = true;
        try {
          const ok = await this.deps.setModel(ref);
          if (!ok) return { ok: false, error: `could not switch to ${ref.provider}/${ref.id}; is the provider configured?` };
        } finally {
          this.ownSwitch = false;
        }
      }
      if (decision.effort) this.deps.setThinkingLevel(decision.effort);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private resolve(candidateId: string): TModel | undefined {
    const candidate = this.deps.policy.candidates[candidateId];
    if (!candidate) return undefined;
    const via = candidate.via ?? "openrouter";
    const provider = candidate.pi?.provider ?? this.deps.policy.egress[via]?.pi_provider ?? DEFAULT_PI_PROVIDER[via] ?? via;
    const id = candidate.pi?.model ?? candidate.model;
    return this.deps.findModel(provider, id);
  }
}
