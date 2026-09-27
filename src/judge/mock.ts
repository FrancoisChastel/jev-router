import type { Answer, EvaluateOptions, Judge, JudgeRequest, JudgeResult } from "./types";

type AnswerSource = Readonly<Record<string, Answer>> | ((request: JudgeRequest) => Readonly<Record<string, Answer>>);

/** Fixture-driven judge for tests and offline replay. Records every request it receives. */
export class MockJudge implements Judge {
  private recorded: readonly JudgeRequest[] = [];

  constructor(
    private readonly source: AnswerSource,
    private readonly latencyMs = 0,
  ) {}

  get requests(): readonly JudgeRequest[] {
    return this.recorded;
  }

  async evaluate(request: JudgeRequest, _opts?: EvaluateOptions): Promise<JudgeResult> {
    this.recorded = [...this.recorded, request];
    const answers = typeof this.source === "function" ? this.source(request) : this.source;
    return { model: "mock", answers, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, latencyMs: this.latencyMs };
  }
}
