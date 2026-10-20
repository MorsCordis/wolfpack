#!/usr/bin/env node
// scripts/wolfpack-install-vibe-agents.test.mjs — the tracked Vibe seat templates and their
// installer (seat-profiles-into-pack AC1, AC2, AC3).
// Run: node --test scripts/wolfpack-install-vibe-agents.test.mjs
//
// AC1: the ten pack seat profiles are tracked under vibe-agents/, with no project leak.
// AC2: review/certify seats grant bash (git_bash mirrors it) and write_file (seat-handoff-writes:
//      the handoff file, confined to the shim's out dir by mount); edit/task stay never;
//      the as-is seats (alpha, shepherd, tracker) and shepherd-glm keep today's permissions.
// AC3: the installer is idempotent, backs up what it replaces, reports each file, has a
//      --check that writes nothing, and never touches a non-pack file. Every AC3 case runs
//      against a temp dir (--dest, or WOLFPACK_VIBE_AGENTS_DIR) — never the host's ~/.vibe.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { run, templatesDir, defaultDest, listTemplates } from './wolfpack-install-vibe-agents.mjs'
import { parseSeatProfile } from './wolfpack-toolcheck.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const TPL = templatesDir()
const INSTALLER = join(here, 'wolfpack-install-vibe-agents.mjs')

const SEATS = ['alpha', 'bloodhound', 'bloodhound-glm', 'pointer', 'pointer-glm', 'shepherd', 'shepherd-glm',
  'tracker', 'watchdog', 'watchdog-glm']
const NAMES = SEATS.map(s => `wolfpack-${s}.toml`).sort()
const REVIEW_SEATS = ['bloodhound', 'bloodhound-glm', 'pointer', 'pointer-glm', 'watchdog', 'watchdog-glm']

const perms = (name) => {
  const r = parseSeatProfile(readFileSync(join(TPL, name), 'utf8'))
  assert.deepEqual(r.problems, [], `${name}: ${r.problems.join('; ')}`)
  return r.tools
}
const tmp = (tag) => mkdtempSync(join(tmpdir(), `vibe-agents-${tag}-`))
// Snapshot of a dir: { name: bytes(base64) } for every entry (temp files would show up too).
const snap = (dir) => Object.fromEntries(readdirSync(dir).sort().map(n => [n, readFileSync(join(dir, n)).toString('base64')]))
const cli = (args, env = {}) => spawnSync(process.execPath, [INSTALLER, ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } })

// ─── AC1 ───────────────────────────────────────────────────────

test('AC1: vibe-agents/ holds exactly the ten Wolfpack seat profiles, and git tracks all ten', (t) => {
  assert.deepEqual(listTemplates(TPL), NAMES)
  let tracked
  try {
    tracked = execFileSync('git', ['-C', repoRoot, 'ls-files', 'vibe-agents/'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(p => p.replace(/^vibe-agents\//, '')).sort()
  } catch (e) {
    t.diagnostic(`git unavailable (${e.message}) — fell back to the directory listing`)
    return
  }
  assert.deepEqual(tracked, NAMES, 'every template is committed (no .bak, no stray file)')
})

test('AC1: no template leaks a project path, ID, domain or name', () => {
  const NAME = 'paw' + 'pims'   // the first consuming project's name, assembled so no script spells it
  const leak = new RegExp(NAME + '\\.(dev|vet)|pawprints-|\\/home\\/[a-z]+|logcabincoding')   // leak-grep:allow
  for (const n of NAMES) {
    const text = readFileSync(join(TPL, n), 'utf8')
    assert.doesNotMatch(text, leak, n)
    assert.doesNotMatch(text, new RegExp(NAME, 'i'), n)
    assert.match(text.split('\n')[0], /^# Tracked template — install with scripts\/wolfpack-install-vibe-agents\.mjs; do not hand-edit the installed copy\.$/, `${n}: header`)
  }
})

// ─── AC2 ───────────────────────────────────────────────────────

test('AC2: the six review/certify seats grant bash + git_bash + write_file; edit/task stay never', () => {
  for (const s of REVIEW_SEATS) {
    const p = perms(`wolfpack-${s}.toml`)
    assert.equal(p.bash, 'always', `${s}: bash`)
    assert.equal(p.git_bash, 'always', `${s}: git_bash`)
    assert.equal(p.edit, 'never', `${s}: edit`)
    assert.equal(p.write_file, 'always', `${s}: write_file (handoff file, confined to the shim out dir)`)
    assert.equal(p.task, 'never', `${s}: task`)
    assert.equal(p.read_file, 'always', `${s}: read_file`)
    assert.equal(p.grep, 'always', `${s}: grep`)
    // nothing is "ask": a headless vibe -p run denies (or hangs on) every ask
    assert.ok(!Object.values(p).includes('ask'), `${s}: no "ask" permission`)
  }
  // "Bloodhound keeps task off" — explicitly, both families
  assert.equal(perms('wolfpack-bloodhound.toml').task, 'never')
  assert.equal(perms('wolfpack-bloodhound-glm.toml').task, 'never')
})

test('AC2: GLM review seats keep the dev_cortex tools; Mistral review seats drop the dead skill/task grants', () => {
  for (const s of ['bloodhound-glm', 'pointer-glm', 'watchdog-glm']) {
    const p = perms(`wolfpack-${s}.toml`)
    assert.equal(p.dev_cortex_repo_map, 'always', s)
    assert.equal(p.dev_cortex_file_outline, 'always', s)
    assert.match(readFileSync(join(TPL, `wolfpack-${s}.toml`), 'utf8'), /^active_model = "glm-5\.3"/m, `${s}: model id kept`)
  }
  for (const s of ['bloodhound', 'pointer', 'watchdog']) {
    const p = perms(`wolfpack-${s}.toml`)
    assert.equal(p.skill, 'never', s)
    const text = readFileSync(join(TPL, `wolfpack-${s}.toml`), 'utf8')
    assert.doesNotMatch(text, /^\s*allowlist\s*=/m, `${s}: the explore allowlist is gone`)
    assert.doesNotMatch(text, /^\[tools\.read\]$/m, `${s}: the legacy [tools.read] alias is gone`)
    assert.match(text, /^active_model = "mistral-large-4"/m, `${s}: model id kept`)
  }
})

test('AC2: shepherd-glm stays shell-free; alpha/shepherd/tracker are tracked with today\'s permissions unchanged', () => {
  assert.deepEqual(perms('wolfpack-shepherd-glm.toml'), {
    read_file: 'always', grep: 'always', write_file: 'always', edit: 'always',
    dev_cortex_repo_map: 'always', dev_cortex_file_outline: 'always', bash: 'never', git_bash: 'never', task: 'never',
  })
  // snapshot of the live profiles' permission maps on 2026-10-18 (pre-install)
  assert.deepEqual(perms('wolfpack-alpha.toml'), {
    read_file: 'always', grep: 'always', skill: 'always', task: 'always', write_file: 'ask', edit: 'never', bash: 'never', git_bash: 'never',
  })
  assert.deepEqual(perms('wolfpack-shepherd.toml'), {
    read_file: 'always', grep: 'always', skill: 'always', write_file: 'ask', edit: 'ask', bash: 'never', git_bash: 'ask',
  })
  assert.deepEqual(perms('wolfpack-tracker.toml'), {
    read_file: 'always', grep: 'always', skill: 'always', write_file: 'ask', edit: 'ask', bash: 'ask', git_bash: 'ask',
  })
})

// ─── AC3 ───────────────────────────────────────────────────────

test('AC3: defaultDest — WOLFPACK_VIBE_AGENTS_DIR, else $HOME/.vibe/agents-headless', () => {
  assert.equal(defaultDest({ WOLFPACK_VIBE_AGENTS_DIR: '/o', HOME: '/h' }), '/o')
  assert.equal(defaultDest({ HOME: '/h' }), join('/h', '.vibe', 'agents-headless'))
})

test('AC3: install → re-run → drift → --check → replace → --check, with non-pack files untouched throughout', () => {
  const root = tmp('flow')
  const dest = join(root, 'agents-headless')   // does not exist yet: install creates it
  try {
    // 1. install into an empty (absent) dir → 10 installed, bytes equal the templates
    let r = cli(['--dest', dest])
    assert.equal(r.status, 0, r.stderr)
    for (const n of NAMES) {
      assert.match(r.stdout, new RegExp(`^installed  ${n}$`, 'm'))
      assert.equal(Buffer.compare(readFileSync(join(dest, n)), readFileSync(join(TPL, n))), 0, n)
      assert.equal(statSync(join(dest, n)).mode & 0o777, 0o644, `${n}: mode 0644`)
    }
    assert.match(r.stdout, /^10 installed, 0 unchanged, 0 replaced/m)
    assert.deepEqual(readdirSync(dest).sort(), NAMES, 'no temp files left behind')

    // seed a non-pack profile and an old backup — they must survive every later step byte-identical
    writeFileSync(join(dest, 'gemma-main.toml'), 'active_model = "gemma"\n[tools.bash]\npermission = "never"\n')
    writeFileSync(join(dest, 'wolfpack-alpha.toml.bak-x'), 'old alpha bytes\n')
    const foreign = () => ({ g: readFileSync(join(dest, 'gemma-main.toml'), 'utf8'), b: readFileSync(join(dest, 'wolfpack-alpha.toml.bak-x'), 'utf8') })
    const foreign0 = foreign()

    // 2. re-run → 10 unchanged, no new files
    const before = snap(dest)
    r = cli(['--dest', dest])
    assert.equal(r.status, 0, r.stderr)
    for (const n of NAMES) assert.match(r.stdout, new RegExp(`^unchanged  ${n}$`, 'm'))
    assert.match(r.stdout, /^0 installed, 10 unchanged, 0 replaced/m)
    assert.deepEqual(snap(dest), before, 'an idempotent re-run changes nothing')
    assert.doesNotMatch(r.stdout, /gemma-main|bak-x/, 'non-pack files are not even reported')

    // 3. hand-edit one installed copy (the original bug) → --check exits 1, names it, writes nothing
    const target = join(dest, 'wolfpack-pointer-glm.toml')
    const edited = readFileSync(target, 'utf8').replace(/\[tools\.bash\]\npermission = "always"/, '[tools.bash]\npermission = "never"')
    assert.notEqual(edited, readFileSync(target, 'utf8'), 'fixture mutation applied')
    writeFileSync(target, edited)
    const drifted = snap(dest)
    r = cli(['--check', '--dest', dest])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^drift      wolfpack-pointer-glm\.toml$/m)
    for (const n of NAMES.filter(x => x !== 'wolfpack-pointer-glm.toml')) assert.match(r.stdout, new RegExp(`^in sync    ${n}$`, 'm'))
    assert.match(r.stdout, /^9 in sync, 0 missing, 1 drift/m)
    assert.deepEqual(snap(dest), drifted, '--check changed no file and created no backup')

    // 4. install → replaced + a backup holding the OLD (hand-edited) bytes
    r = cli(['--dest', dest])
    assert.equal(r.status, 0, r.stderr)
    const m = r.stdout.match(/^replaced   wolfpack-pointer-glm\.toml  \(backup: (wolfpack-pointer-glm\.toml\.bak-\d{8}T\d{6})\)$/m)
    assert.ok(m, r.stdout)
    assert.equal(readFileSync(join(dest, m[1]), 'utf8'), edited, 'the backup holds what was replaced')
    assert.equal(Buffer.compare(readFileSync(target), readFileSync(join(TPL, 'wolfpack-pointer-glm.toml'))), 0)
    assert.match(r.stdout, /^0 installed, 9 unchanged, 1 replaced/m)

    // 5. --check → exit 0 (backups are not templates, so they are not "unmanaged" either)
    r = cli(['--check', '--dest', dest])
    assert.equal(r.status, 0, r.stdout)
    assert.match(r.stdout, /^10 in sync, 0 missing, 0 drift/m)
    assert.doesNotMatch(r.stdout, /unmanaged/)

    assert.deepEqual(foreign(), foreign0, 'non-pack profile and old .bak file byte-identical after every step')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('AC3: a second replace in the same second gets a -2 backup (never overwrites a backup)', () => {
  const dest = tmp('collide')
  try {
    assert.equal(run({ dest }).exitCode, 0)
    const target = join(dest, 'wolfpack-watchdog.toml')
    writeFileSync(target, 'v1\n')
    const r1 = run({ dest })
    const b1 = r1.lines.join('\n').match(/backup: (\S+)\)/)[1]
    writeFileSync(target, 'v2\n')
    const r2 = run({ dest })
    const b2 = r2.lines.join('\n').match(/backup: (\S+)\)/)[1]
    assert.notEqual(b1, b2)
    assert.equal(readFileSync(join(dest, b1), 'utf8'), 'v1\n')
    assert.equal(readFileSync(join(dest, b2), 'utf8'), 'v2\n')
    if (b2.startsWith(b1)) assert.match(b2, /-2$/, 'same-second collision → -2 suffix')
  } finally { rmSync(dest, { recursive: true, force: true }) }
})

test('AC3: WOLFPACK_VIBE_AGENTS_DIR is the destination when --dest is absent', () => {
  const dest = tmp('envdest')
  try {
    let r = cli([], { WOLFPACK_VIBE_AGENTS_DIR: dest, HOME: join(dest, 'no-home') })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readdirSync(dest).sort(), NAMES)
    assert.equal(existsSync(join(dest, 'no-home')), false, 'HOME was not used')
    r = cli(['--check'], { WOLFPACK_VIBE_AGENTS_DIR: dest })
    assert.equal(r.status, 0)
  } finally { rmSync(dest, { recursive: true, force: true }) }
})

test('AC3: --check on a missing/partial install → exit 1 "missing", and it creates nothing', () => {
  const root = tmp('check')
  try {
    const absent = join(root, 'absent')
    let r = cli(['--check', '--dest', absent])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^0 in sync, 10 missing, 0 drift/m)
    assert.equal(existsSync(absent), false, '--check never creates the dest dir')
    const partial = join(root, 'partial')
    mkdirSync(partial)
    copyFileSync(join(TPL, 'wolfpack-alpha.toml'), join(partial, 'wolfpack-alpha.toml'))
    r = cli(['--check', '--dest', partial])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^in sync    wolfpack-alpha\.toml$/m)
    assert.match(r.stdout, /^missing    wolfpack-pointer\.toml$/m)
    assert.deepEqual(readdirSync(partial), ['wolfpack-alpha.toml'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('AC3: an extra wolfpack-*.toml with no template is reported "unmanaged" and left untouched (both modes)', () => {
  const dest = tmp('unmanaged')
  try {
    writeFileSync(join(dest, 'wolfpack-zzz.toml'), 'mine\n')
    let r = cli(['--dest', dest])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^unmanaged  wolfpack-zzz\.toml \(left as is\)$/m)
    r = cli(['--check', '--dest', dest])
    assert.equal(r.status, 0, 'unmanaged files are not drift')
    assert.match(r.stdout, /^unmanaged  wolfpack-zzz\.toml \(left as is\)$/m)
    assert.equal(readFileSync(join(dest, 'wolfpack-zzz.toml'), 'utf8'), 'mine\n')
  } finally { rmSync(dest, { recursive: true, force: true }) }
})

test('AC3: a missing or empty templates dir → exit 2 (in-process run())', () => {
  const root = tmp('notpl')
  try {
    const r = run({ dest: join(root, 'd'), srcDir: join(root, 'no-templates') })
    assert.equal(r.exitCode, 2)
    assert.match(r.lines[0], /no seat templates found/)
    assert.equal(existsSync(join(root, 'd')), false, 'nothing installed')
    mkdirSync(join(root, 'empty'))
    writeFileSync(join(root, 'empty', 'README'), 'x')
    assert.equal(run({ dest: join(root, 'd'), srcDir: join(root, 'empty') }).exitCode, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('AC3: a filesystem error → exit 2 naming the path; a bad argument → exit 2', () => {
  const root = tmp('fserr')
  try {
    const file = join(root, 'not-a-dir')
    writeFileSync(file, 'x')
    const r = cli(['--dest', join(file, 'sub')])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /not-a-dir/)
    assert.equal(cli(['--bogus']).status, 2)
    assert.equal(cli(['--dest']).status, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
