#!/usr/bin/env node
// scripts/wolfpack-test-record.test.mjs — the pipeline's SHA-stamped full-suite test record
// (run-observability AC7, AC9, AC11 at script level; P5 verdict command; P6 trust anchor).
// Run: node --test scripts/wolfpack-test-record.test.mjs
//
// Pure helpers are unit-tested; the CLI is driven against REAL git in throwaway repos under the
// OS temp dir (isolated git config, fixed identity, no network) with a stub test command
// (`bash t.sh`) — never the pack's own suite.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summaryLine, recordPaths, substituteVerdict, checkRecord, fixLine, STAGES } from './wolfpack-test-record.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, 'wolfpack-test-record.mjs')

// ─── Isolated git environment ────────────────────────────────────────────────
const CFG_DIR = mkdtempSync(join(tmpdir(), 'wptr-cfg-'))
writeFileSync(join(CFG_DIR, 'gitconfig'), '')
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: join(CFG_DIR, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Record Test', GIT_AUTHOR_EMAIL: 'record-test@example.invalid',
  GIT_COMMITTER_NAME: 'Record Test', GIT_COMMITTER_EMAIL: 'record-test@example.invalid',
}
Object.assign(process.env, GIT_ENV)
const ROOTS = [CFG_DIR]
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }) })

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text) }
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'))
function commitFiles(dir, files, msg) {
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text)
  g(dir, 'add', '--', ...Object.keys(files))
  g(dir, 'commit', '-q', '-m', msg)
  return g(dir, 'rev-parse', 'HEAD')
}
const config = (testCommand, { verdict = null, links = null } = {}) => `# Config

## Project Identity
- **Name:** record-fixture
- **Test command:** \`${testCommand}\` — the stub suite
${verdict ? `- **Test verdict command:** \`${verdict}\`\n` : ''}${links ? `- **Worktree links:** ${links}\n` : ''}
## Compliance Requirements
- **Compliance areas:** none
- **Risk-surface paths:** none
`
// A stub suite: prints a few lines on stdout AND stderr, appends to a counter OUTSIDE the repo,
// and exits with the code stored in exit.txt (committed, so the record reflects the COMMIT).
const T_SH = `#!/usr/bin/env bash
echo "running stub suite"
echo "stderr line" >&2
echo "run" >> "$COUNTER"
code=$(cat exit.txt)
echo "stub: 3 passed, $code failed"
exit "$code"
`
// → { repo, counter, recordDir, run(args, env) }
function fixture({ testCommand = 'bash t.sh', exitCode = 0, verdict = null, links = null, extra = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wptr-')))
  ROOTS.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  g(repo, 'init', '-q', '-b', 'main')
  commitFiles(repo, { 'wolfpack-config.md': config(testCommand, { verdict, links }), 't.sh': T_SH, 'exit.txt': `${exitCode}\n`, ...extra }, 'init')
  const counter = join(root, 'counter.txt')
  const recordDir = join(root, 'plan')
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, COUNTER: counter, WOLFPACK_TEST_RECORD_TIMEOUT_MIN: '', ...env },
    })
    let json = null
    try { json = JSON.parse(r.stdout) } catch { /* not JSON */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
  }
  return { root, repo, counter, recordDir, run }
}
const runs = (f) => (existsSync(f.counter) ? readFileSync(f.counter, 'utf8').trim().split('\n').length : 0)

// ─── pure helpers ────────────────────────────────────────────────────────────
test('summaryLine: the LAST summary-like line; else the last non-empty line; empty → (no output)', () => {
  assert.equal(summaryLine('── a\nPASS x\ntest-all: 39 passed, 0 failed, 0 skipped (needs podman)\n\n'), 'test-all: 39 passed, 0 failed, 0 skipped (needs podman)')
  assert.equal(summaryLine('......\n------\nRan 12 tests in 0.1s\n\nOK\n'), 'OK')
  assert.equal(summaryLine('F.\nRan 2 tests in 0.1s\n\nFAILED (failures=2)\n'), 'FAILED (failures=2)')
  assert.equal(summaryLine('Ran 2 tests\nsome trailing noise\n'), 'Ran 2 tests')
  assert.equal(summaryLine('alpha\nbeta\n'), 'beta')
  assert.equal(summaryLine(''), '(no output)')
  assert.equal(summaryLine(null), '(no output)')
  assert.equal(summaryLine('\n  \n'), '(no output)')
  assert.equal(summaryLine('a\r\nstub: 3 passed, 0 failed\r\n'), 'stub: 3 passed, 0 failed')
})

test('recordPaths: stage-keyed json + log in the dir; an unknown stage throws', () => {
  assert.deepEqual([...STAGES], ['tracker', 'final', 'release'])
  assert.deepEqual(recordPaths('/x/plan', 'final'), { json: '/x/plan/test-record-final.json', log: '/x/plan/test-record-final.log' })
  for (const s of ['', 'Tracker', 'deploy', undefined]) assert.throws(() => recordPaths('/x', s), /unknown stage/, String(s))
})

test('substituteVerdict: {log}/{main} shell-quoted (spaces and quotes survive), {exit} an integer, every occurrence', () => {
  const cmd = substituteVerdict('check --log {log} --base {main}/b.md --exit {exit} --again {log}', { log: "/a b/it's.log", exit: 1, main: '/m n' })
  assert.equal(cmd, `check --log '/a b/it'\\''s.log' --base '/m n'/b.md --exit 1 --again '/a b/it'\\''s.log'`)
  const out = execFileSync('bash', ['-c', `printf '%s|' ${substituteVerdict('{log} {main} {exit}', { log: '/a $HOME `x`', exit: '2', main: '/m' })}`], { encoding: 'utf8' })
  assert.equal(out, '/a $HOME `x`|/m|2|')
  assert.equal(substituteVerdict('x {exit}', { exit: 2.9 }), 'x 2')
})

const SHA = 'a'.repeat(40)
const REC = { schema: 1, stage: 'final', commit: SHA, head: SHA, exit: 0, pass: true, command: 'bash t.sh', verdict_command: null, summary: 's', log: '/l' }
test('checkRecord: missing / invalid / stale / fail / pass, with ok only on pass', () => {
  const want = { sha: SHA, command: 'bash t.sh', verdictCommand: null, stage: 'final' }
  assert.deepEqual(checkRecord(null, want), { state: 'missing', ok: false, reason: 'no test record' })
  assert.deepEqual(checkRecord(REC, want), { state: 'pass', ok: true, reason: null })
  for (const [name, rec] of [['array', []], ['string', 'x'], ['schema 2', { ...REC, schema: 2 }], ['no schema', { ...REC, schema: undefined }],
    ['short commit', { ...REC, commit: 'abc' }], ['upper-case commit', { ...REC, commit: 'A'.repeat(40) }], ['exit string', { ...REC, exit: '0' }],
    ['exit float', { ...REC, exit: 0.5 }], ['pass string', { ...REC, pass: 'true' }], ['wrong stage', { ...REC, stage: 'tracker' }], ['unparseable', { unparseable: true }]]) {
    const r = checkRecord(rec, want)
    assert.equal(r.state, 'invalid', name)
    assert.equal(r.ok, false, name)
  }
  assert.equal(checkRecord({ ...REC, commit: 'b'.repeat(40), head: 'b'.repeat(40) }, want).state, 'stale')
  assert.equal(checkRecord({ ...REC, command: 'true' }, want).state, 'stale')
  assert.equal(checkRecord({ ...REC, verdict_command: 'v {log}' }, want).state, 'stale')
  assert.equal(checkRecord(REC, { ...want, verdictCommand: 'v {log}' }).state, 'stale')
  assert.equal(checkRecord({ ...REC, verdict_command: undefined }, want).state, 'pass', 'absent verdict_command ≡ null')
  const f = checkRecord({ ...REC, pass: false, exit: 1, reason: 'suite exit 1' }, want)
  assert.deepEqual(f, { state: 'fail', ok: false, reason: 'suite exit 1' })
  assert.equal(checkRecord({ ...REC, pass: false, exit: 3 }, want).reason, 'suite exit 3')
  // no stage requested → the stage is not judged
  assert.equal(checkRecord({ ...REC, stage: 'tracker' }, { ...want, stage: undefined }).state, 'pass')
})

test('fixLine: the exact ensure command, single-quoted, --repo only when given', () => {
  assert.equal(fixLine({ stage: 'final', recordDir: '/p d', rev: 'feat/x', repo: '/w', pack: '/pk' }),
    "node '/pk/scripts/wolfpack-test-record.mjs' ensure --stage final --record-dir '/p d' --rev 'feat/x' --repo '/w'")
  assert.equal(fixLine({ stage: 'release', recordDir: '/c', rev: 'campaign/c1', pack: '/pk' }),
    "node '/pk/scripts/wolfpack-test-record.mjs' ensure --stage release --record-dir '/c' --rev 'campaign/c1'")
})

// ─── CLI: run ────────────────────────────────────────────────────────────────
test('AC7 run (pass): writes the SHA-stamped json + the raw interleaved log; exit 0', () => {
  const f = fixture()
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(r.code, 0, r.stderr)
  const head = g(f.repo, 'rev-parse', 'HEAD')
  const rec = readJ(join(f.recordDir, 'test-record-tracker.json'))
  assert.deepEqual({ ...r.json, reused: undefined }, { ...rec, reused: undefined })
  assert.equal(r.json.reused, false)
  assert.equal(rec.schema, 1)
  assert.equal(rec.stage, 'tracker')
  assert.equal(rec.commit, head)
  assert.equal(rec.head, head)
  assert.equal(rec.ref, 'HEAD')
  assert.equal(rec.ran_in, 'repo')
  assert.deepEqual(rec.dirty, [])
  assert.equal(rec.command, 'bash t.sh')
  assert.equal(rec.config, join(f.repo, 'wolfpack-config.md'))
  assert.equal(rec.verdict_command, null)
  assert.equal(rec.exit, 0)
  assert.equal(rec.timed_out, false)
  assert.equal(rec.pass, true)
  assert.equal(rec.reason, null)
  assert.equal(rec.summary, 'stub: 3 passed, 0 failed')
  assert.equal(rec.verdict_exit, null)
  const logText = readFileSync(rec.log)
  assert.equal(rec.log, join(f.recordDir, 'test-record-tracker.log'))
  assert.equal(logText.toString(), 'running stub suite\nstderr line\nstub: 3 passed, 0 failed\n', 'stdout + stderr interleaved verbatim')
  assert.equal(rec.log_sha256, createHash('sha256').update(logText).digest('hex'))
  assert.ok(Date.parse(rec.started_at) <= Date.parse(rec.finished_at))
  assert.ok(Number.isInteger(rec.duration_ms) && rec.duration_ms >= 0)
  assert.equal(readdirSync(f.recordDir).sort().join(','), 'test-record-tracker.json,test-record-tracker.log', 'no tmp / partial left')
  assert.match(r.stderr, /wolfpack-test-record: tracker [0-9a-f]{12} PASS — stub: 3 passed, 0 failed \[ran in repo\]/)
})

test('AC7 run (fail): exit 1 → pass false, reason "suite exit 1"; process exit 2', () => {
  const f = fixture({ exitCode: 1 })
  const r = f.run(['run', '--json', '--stage', 'final', '--record-dir', f.recordDir])
  assert.equal(r.code, 2, r.stderr)
  assert.equal(r.json.pass, false)
  assert.equal(r.json.exit, 1)
  assert.equal(r.json.reason, 'suite exit 1')
  assert.equal(r.json.summary, 'stub: 3 passed, 1 failed')
  assert.equal(readJ(join(f.recordDir, 'test-record-final.json')).pass, false)
})

test('run: an absent (nested) record dir is created; both files land in it', () => {
  const f = fixture()
  const dir = join(f.root, 'a', 'b')
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', dir])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(existsSync(join(dir, 'test-record-tracker.json')))
  assert.ok(existsSync(join(dir, 'test-record-tracker.log')))
})

// ─── CLI: ensure (AC9 reuse) ─────────────────────────────────────────────────
test('AC9 ensure: reuses a record at the same HEAD (no second run); re-runs after a commit', () => {
  const f = fixture()
  const a = f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(a.code, 0, a.stderr)
  assert.equal(a.json.reused, false)
  const b = f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(b.code, 0)
  assert.equal(b.json.reused, true)
  assert.equal(b.json.commit, a.json.commit)
  assert.equal(runs(f), 1, 'the suite ran ONCE')
  assert.match(b.stderr, /\[reused\]/)
  const next = commitFiles(f.repo, { 'note.txt': 'x\n' }, 'more')
  const c = f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(c.code, 0)
  assert.equal(c.json.reused, false)
  assert.equal(c.json.commit, next)
  assert.equal(runs(f), 2)
})

test('AC9 ensure: a FAILING record at the same HEAD is reused too (exit 2, no re-run); run always re-runs', () => {
  const f = fixture({ exitCode: 1 })
  assert.equal(f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir]).code, 2)
  const again = f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(again.code, 2)
  assert.equal(again.json.reused, true)
  assert.equal(again.json.pass, false)
  assert.equal(runs(f), 1)
  assert.equal(f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir]).code, 2)
  assert.equal(runs(f), 2)
})

test('ensure: a record whose command differs from the configured one is stale → re-run; a corrupt record → re-run', () => {
  const f = fixture()
  f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  const p = join(f.recordDir, 'test-record-tracker.json')
  writeFileSync(p, JSON.stringify({ ...readJ(p), command: 'true' }))
  const r = f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(r.json.reused, false)
  assert.equal(r.json.command, 'bash t.sh')
  writeFileSync(p, '{ not json')
  assert.equal(f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir]).json.reused, false)
  assert.equal(runs(f), 3)
})

// ─── CLI: check / gate (AC11) ────────────────────────────────────────────────
test('AC11 check: missing → refuse (exit 2) with the ensure fix line; never runs', () => {
  const f = fixture()
  const r = f.run(['check', '--json', '--stage', 'final', '--record-dir', f.recordDir, '--rev', 'main'])
  assert.equal(r.code, 2)
  assert.equal(r.json.state, 'missing')
  assert.equal(r.json.ok, false)
  assert.equal(r.json.ran, false)
  assert.match(r.json.fix, /wolfpack-test-record\.mjs' ensure --stage final --record-dir '[^']+' --rev 'main'$/)
  assert.match(r.stderr, /check REFUSE — missing/)
  assert.match(r.stderr, /fix: node /)
  assert.equal(runs(f), 0)
})

test('AC11 check: SHA mismatch → stale refuse; failing → refuse; passing + matching → allow (exit 0, fix null)', () => {
  const f = fixture()
  f.run(['ensure', '--json', '--stage', 'final', '--record-dir', f.recordDir])
  const ok = f.run(['check', '--json', '--stage', 'final', '--record-dir', f.recordDir])
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(ok.json.state, 'pass')
  assert.equal(ok.json.fix, null)
  assert.equal(ok.json.target, g(f.repo, 'rev-parse', 'HEAD'))
  commitFiles(f.repo, { 'n.txt': '1\n' }, 'moved')
  const stale = f.run(['check', '--json', '--stage', 'final', '--record-dir', f.recordDir])
  assert.equal(stale.code, 2)
  assert.equal(stale.json.state, 'stale')
  assert.equal(runs(f), 1, 'check never re-runs')
  // a failing record at the tip
  const bad = fixture({ exitCode: 1 })
  bad.run(['ensure', '--json', '--stage', 'final', '--record-dir', bad.recordDir])
  const refused = bad.run(['check', '--json', '--stage', 'final', '--record-dir', bad.recordDir])
  assert.equal(refused.code, 2)
  assert.equal(refused.json.state, 'fail')
  assert.match(refused.json.fix, /ensure --stage final/)
  // a record of ANOTHER stage never satisfies this one
  const other = fixture()
  other.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', other.recordDir])
  assert.equal(other.run(['check', '--json', '--stage', 'final', '--record-dir', other.recordDir]).json.state, 'missing')
})

test('AC11 gate: a stale record (tip moved, e.g. an auto-rebase) is re-taken ONCE then allowed; missing / failing refuse without running', () => {
  const f = fixture()
  f.run(['ensure', '--json', '--stage', 'final', '--record-dir', f.recordDir])
  const tip = commitFiles(f.repo, { 'n.txt': '1\n' }, 'rebased')
  const r = f.run(['gate', '--json', '--stage', 'final', '--record-dir', f.recordDir, '--rev', 'main'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.ran, true)
  assert.equal(r.json.state, 'pass')
  assert.equal(readJ(join(f.recordDir, 'test-record-final.json')).commit, tip)
  assert.equal(runs(f), 2)
  assert.match(r.stderr, /re-taking the record once/)
  // stale and the re-run FAILS → refuse
  put(f.repo, 'exit.txt', '1\n'); g(f.repo, 'add', 'exit.txt'); g(f.repo, 'commit', '-q', '-m', 'break')
  const broke = f.run(['gate', '--json', '--stage', 'final', '--record-dir', f.recordDir])
  assert.equal(broke.code, 2)
  assert.equal(broke.json.ran, true)
  assert.equal(broke.json.state, 'fail')
  assert.equal(runs(f), 3)
  // missing → refuse, no run
  const m = fixture()
  const miss = m.run(['gate', '--json', '--stage', 'final', '--record-dir', m.recordDir])
  assert.equal(miss.code, 2)
  assert.equal(miss.json.state, 'missing')
  assert.equal(miss.json.ran, false)
  assert.equal(runs(m), 0)
  // a FAILING record at the tip → refuse, no re-run (only STALE re-runs)
  const fl = fixture({ exitCode: 1 })
  fl.run(['ensure', '--json', '--stage', 'final', '--record-dir', fl.recordDir])
  const fr = fl.run(['gate', '--json', '--stage', 'final', '--record-dir', fl.recordDir])
  assert.equal(fr.code, 2)
  assert.equal(fr.json.ran, false)
  assert.equal(runs(fl), 1)
})

test('AC11 gate --rev names a branch other than the checkout: the record is taken at THAT tip (scratch worktree)', () => {
  const f = fixture()
  g(f.repo, 'checkout', '-q', '-b', 'feat/x')
  const featTip = commitFiles(f.repo, { 'feat.txt': 'f\n' }, 'feat')
  g(f.repo, 'checkout', '-q', 'main')
  const r = f.run(['ensure', '--json', '--stage', 'release', '--record-dir', f.recordDir, '--rev', 'feat/x'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.commit, featTip)
  assert.equal(r.json.ran_in, 'scratch')
  assert.equal(r.json.ref, 'feat/x')
  assert.equal(f.run(['check', '--json', '--stage', 'release', '--record-dir', f.recordDir, '--rev', 'feat/x']).code, 0)
  assert.equal(f.run(['check', '--json', '--stage', 'release', '--record-dir', f.recordDir, '--rev', 'main']).json.state, 'stale')
})

// ─── trust anchor (P6) ───────────────────────────────────────────────────────
test('P6 trust anchor: a hunt worktree that rewrites its own Test command to `true` is ignored — the MAIN checkout command is recorded', () => {
  const f = fixture({ exitCode: 1 })
  const wt = join(f.root, 'wt')
  g(f.repo, 'worktree', 'add', '-q', '-b', 'feat/cheat', wt)
  commitFiles(wt, { 'wolfpack-config.md': config('true') }, 'cheat: test command true')
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir, '--repo', wt])
  assert.equal(r.code, 2, r.stderr)
  assert.equal(r.json.command, 'bash t.sh')
  assert.equal(r.json.config, join(f.repo, 'wolfpack-config.md'))
  assert.equal(r.json.pass, false)
  assert.equal(r.json.commit, g(wt, 'rev-parse', 'HEAD'))
  assert.equal(r.json.ran_in, 'repo', 'the clean hunt worktree at its HEAD is the run location')
})

// ─── verdict command (P5) ────────────────────────────────────────────────────
test('P5 verdict command: suite exit 1 + a verdict that exits 0 → pass true, exit 1 kept, verdict_exit 0; placeholders substituted quoted', () => {
  // the verdict script checks it received the real log path / exit / main checkout (a path WITH a space)
  const V = `#!/usr/bin/env bash
[ -f "$1" ] || { echo "no log $1"; exit 3; }
[ "$2" = 1 ] || { echo "bad exit $2"; exit 4; }
[ -f "$3/wolfpack-config.md" ] || { echo "bad main $3"; exit 5; }
grep -q "stub: 3 passed, 1 failed" "$1" || { echo "log content wrong"; exit 6; }
echo "baseline only: verdict green"
`
  const f = fixture({ exitCode: 1, verdict: 'bash {main}/v.sh {log} {exit} {main}', extra: { 'v.sh': V } })
  const dir = join(f.root, 'plan dir with space')
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', dir])
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`)
  assert.equal(r.json.exit, 1)
  assert.equal(r.json.pass, true)
  assert.equal(r.json.verdict_exit, 0)
  assert.equal(r.json.verdict_summary, 'baseline only: verdict green')
  assert.equal(r.json.verdict_command, 'bash {main}/v.sh {log} {exit} {main}')
  assert.equal(r.json.reason, null)
  assert.equal(r.json.summary, 'stub: 3 passed, 1 failed')
})

test('P5 verdict command: a verdict that exits non-zero → pass false, reason "verdict command exit N" (even on a suite exit 0)', () => {
  const f = fixture({ exitCode: 0, verdict: 'echo "new failure: x"; exit 1' })
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(r.code, 2)
  assert.equal(r.json.exit, 0)
  assert.equal(r.json.pass, false)
  assert.equal(r.json.verdict_exit, 1)
  assert.equal(r.json.reason, 'verdict command exit 1')
  assert.equal(r.json.verdict_summary, 'new failure: x')
  // a recorded verdict command must match the configured one for reuse
  const again = f.run(['ensure', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(again.json.reused, true)
})

// ─── run location: dirty tree → scratch worktree ─────────────────────────────
test('dirty tracked tree → ran_in scratch, dirty lists the file, the record reflects the COMMIT; the scratch worktree is removed', () => {
  const f = fixture({ exitCode: 0 })
  put(f.repo, 'exit.txt', '1\n')   // uncommitted: would FAIL if the run saw it
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.ran_in, 'scratch')
  assert.deepEqual(r.json.dirty, ['exit.txt'])
  assert.equal(r.json.pass, true, 'the dirty edit is not seen')
  assert.equal(r.json.commit, g(f.repo, 'rev-parse', 'HEAD'))
  const wts = g(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree '))
  assert.equal(wts.length, 1, `scratch worktree left behind: ${wts}`)
  assert.equal(readFileSync(join(f.repo, 'exit.txt'), 'utf8'), '1\n', 'the checkout is untouched')
  // an UNTRACKED file does not force scratch
  const u = fixture()
  put(u.repo, 'untracked.txt', 'x')
  assert.equal(u.run(['run', '--json', '--stage', 'tracker', '--record-dir', u.recordDir]).json.ran_in, 'repo')
})

test('scratch worktree: configured Worktree links that exist in the main checkout are symlinked in', () => {
  const T = '#!/usr/bin/env bash\necho run >> "$COUNTER"\n[ -f venv/marker ] && echo "link ok: 1 passed" || { echo "no link: 1 failed"; exit 1; }\n'
  const f = fixture({ links: '`venv`, `absent-dir`', extra: { 't.sh': T } })
  put(f.repo, 'venv/marker', 'x')   // untracked, only in the main checkout
  g(f.repo, 'checkout', '-q', '-b', 'other')
  commitFiles(f.repo, { 'o.txt': 'o\n' }, 'other')
  g(f.repo, 'checkout', '-q', 'main')
  const r = f.run(['run', '--json', '--stage', 'release', '--record-dir', f.recordDir, '--rev', 'other'])
  assert.equal(r.json.ran_in, 'scratch', r.stderr)
  assert.equal(r.code, 0, readFileSync(r.json.log, 'utf8'))
  assert.equal(r.json.summary, 'link ok: 1 passed')
})

// ─── timeout + infra errors (exit 1, no record) ──────────────────────────────
test('timeout: a 1-second budget on `sleep 5` → timed_out, exit 124, pass false; the record is still written', () => {
  const f = fixture({ testCommand: 'echo start; sleep 5; echo never' })
  const t0 = Date.now()
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir, '--timeout-min', String(1 / 60)])
  assert.ok(Date.now() - t0 < 4500, 'killed well before sleep finished')
  assert.equal(r.code, 2, r.stderr)
  assert.equal(r.json.timed_out, true)
  assert.equal(r.json.exit, 124)
  assert.equal(r.json.pass, false)
  assert.match(r.json.reason, /^timed out after/)
  assert.equal(readFileSync(r.json.log, 'utf8'), 'start\n')
})

test('timeout knob: WOLFPACK_TEST_RECORD_TIMEOUT_MIN=0 / -1 / abc (and --timeout-min 0) → exit 1, no record', () => {
  const f = fixture()
  for (const v of ['0', '-1', 'abc']) {
    const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir], { WOLFPACK_TEST_RECORD_TIMEOUT_MIN: v })
    assert.equal(r.code, 1, v)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /WOLFPACK_TEST_RECORD_TIMEOUT_MIN/)
  }
  assert.equal(f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir, '--timeout-min', '0']).code, 1)
  assert.equal(existsSync(join(f.recordDir, 'test-record-tracker.json')), false)
  assert.equal(runs(f), 0)
})

test('infra: missing config / no Test command / not a repo / bad args / unresolvable rev → exit 1 and NO record file', () => {
  const f = fixture()
  g(f.repo, 'rm', '-q', 'wolfpack-config.md'); g(f.repo, 'commit', '-q', '-m', 'no config')
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(r.code, 1)
  assert.equal(r.json.ok, false)
  assert.equal(existsSync(join(f.recordDir, 'test-record-tracker.json')), false)
  const n = fixture({ testCommand: 'none' })
  const nr = n.run(['run', '--json', '--stage', 'tracker', '--record-dir', n.recordDir])
  assert.equal(nr.code, 1)
  assert.match(nr.json.error, /Test command/)
  const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'wptr-norepo-')))
  ROOTS.push(notRepo)
  const x = spawnSync(process.execPath, [CLI, 'run', '--json', '--stage', 'tracker', '--record-dir', join(notRepo, 'p'), '--repo', notRepo], { encoding: 'utf8' })
  assert.equal(x.status, 1)
  assert.match(JSON.parse(x.stdout).error, /not inside a git repository/)
  const ok = fixture()
  for (const args of [['bogus', '--stage', 'tracker', '--record-dir', ok.recordDir], ['run', '--stage', 'deploy', '--record-dir', ok.recordDir],
    ['run', '--stage', 'tracker'], ['run', '--stage', 'tracker', '--record-dir', ok.recordDir, '--wat'], ['run', '--stage', 'tracker', '--record-dir'],
    ['run', '--stage', 'tracker', '--record-dir', ok.recordDir, '--rev', 'no-such-branch']]) {
    const [cmd, ...rest] = args
    const a = ok.run([cmd, '--json', ...rest])   // --json first: a trailing flag must not be read as a value
    assert.equal(a.code, 1, args.join(' '))
    assert.equal(a.json && a.json.ok, false, args.join(' '))
  }
  assert.equal(runs(ok), 0)
  assert.equal(existsSync(ok.recordDir), false)
})

test('HEAD moved during the run → exit 1, no record, no log (never record a SHA the code may not match)', () => {
  // the "suite" commits on the branch mid-run
  const T = '#!/usr/bin/env bash\necho x > moved.txt\ngit add moved.txt\ngit commit -q -m moved\necho "1 passed"\n'
  const f = fixture({ extra: { 't.sh': T } })
  const r = f.run(['run', '--json', '--stage', 'tracker', '--record-dir', f.recordDir])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.json.error, /HEAD moved during the run/)
  assert.equal(existsSync(join(f.recordDir, 'test-record-tracker.json')), false)
  assert.equal(existsSync(join(f.recordDir, 'test-record-tracker.log')), false)
  assert.equal(existsSync(join(f.recordDir, 'test-record-tracker.log.partial')), false)
})

test('the pack config itself (Test verdict command: none) records testVerdictCommand null and the real test command', () => {
  // the record script reads the MAIN checkout config; the pack's reads `bash scripts/test-all.sh`
  const cfgText = readFileSync(join(here, '..', 'wolfpack-config.md'), 'utf8')
  assert.match(cfgText, /\*\*Test verdict command:\*\* none/)
})

// ─── AC11 / AC9: the merge commands and the Watchdog text carry the record step ─────────────
const doc = (rel) => readFileSync(join(here, '..', rel), 'utf8')
test('AC11 /merge: the test-record gate sits immediately before `git merge --no-ff $BRANCH` and aborts the merge on refusal', () => {
  const m = doc('.agents/commands/merge.md')
  const gate = m.indexOf('node "$PACK/scripts/wolfpack-test-record.mjs" gate --stage final --record-dir "$PLAN_DIR" --rev "$BRANCH"')
  const merge = m.indexOf('git merge --no-ff $BRANCH')
  assert.ok(gate > 0, 'the gate line')
  assert.ok(merge > gate, 'gate before the merge')
  assert.doesNotMatch(m.slice(gate, merge), /\n\s*git (?!checkout main)/, 'no other git step between the gate and the merge')
  assert.match(m.slice(gate, merge), /\|\| \{ echo "⛔ No passing test record at \$BRANCH's tip — not merging[^}]*git checkout main; exit 1; \}/)
  assert.match(m, /Never merge past a refused test-record gate or hand-edit `test-record-\*\.json`/)
})

test('AC11 /merge-wave: step 2a gates each hunt before its merge and stops the wave on refusal', () => {
  const m = doc('.agents/commands/merge-wave.md')
  const i = m.indexOf('2a. **Test-record gate**')
  assert.ok(i > 0)
  assert.ok(m.indexOf('wolfpack-test-record.mjs" gate --stage final', i) > i)
  assert.match(m.slice(i, i + 900), /STOP the wave at this hunt/)
  assert.ok(i < m.indexOf('\n3.', i), '2a precedes step 3 (the merge)')
})

test('AC11 /release-campaign: ensure --stage release at the campaign tip, then check right before the merge', () => {
  const m = doc('.agents/commands/release-campaign.md')
  const e = m.indexOf('ensure --stage release --record-dir ".wolfpack/campaigns/<slug>" --rev "campaign/<slug>"')
  const c = m.indexOf('check --stage release --record-dir ".wolfpack/campaigns/<slug>" --rev "campaign/<slug>"')
  assert.ok(e > 0 && c > e, 'ensure first, check later')
  assert.match(m, /do NOT print or run the merge commands/)
  assert.match(m, /without a passing `release` test record at its tip/)
})

test('AC9 Watchdog command + skill: SHA-equals-HEAD reuse rule; the Tracker skill names the pipeline record', () => {
  assert.match(doc('.agents/commands/watchdog.md'), /test-record-tracker\.json`\. When its `commit` equals `git rev-parse HEAD`, cite it and audit its log; do NOT re-run the full suite/)
  const wd = doc('.agents/skills/watchdog/SKILL.md')
  assert.match(wd, /### Pipeline test record/)
  assert.match(wd, /test-record-\*\.log/)
  assert.match(doc('.agents/skills/tracker/SKILL.md'), /test-record/)
})
