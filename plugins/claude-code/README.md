# jev-router plugin for Claude Code

Sensors only. Claude Code hooks cannot change the model, so the switch happens in the local relay; this plugin sends the relay what its hooks know: tool successes and failures, compaction, subagent starts, API failures, and prompt submissions.

```bash
claude plugin marketplace add FrancoisChastel/jev-router
claude plugin install jev-router@jev-router
```

Then point Claude Code at the relay, either with `npx @french-castle/jev-router setup --agent claude-code` or by hand:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4141
export ANTHROPIC_AUTH_TOKEN=jev-router
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL=claude-code/auto
export CLAUDE_CODE_GATEWAY_HINT_HEADERS=1
```

The hooks post to `http://127.0.0.1:4141/hooks/claude-code` with a two-second timeout, so a stopped relay costs at most that per event and never blocks a tool. `/jev-router:status` shows recent decisions.
