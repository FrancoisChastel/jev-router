import type { Harness, ToolClass } from "../types";

export type ToolSemantics = Partial<Record<ToolClass, readonly string[]>>;

const BUILT_IN: Readonly<Record<Exclude<Harness, "unknown" | "hermes">, ToolSemantics>> = {
  "claude-code": {
    observe: [
      "Read",
      "Grep",
      "Glob",
      "LS",
      "WebFetch",
      "WebSearch",
      "NotebookRead",
      "TodoRead",
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
    ],
    mutate: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    plan: ["TodoWrite", "Task", "Agent", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate"],
    shell: ["Bash", "BashOutput", "KillShell"],
  },
  codex: {
    observe: ["read_file", "list_dir", "grep_files", "web_search", "view_image"],
    mutate: ["apply_patch", "write_file"],
    plan: ["update_plan"],
    shell: ["shell", "exec_command", "write_stdin", "container.exec"],
  },
  pi: {
    observe: ["read", "grep", "find", "ls", "fetch", "web_search"],
    mutate: ["edit", "write"],
    plan: ["plan", "todo"],
    shell: ["bash"],
  },
  opencode: {
    observe: ["read", "grep", "glob", "list", "webfetch", "websearch", "codesearch"],
    mutate: ["edit", "write", "patch", "multiedit", "apply_patch"],
    plan: ["todowrite", "todoread", "task", "plan"],
    shell: ["bash"],
  },
  // Names from Cursor agent system prompts published by the community (2025-2026); Cursor does not document its
  // wire tool names, so anything missing here falls through to the generic word heuristics below.
  cursor: {
    observe: [
      "read_file",
      "list_dir",
      "codebase_search",
      "grep_search",
      "grep",
      "file_search",
      "glob_file_search",
      "web_search",
      "fetch_rules",
      "read_lints",
    ],
    mutate: ["edit_file", "search_replace", "write", "delete_file", "reapply", "edit_notebook"],
    plan: ["todo_write"],
    shell: ["run_terminal_cmd"],
  },
};

const GENERIC: readonly (readonly [ToolClass, ReadonlySet<string>])[] = [
  ["plan", new Set(["plan", "todo", "task", "tasks"])],
  [
    "mutate",
    new Set(["edit", "write", "patch", "create", "delete", "remove", "update", "apply", "send", "insert", "upload", "commit", "push"]),
  ],
  ["shell", new Set(["bash", "shell", "exec", "execute", "run", "command", "terminal"])],
  ["observe", new Set(["read", "grep", "glob", "search", "list", "find", "fetch", "cat", "view", "get", "query", "lookup", "ls"])],
];

/** Split camelCase, snake_case, kebab-case, and MCP-style names into lowercase word tokens. */
function tokens(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function lookup(name: string, table: ToolSemantics | undefined): ToolClass | undefined {
  if (!table) return undefined;
  for (const [cls, names] of Object.entries(table) as [ToolClass, readonly string[] | undefined][]) {
    if (names?.includes(name)) return cls;
  }
  return undefined;
}

/** Classify a tool name into an observe / mutate / plan / new / shell / other bucket. */
export function classifyTool(name: string, harness: Harness, overrides?: ToolSemantics): ToolClass {
  const fromOverride = lookup(name, overrides);
  if (fromOverride) return fromOverride;
  const table = harness === "unknown" || harness === "hermes" ? undefined : BUILT_IN[harness];
  const fromBuiltIn = lookup(name, table);
  if (fromBuiltIn) return fromBuiltIn;
  const words = tokens(name);
  for (const [cls, vocab] of GENERIC) if (words.some((w) => vocab.has(w))) return cls;
  return "other";
}
