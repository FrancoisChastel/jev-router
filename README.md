# jev-router

Harness-agnostic LLM router for agentic coding. It routes each turn to the cheapest model and reasoning effort that can finish the job, using Switchyard-style execution signals from tool results and TypeSafe's jev as a fast, calibrated judge.

Works inside Pi, Claude Code, Codex, and OpenCode. Routes through OpenRouter or Vercel AI Gateway. Measures itself with counterfactual cost accounting so you can see whether routing actually pays.

Status: design phase. See [DESIGN.md](./DESIGN.md).
