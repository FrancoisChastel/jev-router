---
description: Show the last jev-router decisions for this machine
allowed-tools: Bash(tail:*), Bash(curl:*)
---

Run `curl -s http://127.0.0.1:4141/healthz` to check that the jev-router relay is up, then run `tail -n 10 ~/.jev-router/decisions.jsonl`.

Summarize in a short table: time, candidate, model, effort, source, and the first reason. If the relay is down, say so and suggest `jev-router up`. Do not paste raw JSON.
