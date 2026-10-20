#!/usr/bin/env node
// scripts/wolfpack-data-root.test.mjs — scripts-unfork AC9: pack scripts run FROM THE PACK operate on
// the INVOKING repo's data, never on the pack's own .wolfpack/.
// Run: node --test scripts/wolfpack-data-root.test.mjs
//
// Every case runs the pack's real script ("$PK/scripts/<name>", PK = this checkout) with cwd = a
// throwaway consumer git repo holding .wolfpack/ fixtures, then asserts (a) the reads/writes landed
// under that temp repo and (b) this checkout's .wolfpack/ is byte-for-byte untouched. Two roots, on
// purpose (plan § Assumptions): cross-worktree shared data (model-stats, watch, live-watch) resolves
// to the MAIN worktree; worktree-local launch/artifacts (overnight, lessons) stay the cwd toplevel.
// Fixtures are generic: this is a public repo, so no consuming-project names here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const PK = realpathSync(join(here, '..'))
const S = (name) => join(PK, 'scripts', name)

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'wp-dataroot-')))
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))
let n = 0

const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0

// A temp consuming repo (git, one empty commit), optionally with a hunt worktree under `wtRoot`.
function consumer({ wt = null, wtRoot = '.agents/worktrees' } = {}) {
  const root = join(TMP, `consumer-${n++}`)
  mkdirSync(root, { recursive: true })
  g(root, 'init', '-q', '-b', 'main')
  g(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  let wtPath = null
  if (wt) {
    wtPath = join(root, wtRoot, wt)
    g(root, 'worktree', 'add', '-q', '-b', `feat/${wt}`, wtPath)
  }
  return { root, wt: wtPath }
}
function notGit() {
  const d = join(TMP, `plain-${n++}`)
  mkdirSync(d, { recursive: true })
  // guard: the temp root must not sit inside some git checkout, or "not a repo" cannot be tested
  assert.notEqual(spawnSync('git', ['-C', d, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status, 0, `${d} is inside a git repo`)
  return d
}
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }
const run = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 })

// Snapshot of THIS checkout's .wolfpack/: git's view (tracked + untracked + ignored) plus every
// file's size + mtime, so a write to an ignored file (model-stats.json, lessons.md) is caught too.
function packSnapshot() {
  // scripts/ too: a run must not drop anything next to the pack scripts either (e.g. __pycache__)
  const status = g(PK, 'status', '--porcelain', '--ignored', '--untracked-files=all', '.wolfpack', 'scripts')
  const files = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { const st = statSync(p); files.push(`${relative(PK, p)} ${st.size} ${st.mtimeMs}`) }
    }
  }
  walk(join(PK, '.wolfpack'))
  return { status, files: files.sort().join('\n') }
}
// Run fn and assert the pack's .wolfpack/ is unchanged by it.
function packUntouched(fn) {
  const before = packSnapshot()
  const out = fn()
  const after = packSnapshot()
  assert.equal(after.status, before.status, 'git status of the pack .wolfpack/ or scripts/ changed')
  assert.equal(after.files, before.files, 'a file under the pack .wolfpack/ was written')
  return out
}

const POOL_CONFIG = `# Config

## Project Identity
- **Name:** demo
- **Test command:** \`make test\`

## Model Pool
### Family → model mapping
- judgment    → claude:opus:high
- work-horse  → claude:sonnet
- reviewer-a  → glm:5.3 gate=WOLFPACK_ENABLE_GLM
- reviewer-b  → mistral:large-4
`
const PEDIGREE = (feature = 'h1') => JSON.stringify({
  feature,
  predicted_dimensions: { frontend_complexity: 1 },
  model_assignments: { alpha: 'claude:opus:high', shepherd: 'claude:sonnet', bloodhound: 'glm:5.3', pointer: 'mistral:large-4', watchdog: 'glm:5.3' },
  execution_scores: { code_quality: { score: 4, tags: ['clean_diff'] }, plan_adherence: { score: 5, tags: [] } },
})

// ─── wolfpack-model-stats.mjs ─────────────────────────────────────────────────
test('AC9 model-stats: run from the pack with cwd = a consumer repo → writes <consumer>/.wolfpack/pedigree/model-stats.json from ITS plans + Model Pool', () => {
  const c = consumer()
  put(join(c.root, 'wolfpack-config.md'), POOL_CONFIG)
  put(join(c.root, '.wolfpack', 'plans', 'h1', 'pedigree.json'), PEDIGREE('h1'))
  put(join(c.root, '.wolfpack', 'plans', 'h2', 'pedigree.json'), PEDIGREE('h2'))
  const r = packUntouched(() => run(process.execPath, [S('wolfpack-model-stats.mjs'), '--stamp', '2026-01-01T00:00:00Z'], c.root))
  assert.equal(r.status, 0, r.stderr)
  const out = join(c.root, '.wolfpack', 'pedigree', 'model-stats.json')
  assert.ok(r.stdout.includes(`model-stats: 2 hunts → ${out}`), r.stdout)
  const doc = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(doc.meta.pool_source, 'config')
  assert.equal(doc.meta.generated_at, '2026-01-01T00:00:00Z')
  // the consumer's concrete tokens fill their family cells (the brand-native fork behaviour, ported)
  assert.deepEqual(Object.keys(doc.model_stats).sort(), ['claude', 'glm', 'mistral'])
  assert.equal(doc.model_stats.glm.bloodhound.backend.runs, 2)
  assert.equal(doc.model_stats.mistral.pointer.backend.runs, 2)
  assert.equal(doc.model_stats.claude.shepherd.backend.runs, 2)
  assert.doesNotMatch(r.stderr, /DEFAULT_POOL/)
})

test('AC9 model-stats: cwd = a HUNT WORKTREE → reads and writes the MAIN checkout (the router\'s meter), never the worktree', () => {
  const c = consumer({ wt: 'h' })
  put(join(c.root, 'wolfpack-config.md'), POOL_CONFIG)
  put(join(c.root, '.wolfpack', 'plans', 'm1', 'pedigree.json'), PEDIGREE('m1'))
  put(join(c.wt, '.wolfpack', 'plans', 'decoy', 'pedigree.json'), PEDIGREE('decoy'))   // worktree-only: must not be counted
  const r = packUntouched(() => run(process.execPath, [S('wolfpack-model-stats.mjs')], join(c.wt)))
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(c.root, '.wolfpack', 'pedigree', 'model-stats.json')))
  assert.equal(existsSync(join(c.wt, '.wolfpack', 'pedigree', 'model-stats.json')), false)
  const doc = JSON.parse(readFileSync(join(c.root, '.wolfpack', 'pedigree', 'model-stats.json'), 'utf8'))
  assert.equal(doc.meta.hunts, 1)
  assert.equal(doc.meta.pool_source, 'config')
})

test('AC9 model-stats: no wolfpack-config.md → DEFAULT_POOL + stderr warning + pool_source default (disclosed, still written under the consumer)', () => {
  const c = consumer()
  put(join(c.root, '.wolfpack', 'plans', 'h1', 'pedigree.json'), PEDIGREE('h1'))
  const r = packUntouched(() => run(process.execPath, [S('wolfpack-model-stats.mjs')], c.root))
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stderr.includes(`⚠ model-stats: no wolfpack-config.md at ${join(c.root, 'wolfpack-config.md')} — family names fall back to the neutral DEFAULT_POOL`), r.stderr)
  const doc = JSON.parse(readFileSync(join(c.root, '.wolfpack', 'pedigree', 'model-stats.json'), 'utf8'))
  assert.equal(doc.meta.pool_source, 'default')
  // concrete brand tokens do not resolve under the neutral pool — exactly why the config is threaded
  assert.equal('glm' in doc.model_stats, false)
})

test('AC9 model-stats: an unusable Model Pool exits 2 (router message shape); outside git exits 2 naming the fix — nothing written', () => {
  const c = consumer()
  put(join(c.root, 'wolfpack-config.md'), POOL_CONFIG.replace(/^- reviewer-a .*\n/m, ''))
  put(join(c.root, '.wolfpack', 'plans', 'h1', 'pedigree.json'), PEDIGREE('h1'))
  const bad = packUntouched(() => run(process.execPath, [S('wolfpack-model-stats.mjs')], c.root))
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /✗ model-stats: .*wolfpack-config\.md: Model Pool unusable — Model Pool: missing required role\(s\) reviewer-a/)
  assert.equal(existsSync(join(c.root, '.wolfpack', 'pedigree', 'model-stats.json')), false)
  const d = notGit()
  const r = packUntouched(() => run(process.execPath, [S('wolfpack-model-stats.mjs')], d))
  assert.equal(r.status, 2)
  assert.equal(r.stderr.trim(), `✗ model-stats: run from inside the consuming repo (not a git repo: ${d})`)
  assert.deepEqual(readdirSync(d), [])
})

// ─── wolfpack-watch.sh (one-shot) ──────────────────────────────────────────────
const hb = (slug, extra = {}) => JSON.stringify({ hunt: slug, phase: 'Test', detail: 'testing', agent: 'working', ...extra })

test('AC9 watch.sh one-shot: cwd = a consumer → its heartbeats (main + BOTH worktree layouts); --repo works from anywhere; not a repo → exit 2', { skip: !has('python3') && 'SKIP: needs python3' }, () => {
  const c = consumer({ wt: 'wt-agents' })
  put(join(c.root, '.wolfpack', 'heartbeats', 'main-hunt.json'), hb('main-hunt'))
  put(join(c.wt, '.wolfpack', 'heartbeats', 'wt-agents.json'), hb('wt-agents'))
  // the other harness layout — a plain dir (not a registered worktree) is enough for the scan
  put(join(c.root, '.claude', 'worktrees', 'wt-claude', '.wolfpack', 'heartbeats', 'wt-claude.json'), hb('wt-claude'))
  const env = { WOLFPACK_WATCH_WIDTH: '160', WOLFPACK_HIDE_SECS: '0' }
  const one = packUntouched(() => run('bash', [S('wolfpack-watch.sh')], c.root, env))
  assert.equal(one.status, 0, one.stderr)
  for (const slug of ['main-hunt', 'wt-agents', 'wt-claude']) assert.ok(one.stdout.includes(slug), `${slug} missing:\n${one.stdout}`)
  assert.match(one.stdout, /wt-claude[^\n]*\[wt\]/, 'a .claude/worktrees heartbeat is labelled [wt]')
  // run from INSIDE the hunt worktree → still the main repo's view
  const fromWt = run('bash', [S('wolfpack-watch.sh')], c.wt, env)
  assert.equal(fromWt.status, 0, fromWt.stderr)
  assert.ok(fromWt.stdout.includes('main-hunt'), fromWt.stdout)
  // --repo <dir> from a non-repo cwd
  const d = notGit()
  const viaRepo = packUntouched(() => run('bash', [S('wolfpack-watch.sh'), '--repo', c.root], d, env))
  assert.equal(viaRepo.status, 0, viaRepo.stderr)
  assert.ok(viaRepo.stdout.includes('main-hunt'))
  // the pack's own heartbeats never appear (they are not the consumer's)
  for (const f of existsSync(join(PK, '.wolfpack', 'heartbeats')) ? readdirSync(join(PK, '.wolfpack', 'heartbeats')) : []) {
    assert.ok(!one.stdout.includes(f.replace(/\.json$/, '')), `pack heartbeat ${f} leaked into the consumer view`)
  }
  const no = run('bash', [S('wolfpack-watch.sh')], d, env)
  assert.equal(no.status, 2)
  assert.equal(no.stderr.trim(), '✗ wolfpack-watch: run it from the consuming repo or pass --repo <dir>')
  const noArg = run('bash', [S('wolfpack-watch.sh'), '--repo'], c.root, env)
  assert.equal(noArg.status, 2)
  assert.match(noArg.stderr, /--repo needs a directory/)
  const badRepo = run('bash', [S('wolfpack-watch.sh'), '--repo', d], c.root, env)
  assert.equal(badRepo.status, 2, '--repo naming a non-repo fails loud, never falls back to the cwd')
})

// ─── wolfpack-lessons.sh ───────────────────────────────────────────────────────
test('AC9 lessons.sh: cwd = a consumer → writes <consumer>/.wolfpack/pedigree/lessons.md from ITS pedigree; from a worktree → that worktree (cwd toplevel, deliberate)', { skip: !has('jq') && 'SKIP: needs jq' }, () => {
  const c = consumer({ wt: 'h' })
  put(join(c.root, '.wolfpack', 'plans', 'h1', 'pedigree.json'), PEDIGREE('consumer-feature-one'))
  const r = packUntouched(() => run('bash', [S('wolfpack-lessons.sh')], c.root))
  assert.equal(r.status, 0, r.stderr)
  const lessons = join(c.root, '.wolfpack', 'pedigree', 'lessons.md')
  assert.ok(existsSync(lessons), r.stdout + r.stderr)
  assert.match(readFileSync(lessons, 'utf8'), /^# Pedigree Lessons/m)
  // Watchdog runs it INSIDE the hunt worktree and commits lessons.md there
  put(join(c.wt, '.wolfpack', 'plans', 'h', 'pedigree.json'), PEDIGREE('h'))
  const w = packUntouched(() => run('bash', [S('wolfpack-lessons.sh')], c.wt))
  assert.equal(w.status, 0, w.stderr)
  assert.ok(existsSync(join(c.wt, '.wolfpack', 'pedigree', 'lessons.md')))
  const d = notGit()
  const no = run('bash', [S('wolfpack-lessons.sh')], d)
  // outside git it stops non-zero and writes nothing. (Its "Not in a git repo" line is never
  // printed: under `set -e` the failing `$(git rev-parse …)` assignment exits first — a pre-existing
  // quirk this hunt does not touch; recorded in tracker-log.md § Discovered.)
  assert.notEqual(no.status, 0)
  assert.deepEqual(readdirSync(d), [])
})

// ─── wolfpack-overnight.sh --dry-run ────────────────────────────────────────────
test('AC9 overnight.sh --dry-run: REPO_ROOT = the invoking checkout, GATE/SANDBOX = the pack\'s; exit 0 without gating; not a repo → exit 2', () => {
  const c = consumer({ wt: 'h' })
  const r = packUntouched(() => run('bash', [S('wolfpack-overnight.sh'), '--dry-run'], c.root))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, `REPO_ROOT=${c.root}\nGATE=${S('wolfpack-window-gate.mjs')}\nSANDBOX=${S('run-pipeline-sandbox.sh')}\n`)
  assert.equal(r.stderr, '', 'no gate call, no log line')
  // --show-toplevel on purpose: a launch from a worktree launches THAT checkout
  const w = run('bash', [S('wolfpack-overnight.sh'), '--dry-run'], c.wt)
  assert.equal(w.status, 0, w.stderr)
  assert.match(w.stdout, new RegExp(`^REPO_ROOT=${c.wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  // --dry-run must be the FIRST argument; without it the usage check still runs (exit 2, no launch)
  const u = run('bash', [S('wolfpack-overnight.sh')], c.root)
  assert.equal(u.status, 2)
  assert.match(u.stderr, /Usage: .* --campaign <slug>/)
  const d = notGit()
  const no = run('bash', [S('wolfpack-overnight.sh'), '--dry-run'], d)
  assert.equal(no.status, 2)
  assert.equal(no.stderr.trim(), `✗ wolfpack-overnight: run it from the consuming repo (not a git repo: ${d})`)
  assert.equal(no.stdout, '')
})

test('AC9 overnight.sh: a pack missing its gate / sandbox launcher → exit 2 naming the missing pack file (never a consumer copy)', () => {
  const fake = join(TMP, `fakepack-${n++}`, 'scripts')
  mkdirSync(fake, { recursive: true })
  writeFileSync(join(fake, 'wolfpack-overnight.sh'), readFileSync(S('wolfpack-overnight.sh')))
  const c = consumer()
  // the consumer even has its own copy — it must NOT be picked up
  put(join(c.root, 'scripts', 'wolfpack-window-gate.mjs'), '// a stale consumer copy\n')
  put(join(c.root, 'scripts', 'run-pipeline-sandbox.sh'), '# a stale consumer copy\n')
  const r = run('bash', [join(fake, 'wolfpack-overnight.sh'), '--dry-run'], c.root)
  assert.equal(r.status, 2)
  assert.match(r.stderr, new RegExp(`✗ wolfpack-overnight: the pack has no ${join(fake, 'wolfpack-window-gate.mjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  writeFileSync(join(fake, 'wolfpack-window-gate.mjs'), '// gate\n')
  const r2 = run('bash', [join(fake, 'wolfpack-overnight.sh'), '--dry-run'], c.root)
  assert.equal(r2.status, 2)
  assert.match(r2.stderr, /the pack has no .*run-pipeline-sandbox\.sh/)
})

// ─── wolfpack-timing.mjs ───────────────────────────────────────────────────────
test('AC9 timing.mjs: the explicit <planDir> of a consumer → pedigree.json timing block written THERE; the pack untouched', () => {
  const c = consumer()
  const planDir = join(c.root, '.wolfpack', 'plans', 'h1')
  put(join(planDir, 'metadata.json'), JSON.stringify({ feature: 'h1', model_assignments: { tracker: 'claude:opus:high' } }))
  put(join(planDir, 'pedigree.json'), JSON.stringify({ feature: 'h1' }))
  put(join(planDir, 'timing.jsonl'), [
    { phase: 'Test', event: 'start', ts: '2026-01-01T00:00:00+00:00' },
    { phase: 'Test', event: 'end', ts: '2026-01-01T00:10:00+00:00' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n')
  const r = packUntouched(() => run(process.execPath, [S('wolfpack-timing.mjs'), planDir], c.root))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^DURATION=/m)
  const ped = JSON.parse(readFileSync(join(planDir, 'pedigree.json'), 'utf8'))
  assert.ok(ped.timing && typeof ped.timing === 'object', JSON.stringify(ped))
  // cwd elsewhere (a non-repo) changes nothing: the root is the argument
  const d = notGit()
  const r2 = packUntouched(() => run(process.execPath, [S('wolfpack-timing.mjs'), planDir], d))
  assert.equal(r2.status, 0, r2.stderr)
  assert.deepEqual(readdirSync(d), [])
})

// ─── wolfpack-live-watch.py (the get_hunts_status path; no podman needed) ────────
const PY_PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("lw", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps({"root": str(m.REPO_ROOT), "wt_roots": m.WT_ROOTS, "match": m.CONTAINER_MATCH,
                  "rows": [{k: r[k] for k in ("slug", "loc", "tier", "phase")} for r in m.get_hunts_status()]}))
`
test('AC9 live-watch.py: REPO_ROOT = the consumer\'s MAIN worktree (from a worktree too), both layouts scanned, container match from env; not a repo → exit 2', { skip: !has('python3') && 'SKIP: needs python3' }, () => {
  const c = consumer({ wt: 'wa' })
  put(join(c.root, '.wolfpack', 'heartbeats', 'main-h.json'), hb('main-h'))
  put(join(c.root, '.wolfpack', 'plans', 'main-h', 'metadata.json'), JSON.stringify({ tier: 'Yellow' }))
  put(join(c.wt, '.wolfpack', 'heartbeats', 'wa.json'), hb('wa'))
  put(join(c.wt, '.wolfpack', 'plans', 'wa', 'metadata.json'), JSON.stringify({ tier: 'Orange' }))
  put(join(c.root, '.claude', 'worktrees', 'wc', '.wolfpack', 'heartbeats', 'wc.json'), hb('wc'))
  for (const cwd of [c.root, c.wt]) {
    const r = packUntouched(() => run('python3', ['-I', '-B', '-c', PY_PROBE, S('wolfpack-live-watch.py')], cwd, { WOLFPACK_WATCH_CONTAINER_MATCH: ' projx, ,projy ' }))
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.root, c.root, `cwd ${cwd}`)
    assert.deepEqual(j.wt_roots, [join(c.root, '.agents', 'worktrees'), join(c.root, '.claude', 'worktrees')])
    assert.deepEqual(j.match, ['wolfpack', 'projx', 'projy'])
    const bySlug = Object.fromEntries(j.rows.map(x => [x.slug, x]))
    assert.deepEqual(Object.keys(bySlug).sort(), ['main-h', 'wa', 'wc'])
    assert.equal(bySlug['main-h'].loc, 'main')
    assert.equal(bySlug['main-h'].tier, 'Yellow')
    assert.equal(bySlug.wa.loc, 'wt')
    assert.equal(bySlug.wa.tier, 'Orange', 'read_meta finds the worktree plan dir')
    assert.equal(bySlug.wc.loc, 'wt')
  }
  // default container match = just "wolfpack"
  const dflt = JSON.parse(run('python3', ['-I', '-B', '-c', PY_PROBE, S('wolfpack-live-watch.py')], c.root, { WOLFPACK_WATCH_CONTAINER_MATCH: '' }).stdout)
  assert.deepEqual(dflt.match, ['wolfpack'])
  const d = notGit()
  const no = run('python3', ['-I', '-B', S('wolfpack-live-watch.py')], d)
  assert.equal(no.status, 2)
  assert.equal(no.stderr.trim(), `✗ wolfpack-live-watch: run it from inside the consuming repo (not a git repo: ${d})`)
})
