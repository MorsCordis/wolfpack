#!/usr/bin/env node
// scripts/wolfpack-commands.test.mjs — the canonical pack commands (pack-commands-canonical AC1–AC5,
// AC7, D1, AC13). Every consumer fork delta now lives in .agents/commands; these text contracts pin it.
// Run: node --test scripts/wolfpack-commands.test.mjs [<commands dir>]
//
// The directory under test: WOLFPACK_COMMANDS_DIR ‖ argv[2] ‖ <repo>/.agents/commands. Post-merge, the
// running-copy proof (AC13) is
//   WOLFPACK_COMMANDS_DIR="$(readlink -f ~/.claude/commands)" node --test scripts/wolfpack-commands.test.mjs
// and the diagnostic line says "running copy". Public repo: no consuming-project names in here — the
// forbidden-string greps assemble their needles from parts where a literal would itself be a leak.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const argDir = process.argv.slice(2).find((a) => !a.startsWith('-'))
const DIR = realpathSync(process.env.WOLFPACK_COMMANDS_DIR || argDir || join(ROOT, '.agents', 'commands'))
let running = null
try { running = realpathSync(join(homedir(), '.claude', 'commands')) } catch { /* no user-level link */ }
console.log(`commands dir: ${DIR} (${DIR === running ? 'running copy' : 'worktree copy, pre-merge'})`)

const read = (name) => readFileSync(join(DIR, name), 'utf8')
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()
const ALL = Object.fromEntries(FILES.map((f) => [f, read(f)]))
const has = (t, s, label) => assert.ok(t.includes(s), `${label}: missing ${JSON.stringify(s)}`)
const lacks = (t, s, label) => assert.equal(t.includes(s), false, `${label}: must not contain ${JSON.stringify(s)}`)
const section = (t, from, to) => {
  const a = t.indexOf(from)
  assert.ok(a >= 0, `no ${from}`)
  const b = t.indexOf(to, a + from.length)
  assert.ok(b > a, `no ${to} after ${from}`)
  return t.slice(a, b)
}
const frontTools = (t) => {
  const front = t.split('---')[1] ?? ''
  const line = front.split('\n').find((l) => l.startsWith('allowed-tools:'))
  assert.ok(line, 'an allowed-tools: frontmatter line')
  return new Set(line.slice('allowed-tools:'.length).split(',').map((s) => s.trim()).filter(Boolean))
}

test('the commands dir holds the full canonical set (release-campaign moved in)', () => {
  for (const f of ['alpha', 'bloodhound', 'debrief', 'expedition', 'hunt', 'merge', 'merge-wave', 'parked', 'pointer',
    'release-campaign', 'resolve', 'run-campaign', 'run-campaign-local', 'run-hunt', 'run-hunt-local', 'shepherd',
    'smoke', 'smoke-wave', 'spec', 'tracker', 'watchdog']) {
    assert.ok(FILES.includes(`${f}.md`), `${f}.md`)
  }
})

// ── AC1: run-campaign-local --chain ────────────────────────────────────
test('AC1: run-campaign-local parses --chain (description + Parse line), chain: true, default 1, the chain-mode section and markers', () => {
  const t = ALL['run-campaign-local.md']
  for (const s of ['--chain', 'chain: true', 'default 1', 'chain mode (campaign/<slug>)', '## Chain mode',
    'WOLFPACK_CHAIN_RUNNER=1', 'WOLFPACK_CHAIN_PROTOCOL=1', 'install.sh" --consumer']) has(t, s, 'run-campaign-local')
  const lines = t.split('\n')
  const desc = lines.find((l) => l.startsWith('description:'))
  assert.match(desc, /\[--chain\]/, 'the description line carries the [--chain] grammar')
  const parse = lines.filter((l) => /parse/i.test(l) && l.includes('[--chain]'))
  assert.ok(parse.length >= 1, 'a Parse line carries [--chain]')
  for (const s of ['No pipeline code changes', 'Do NOT modify `campaign-runner.js`', ['wolfpack', 'sync', 'runtime'].join('-')]) lacks(t, s, 'run-campaign-local')
})

test('AC1: the chain markers the launch command greps for really exist in the pack workflows', () => {
  assert.match(readFileSync(join(ROOT, '.agents', 'workflows', 'campaign-runner.js'), 'utf8'), /WOLFPACK_CHAIN_RUNNER=1/)
  assert.match(readFileSync(join(ROOT, '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8'), /WOLFPACK_CHAIN_PROTOCOL=1/)
})

test('AC1: Step 1.5 (prespec sweep) differs from base 9bf6605 only by the $PACK prespec substitution', (t) => {
  const base = spawnSync('git', ['-C', ROOT, 'show', '9bf6605:.agents/commands/run-campaign-local.md'], { encoding: 'utf8' })
  if (base.status !== 0) { t.skip('base 9bf6605 not in this clone (shallow checkout) — Step 1.5 diff not checked'); return }
  const before = section(base.stdout, '## Step 1.5', '## Step 2')
  const now = section(ALL['run-campaign-local.md'], '## Step 1.5', '## Step 2')
  assert.ok(now.includes('"$PACK/scripts/wolfpack-prespec.mjs"'), 'the prespec helper resolves through $PACK')
  assert.equal(now.includes('node scripts/wolfpack-prespec.mjs'), false)
  assert.equal(now.replaceAll('"$PACK/scripts/wolfpack-prespec.mjs"', 'scripts/wolfpack-prespec.mjs'), before)
})

// ── AC2: merge-wave chain stop ─────────────────────────────────────────
test('AC2: merge-wave stops on a chain campaign → /release-campaign; "released" means exactly `merged`', () => {
  const t = ALL['merge-wave.md']
  for (const s of ['chain.mode == "chain"', '/release-campaign $1', 'exactly `merged`', 'merged_to_campaign',
    'Migration file pattern', 'Hard Rules']) has(t, s, 'merge-wave')
})

test('AC2: merge refuses a chain-mode hunt (base_branch or the campaign chain.mode) → /release-campaign', () => {
  const t = ALL['merge.md']
  for (const s of ['base_branch', 'chain.mode', '/release-campaign']) has(t, s, 'merge')
})

test('chain-mode notes carried in hunt / smoke-wave / shepherd / watchdog', () => {
  assert.match(ALL['hunt.md'], /chain\.mode == "chain"/)
  assert.match(ALL['hunt.md'], /base_branch/)
  assert.match(ALL['smoke-wave.md'], /wolfpack-release\.mjs" revert|wolfpack-release\.mjs revert/)
  // the seat commands' base_branch bullets are superseded-by-canonical (port ledger): the role skill holds them
  for (const role of ['shepherd', 'watchdog']) {
    has(ALL[`${role}.md`], `$PACK/.agents/skills/${role}/SKILL.md`, role)
    assert.match(readFileSync(join(ROOT, '.agents', 'skills', role, 'SKILL.md'), 'utf8'), /base_branch/, `${role} skill`)
  }
})

// ── AC3: release-campaign ─────────────────────────────────────────────
test('AC3: release-campaign exists, is config-driven (Dev deploy command, --no-migrate), never pushes, no project deploy alias', () => {
  assert.ok(existsSync(join(DIR, 'release-campaign.md')))
  const t = ALL['release-campaign.md']
  has(t, 'Dev deploy command', 'release-campaign')
  has(t, '--no-migrate', 'release-campaign')
  has(t, '--no-ff', 'release-campaign')
  has(t, 'Tag pattern', 'release-campaign')
  assert.doesNotMatch(t, /git\s+push/)
  lacks(t, 'deploy-dev', 'release-campaign')
  const PROD = 'pr' + 'od'
  assert.doesNotMatch(t, new RegExp(`(deploy|migrate)-${PROD}`))
  const calls = [...t.matchAll(/(\S*)wolfpack-(release|chain)\.mjs/g)]
  assert.ok(calls.length > 0, 'it calls the release/chain helpers')
  for (const m of calls) assert.match(m[1], /\$PACK\/scripts\/$/, `unprefixed invocation: ${m[0]}`)
  const fm = frontTools(t)
  assert.deepEqual([...fm].sort(), ['Bash', 'Edit', 'Read'])
})

test('AC3: every wolfpack-release.mjs subcommand release-campaign names exists in the helper, deploy uses the D8 forms', () => {
  const t = ALL['release-campaign.md']
  const rel = readFileSync(join(ROOT, 'scripts', 'wolfpack-release.mjs'), 'utf8')
  const subs = new Set([...t.matchAll(/wolfpack-release\.mjs"?\s+([a-z][a-z-]+)/g)].map((m) => m[1]))
  assert.ok(subs.size >= 5, [...subs].join(','))
  for (const sub of subs) assert.ok(rel.includes(`'${sub}'`), `wolfpack-release.mjs has no ${sub} subcommand`)
  for (const sub of ['check', 'deploy', 'changelog', 'merge-commands', 'stamp-released']) assert.ok(subs.has(sub), `never calls ${sub}`)
  assert.match(t, /deploy --campaign[^\n]*--deploy-cmd[^\n]*--migrate-cmd/)
  assert.match(t, /deploy --campaign[^\n]*--deploy-cmd[^\n]*--no-migrate/)
})

// ── AC4: smoke sign-in hook ───────────────────────────────────────────
test('AC4: smoke and smoke-wave sign in through the configured hook (probe, states, fallback, re-login rule)', () => {
  for (const f of ['smoke.md', 'smoke-wave.md']) {
    for (const s of ['smokeLoginHook', '--check', 'SIGNED_IN', 'SIGNED_OUT', 'session_after_deploy',
      'No smoke login hook configured', 'session lost after re-login']) has(ALL[f], s, f)
  }
  has(ALL['smoke-wave.md'], 'isolatedContext', 'smoke-wave')
})

test('AC4: smoke-wave allows both chrome-devtools MCP prefixes for all 12 tool names', () => {
  const tools = frontTools(ALL['smoke-wave.md'])
  for (const name of ['navigate_page', 'new_page', 'take_snapshot', 'click', 'fill', 'fill_form', 'evaluate_script',
    'list_network_requests', 'get_network_request', 'list_console_messages', 'wait_for', 'take_screenshot']) {
    assert.ok(tools.has(`mcp__chrome-devtools__${name}`), `mcp__chrome-devtools__${name}`)
    assert.ok(tools.has(`mcp__plugin_chrome-devtools-mcp_chrome-devtools__${name}`), `plugin prefix ${name}`)
  }
})

test('AC4: no project sign-in script, venv or account names in any command; smoke-wave Released = `merged`', () => {
  const needle = new RegExp(['smoke' + '_login\\.py', 'paw' + '_env', 'smoke' + '-admin', 'smoke' + '-tech'].join('|'))
  for (const [f, t] of Object.entries(ALL)) assert.doesNotMatch(t, needle, f)
  assert.match(ALL['smoke-wave.md'], /Released = `status: merged`/)
})

// ── AC5: worktree root from config ────────────────────────────────────
const AC5_FILES = ['hunt', 'merge', 'merge-wave', 'run-hunt', 'run-hunt-local', 'run-campaign', 'parked', 'smoke-wave']
test('AC5: every literal worktrees path line also names the Worktree root config key', () => {
  for (const [f, t] of Object.entries(ALL)) {
    t.split('\n').forEach((l, i) => {
      if (/\.(agents|claude)\/worktrees/.test(l)) assert.ok(l.includes('Worktree root'), `${f}:${i + 1}: ${l}`)
    })
  }
})
test('AC5: the eight worktree-using commands resolve worktreeRoot and STOP when it is missing', () => {
  for (const f of AC5_FILES) {
    const t = ALL[`${f}.md`]
    for (const s of ['worktreeRoot', 'Worktree root', 'If the reader exits 2 or `worktreeRoot` is null, STOP']) has(t, s, f)
  }
})

// ── AC7: seat commands are project-neutral ────────────────────────────
const SEATS = ['alpha', 'bloodhound', 'debrief', 'pointer', 'shepherd', 'tracker', 'watchdog']
const SEAT_SKILL = { debrief: 'alpha' }
test('AC7: the seven seat commands carry no project tooling and name the pack role skill through $PACK', () => {
  const bad = /run_tests\.sh|migrate_schemas|controlled_substances|deploy-dev|\.claude\/skills\//
  for (const s of SEATS) {
    const t = ALL[`${s}.md`]
    assert.doesNotMatch(t, bad, s)
    assert.doesNotMatch(t, /django/i, s)
    has(t, `$PACK/.agents/skills/${SEAT_SKILL[s] ?? s}/SKILL.md`, s)
  }
})

// ── D1: pack scripts resolve through $PACK ────────────────────────────
test('D1: no command runs a repo-relative pack script (`node scripts/wolfpack-…`); the watcher exception stays', () => {
  for (const [f, t] of Object.entries(ALL)) lacks(t, 'node scripts/wolfpack-', f)
  for (const [f, t] of Object.entries(ALL)) {
    for (const m of t.matchAll(/(?<![$\w/"])scripts\/wolfpack-[\w-]+\.(mjs|sh)/g)) {
      const line = t.slice(t.lastIndexOf('\n', m.index) + 1, t.indexOf('\n', m.index))
      if (m[0] === 'scripts/wolfpack-watch.sh') continue
      assert.ok(/\$PACK|pack's|the pack|PACK\//i.test(line), `${f}: bare pack script ${m[0]} in: ${line}`)
    }
  }
})

test('P1: every command that runs a pack script resolves the pack home first', () => {
  for (const [f, t] of Object.entries(ALL)) {
    if (!t.includes('$PACK/')) continue
    assert.match(t, /PACK=|pack home|Wolfpack home|WOLFPACK_HOME/i, `${f} uses $PACK without resolving it`)
  }
})
