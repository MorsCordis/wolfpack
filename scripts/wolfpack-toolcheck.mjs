#!/usr/bin/env node
// scripts/wolfpack-toolcheck.mjs — [06] AC1 preflight regression guard.
//
// Asserts the cross-model REVIEWER still holds its full CAPABLE toolset and has
// NOT silently re-boxed back to the 2-tool cage (read,grep) that blinded the
// cross-model reviewer in the run-#5 shakedown. Per docs/wolfpack-autonomy/06 § "Guard against
// regression": the `--enabled-tools read,grep` comma bug was a SILENT re-boxing —
// it filtered every tool out and nobody noticed until the reviewer hallucinated a
// whole review. So a preflight MUST assert the capable set before a run and FAIL
// LOUD (exit non-zero), not warn, if a model comes back re-boxed.
//
// TODO(de-fracture): the shim filename (podman-vibe.sh) and the
// VIBE_TOOLS_DEFAULT variable name are specific to one cross-model agent harness.
// Parameterize the shim path(s) + the tools-default variable name via wolfpack-config.md
// so this guard targets whichever harness shim a project actually ships.
//
// What it checks in scripts/podman-vibe.sh:
//   1. VIBE_TOOLS_DEFAULT lists the capable producer + git-read set
//      (read, grep, edit, write_file, bash) — not a 2-tool subset.
//   2. The tools are SPACE-separated (a comma re-introduces the single-bogus-token
//      bug: the for-loop would emit `--enabled-tools read,grep` = one tool named
//      "read,grep" that matches nothing → blind reviewer).
//   3. No legacy `--enabled-tools read,grep`-style comma-joined flag survives.
//   4. The flag array is built by REPEATING --enabled-tools per tool (argparse
//      action="append"), not collapsed to one flag.
//   5. `task` is NOT in the default set — cross-model self-orchestration stays off.
//
// WHY NODE / NO CLOCK: pure string analysis, host-side; no Date/random (AC5 N/A
// here but kept clean). Exit 0 = capable; exit 1 = re-boxed (loud) ; exit 2 = the
// shim couldn't be read (also loud — a missing guard target is itself a failure).
//
// Usage:
//   node scripts/wolfpack-toolcheck.mjs                 # checks the repo's shims
//   node scripts/wolfpack-toolcheck.mjs <vibe-shim>     # check a specific file

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The capable reviewer toolset (docs/wolfpack-autonomy/06 § "give models their
// tools"). read+grep+edit+write_file+bash maps the spec's enumerated
// read/grep/git-read/write/search_replace onto Vibe's live tool names. `task` is
// the one deliberate exclusion (self-orchestration disabled).
export const CAPABLE_TOOLS = ['read', 'grep', 'edit', 'write_file', 'bash']
export const FORBIDDEN_DEFAULT_TOOLS = ['task']

// ─── Pure core (unit-tested directly) ───────────────────────────

// Analyze the podman-vibe.sh text. Returns { ok, tools, problems } — problems is
// a list of human-readable, fail-loud strings (empty ⇒ capable).
export function analyzeVibeShim(text) {
  const src = String(text || '')
  const problems = []

  // (3) Legacy comma-joined flag anywhere — the exact silent-blinding bug.
  //     e.g. --enabled-tools read,grep  /  --enabled-tools "read,grep"  /
  //     --enabled-tools=read,grep (argparse accepts the `=` form too).
  const commaFlag = src.match(/--enabled-tools[=\s]+["']?[\w.*-]+,[\w.*,-]+/)
  if (commaFlag) {
    problems.push(
      `comma-joined --enabled-tools found ("${commaFlag[0].trim()}") — argparse parses it as ONE bogus tool name; repeat the flag per tool instead`)
  }

  // (1) Extract the committed default tool list.
  const defMatch = src.match(/VIBE_TOOLS_DEFAULT=(["'])(.*?)\1/)
  if (!defMatch) {
    problems.push('VIBE_TOOLS_DEFAULT not found — cannot verify the capable toolset (did the shim get rewritten?)')
    return { ok: false, tools: [], problems }
  }
  const rawDefault = defMatch[2]

  // (2) Space-separated, comma-free.
  if (rawDefault.includes(',')) {
    problems.push(`VIBE_TOOLS_DEFAULT="${rawDefault}" contains a comma — tools must be SPACE-separated or the per-tool loop emits a bogus comma-joined flag`)
  }
  const tools = rawDefault.split(/\s+/).filter(Boolean)

  // (4) The loop must repeat --enabled-tools per tool (append), not one flag.
  //     Look for a for-loop over the default that appends a per-tool flag.
  const repeatsPerTool = /for\s+\w+\s+in\s+[^\n]*VIBE_TOOLS_DEFAULT[\s\S]*?VIBE_TOOL_FLAGS\+=\(\s*--enabled-tools\s+["']?\$/.test(src)
  if (!repeatsPerTool) {
    problems.push('VIBE_TOOL_FLAGS is not built by repeating --enabled-tools per tool over VIBE_TOOLS_DEFAULT — argparse needs the flag repeated, not collapsed')
  }

  // (1 cont.) Capable set present.
  for (const need of CAPABLE_TOOLS) {
    if (!tools.includes(need)) {
      problems.push(`capable tool "${need}" missing from VIBE_TOOLS_DEFAULT (have: ${tools.join(', ') || '<none>'}) — reviewer is re-boxed`)
    }
  }

  // (5) Self-orchestration must stay off.
  for (const bad of FORBIDDEN_DEFAULT_TOOLS) {
    if (tools.includes(bad)) {
      problems.push(`"${bad}" is in the default toolset — cross-model self-orchestration must stay disabled (the orchestrator owns fan-out)`)
    }
  }

  return { ok: problems.length === 0, tools, problems }
}

// ─── CLI ────────────────────────────────────────────────────────

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url))
  const vibePath = argv[2] || join(here, 'podman-vibe.sh')

  let failed = false

  if (!existsSync(vibePath)) {
    console.error(`✗ toolcheck: shim not found: ${vibePath}`)
    process.exit(2)
  }
  const vibe = analyzeVibeShim(readFileSync(vibePath, 'utf8'))
  if (vibe.ok) {
    console.log(`✓ podman-vibe.sh: capable toolset [${vibe.tools.join(' ')}] — not re-boxed`)
  } else {
    failed = true
    console.error('✗ podman-vibe.sh REVIEWER IS RE-BOXED (fail-loud):')
    for (const p of vibe.problems) console.error(`    • ${p}`)
  }

  process.exit(failed ? 1 : 0)
}

// Run as CLI only when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
}
