# Wolfpack Hooks

Most agent harnesses support **hooks** — shell commands the runtime fires around tool calls — to enforce pipeline discipline at the tool level. Skills tell agents what to do; hooks prevent them from doing what they shouldn't. Without hooks, a well-intentioned agent can still commit to main, `git add .`, or spin in a loop re-reading the same file.

The hooks below are plain shell scripts and are runtime-neutral: they read the tool call off `TOOL_INPUT` (a JSON blob your harness supplies) and exit non-zero to block. The wiring shown uses Claude Code's `settings.json` schema as a concrete example; adapt the config to whatever your harness's hook mechanism expects. The scripts themselves don't change.

## Included Hooks

### 1. Main Branch Guard (`main-branch-guard.sh`)

**Type:** PreToolUse (Edit, Write)

Blocks source-file edits when on `main` (or `master`). Agents must create a branch first. Non-source files (agent instructions, TODO.md, `.agents/`, `.claude/`, `.wolfpack/`, docs/, scripts/) pass through.

**Why it matters for Wolfpack:** The `/smoke` command walks through post-deploy tests. When the agent finds a bug, it may start fixing it before branching — landing the fix directly on main. This hook forces branching first. The smoke skill also creates a branch up front during setup, but the hook catches any agent that skips the skill instructions.

**Customize:** Edit the allowlist (case blocks) and source-file extensions to match your stack.

### 2. Git Add Guard (`git-add-guard.sh`)

**Type:** PreToolUse (Bash)

Blocks `git add .`, `git add -A`, and `git add --all`. Agents must stage files by name. This prevents accidentally committing secrets, build artifacts, or unrelated changes.

**Why it matters for Wolfpack:** Shepherd writes code across multiple files. Without this guard, a careless `git add .` can pull in .env files, IDE configs, or changes from a parallel hunt's worktree.

### 3. Spin Detector (`spin-detector.sh`)

**Type:** PreToolUse (Bash, Edit, Write, Read)

Tracks repeated operations per session. If the same command is run 3+ times, or the same file is touched 5+ times, the hook halts the tool call. Catches pathological loops where an agent retries a failing approach without changing strategy.

**Requires:** `reset-spin-state.sh` as a SessionStart hook to clear counters between sessions.

**Why it matters for Wolfpack:** Long pipeline sessions (Shepherd implementing a 10-file plan, Tracker running test suites) are where agents most often get stuck. The spin detector catches loops early before they consume the context window.

## Installation

### Step 1: Copy hook scripts

Put the scripts wherever your harness can reach them. Wolfpack's canonical layout uses `.agents/` (with `.claude/` as a compat symlink), so either path works:

```bash
mkdir -p /path/to/your/project/.agents/hooks
cp hooks/*.sh /path/to/your/project/.agents/hooks/
chmod +x /path/to/your/project/.agents/hooks/*.sh
```

### Step 2: Wire the hooks into your harness settings

If you don't have a settings file yet, copy the example:

```bash
cp hooks/settings.example.json /path/to/your/project/.agents/settings.json
```

Or merge the hooks section into your existing settings file. The example uses Claude Code's schema and references the scripts at `.claude/hooks/…` (resolved through the compat symlink); adjust the paths and the schema to match your harness. The key structure:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "bash .claude/hooks/git-add-guard.sh" },
          { "type": "command", "command": "bash .claude/hooks/spin-detector.sh" }
        ]
      },
      {
        "matcher": "Edit",
        "hooks": [
          { "type": "command", "command": "bash .claude/hooks/main-branch-guard.sh" },
          { "type": "command", "command": "bash .claude/hooks/spin-detector.sh" }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          { "type": "command", "command": "bash .claude/hooks/main-branch-guard.sh" },
          { "type": "command", "command": "bash .claude/hooks/spin-detector.sh" }
        ]
      },
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "bash .claude/hooks/spin-detector.sh" }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bash .claude/hooks/reset-spin-state.sh" }
        ]
      }
    ]
  }
}
```

### Step 3: Add state directory to .gitignore

```gitignore
.agents/state/
```

### Step 4: Test the hooks

```bash
# Should BLOCK (source file on main):
TOOL_INPUT='{"tool_input":{"file_path":"src/app.py"}}' bash .agents/hooks/main-branch-guard.sh

# Should PASS (docs on main):
TOOL_INPUT='{"tool_input":{"file_path":"TODO.md"}}' bash .agents/hooks/main-branch-guard.sh

# Should BLOCK (git add .):
TOOL_INPUT='{"tool_input":{"command":"git add ."}}' bash .agents/hooks/git-add-guard.sh
```

## Adding Project-Specific Hooks

Common additions beyond the included set:

### Prod deploy blocker (PreToolUse, Bash)
Block agents from running production deploy commands:
```bash
CMD=$(echo "$TOOL_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
echo "$CMD" | grep -qE 'deploy.*prod|prod.*deploy' && \
  echo "BLOCKED: Production deploys are user-only." >&2 && exit 1
exit 0
```

### Linter on save (PostToolUse, Edit|Write)
Run your linter after every file edit:
```bash
f=$(echo "$TOOL_INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[[ "$f" == *.py ]] && ruff check "$f" --fix --quiet 2>&1 || true
exit 0
```

### Test runner on stop (Stop)
Run tests before the agent finishes a task:
```bash
./scripts/run_tests.sh 2>&1 || true
exit 0
```

## How Hooks Interact with the Pipeline

| Phase | Relevant Hooks |
|-------|---------------|
| `/hunt` | Main branch guard (scaffolding writes to .wolfpack/, allowed) |
| `/shepherd` | Git add guard, spin detector, main branch guard (working in worktree, not on main — guard passes) |
| `/smoke` | Main branch guard (forces `fix/smoke-<slug>` branch before any edits) |
| `/merge` | Git add guard (merge uses `git merge`, not file edits — guard doesn't interfere) |
| All phases | Spin detector catches loops in any phase |
