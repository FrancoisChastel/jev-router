/** Typed questions and answers in TypeSafe's System One shape, shared by every transport. */

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
}
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}
export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly legend?: Readonly<Record<string, string>>;
}
export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface JudgeRequest {
  /** Bounded dossier. Text, JSON object, or array of text. */
  readonly state: unknown;
  readonly questions: Readonly<Record<string, Question>>;
  /** Forwarded to transports that support session grouping. */
  readonly sessionId?: string;
}

export interface JudgeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

export interface JudgeResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: JudgeUsage;
  readonly latencyMs: number;
}

export interface EvaluateOptions {
  readonly signal?: AbortSignal;
}

export interface Judge {
  evaluate(request: JudgeRequest, opts?: EvaluateOptions): Promise<JudgeResult>;
}
