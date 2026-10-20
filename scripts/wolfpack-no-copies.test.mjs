#!/usr/bin/env node
// scripts/wolfpack-no-copies.test.mjs — the no-copies guard (pack-commands-canonical AC8).
// Run: node --test scripts/wolfpack-no-copies.test.mjs
//
// Every case builds throwaway git repos (a fixture pack + a fixture consumer) and drives the REAL
// CLI with --pack, plus the real wolfpack checkout in pack mode. Fixtures are generic: this is a
// public repo, so no consuming-project names here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'
import { CLASSES, packInventory, runGuard, main, SetupError } from './wolfpack-no-copies.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const CLI = join(here, 'wolfpack-no-copies.mjs')

const TMP = mkdtempSync(join(tmpdir(), 'wp-nocopies-'))
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))
let n = 0

const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

function repo(name) {
  const dir = join(TMP, `${name}-${n++}`)
  mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.email', 'test@example.invalid')
  g(dir, 'config', 'user.name', 'Test')
  g(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}
function put(dir, rel, text = `${rel}\n`) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), text)
}
function link(dir, rel, target) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  symlinkSync(target, join(dir, rel))
}
function commit(dir) {
  g(dir, 'add', '-A') // throwaway fixture repo inside a temp dir (never a real checkout)
  g(dir, 'commit', '-q', '--allow-empty', '-m', 'fixture')
}

// Fixture pack: two commands, one skill, the three .claude/<class> links.
function fixturePack({ links = true } = {}) {
  const p = repo('pack')
  put(p, '.agents/commands/hunt.md')
  put(p, '.agents/commands/merge.md')
  put(p, '.agents/skills/alpha/SKILL.md')
  put(p, '.agents/workflows/hunt-pipeline.js')
  if (links) for (const x of ['commands', 'skills', 'workflows']) link(p, `.claude/${x}`, `../.agents/${x}`)
  commit(p)
  return p
}
// A complete generic consumer config (the guard exits 2 on ANY reader problem, so it must read clean).
const CONFIG = (cmds) => `# Config

## Project Identity
- **Name:** demo
- **Test command:** \`make test\`
- **Worktree root:** \`.agents/worktrees\`
- **Project commands:** ${cmds}

## Hard Rules (agents will be fired for violating these)
1. Stage by name.

## Model Pool
### Family → model mapping
- judgment    → fam-a:big:high
- work-horse  → fam-a:small
- reviewer-a  → fam-b:1
- reviewer-b  → fam-c:2

## Deployment Notes
- Dev deploy command: none
`
function fixtureConsumer(files = {}, { commands = 'none', config = true } = {}) {
  const c = repo('consumer')
  if (config) put(c, 'wolfpack-config.md', CONFIG(commands))
  put(c, 'README.md')
  for (const [rel, text] of Object.entries(files)) put(c, rel, text)
  commit(c)
  return c
}
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const guard = (consumer, pack) => run(['--pack', pack, consumer])

const PACK = fixturePack()

test('(a) consumer tracks a pack command copy .claude/commands/hunt.md → exit 1, named, the installed-user-level fix', () => {
  const c = fixtureConsumer({ '.claude/commands/hunt.md': 'copy\n' })
  const r = guard(c, PACK)
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.claude\/commands\/hunt\.md — delete it — the pack's `\/hunt` is installed user-level \(`install\.sh`\)$/m)
  assert.match(r.out, /^✗ no-copies: 1 offending path\(s\) \(consumer\)$/m)
})

test('(a2) a non-allow-listed project command → exit 1 with the Project commands fix; allow-listed → exit 0', () => {
  const bad = fixtureConsumer({ '.claude/commands/foo.md': 'x\n' })
  const r = guard(bad, PACK)
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.claude\/commands\/foo\.md — delete it, or add `foo` to wolfpack-config\.md → Project Identity → Project commands$/m)
  const ok = fixtureConsumer({ '.claude/commands/foo.md': 'x\n', '.claude/commands/bar-2.md': 'x\n' }, { commands: '`foo`, `bar-2` — project skills' })
  const r2 = guard(ok, PACK)
  assert.equal(r2.code, 0, r2.out + r2.err)
  assert.equal(r2.out, '✓ no-copies: clean (consumer: commands, skills, workflows)\n')
})

test('(a3) a pack command under .agents/commands/ in a consumer → exit 1', () => {
  const c = fixtureConsumer({ '.agents/commands/merge.md': 'x\n' })
  const r = guard(c, PACK)
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.agents\/commands\/merge\.md — delete it — the pack's `\/merge` is installed user-level/m)
})

test('(a3b) non-.md files and nested paths under a commands dir are offending even when the stem is allow-listed', () => {
  const c = fixtureConsumer({
    '.claude/commands/foo.md': 'x\n',
    '.claude/commands/foo.txt': 'x\n',
    '.claude/commands/sub/foo.md': 'x\n',
  }, { commands: '`foo`' })
  const r = guard(c, PACK)
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.claude\/commands\/foo\.txt — /m)
  assert.match(r.out, /^✗ \.claude\/commands\/sub\/foo\.md — /m)
  assert.doesNotMatch(r.out, /^✗ \.claude\/commands\/foo\.md /m)
  assert.match(r.out, /2 offending path\(s\)/)
})

test('(a4) an allow-list naming a pack command (`hunt`) → exit 2, setup error on stderr', () => {
  const c = fixtureConsumer({ '.claude/commands/hunt.md': 'x\n' }, { commands: '`hunt`' })
  const r = guard(c, PACK)
  assert.equal(r.code, 2, r.out + r.err)
  assert.match(r.err, /Project commands names pack command `hunt`/)
  assert.equal(r.out, '')
})

test('(a5) a stale allow-list entry (no tracked <name>.md in either dir) → exit 1 naming the entry', () => {
  const c = fixtureConsumer({ '.claude/commands/foo.md': 'x\n' }, { commands: '`foo`, `gone`' })
  const r = guard(c, PACK)
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ wolfpack-config\.md — stale Project commands entry `gone` — /m)
  assert.match(r.out, /1 offending path\(s\)/)
  // an untracked file on disk does not count (the guard reads the index)
  put(c, '.claude/commands/gone.md', 'untracked\n')
  assert.equal(guard(c, PACK).code, 1)
})

test('(a6) an allow-listed `foo` tracked only as .agents/commands/foo.md → exit 0 (not stale)', () => {
  const c = fixtureConsumer({ '.agents/commands/foo.md': 'x\n' }, { commands: '`foo`' })
  const r = guard(c, PACK)
  assert.equal(r.code, 0, r.out + r.err)
})

test('(a7) an alias link at .claude/commands in a consumer → exit 1 with the alias-link fix', () => {
  const c = fixtureConsumer()
  link(c, '.claude/commands', '../somewhere/commands')
  commit(c)
  const r = guard(c, PACK)
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.claude\/commands — remove the alias link \(install\.sh links the pack user-level\)$/m)
})

test('(b) a pack skill copy → exit 1; a project skill → exit 0; a skills alias link → exit 1', () => {
  const bad = fixtureConsumer({ '.claude/skills/alpha/SKILL.md': 'x\n', '.agents/skills/alpha/refs/x.md': 'x\n' })
  const r = guard(bad, PACK)
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.claude\/skills\/alpha\/SKILL\.md — delete the copy — the pack skill `alpha` is installed user-level; rename it if it is a project skill$/m)
  assert.match(r.out, /^✗ \.agents\/skills\/alpha\/refs\/x\.md — /m)
  const ok = fixtureConsumer({ '.claude/skills/mine/SKILL.md': 'x\n', '.claude/skills/alpha-local/SKILL.md': 'x\n' })
  assert.equal(guard(ok, PACK).code, 0)
  const al = fixtureConsumer()
  link(al, '.agents/skills', '../x')
  commit(al)
  const r3 = guard(al, PACK)
  assert.equal(r3.code, 1, r3.out + r3.err)
  assert.match(r3.out, /^✗ \.agents\/skills — remove the alias link/m)
})

test('(c) a tracked workflow copy → exit 1; only .claude/workflows/README.md → exit 0; anything under .agents/workflows → exit 1', () => {
  const bad = fixtureConsumer({ '.claude/workflows/hunt-pipeline.js': 'x\n', '.claude/workflows/README.md': 'x\n' })
  const r = guard(bad, PACK)
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.claude\/workflows\/hunt-pipeline\.js — untrack it — workflow copies are generated by `install\.sh --consumer` and gitignored$/m)
  assert.doesNotMatch(r.out, /README/)
  assert.equal(guard(fixtureConsumer({ '.claude/workflows/README.md': 'x\n' }), PACK).code, 0)
  assert.equal(guard(fixtureConsumer({ '.agents/workflows/README.md': 'x\n' }), PACK).code, 1)
})

test('consumer output: one line per offending path, sorted by path, then the count line', () => {
  const c = fixtureConsumer({
    '.claude/workflows/x.js': 'x\n',
    '.claude/commands/merge.md': 'x\n',
    '.agents/skills/alpha/SKILL.md': 'x\n',
    '.claude/commands/hunt.md': 'x\n',
  })
  const r = guard(c, PACK)
  assert.equal(r.code, 1)
  const lines = r.out.trim().split('\n')
  const paths = lines.slice(0, -1).map(l => l.replace(/^✗ (\S+) — .*$/, '$1'))
  assert.deepEqual(paths, ['.agents/skills/alpha/SKILL.md', '.claude/commands/hunt.md', '.claude/commands/merge.md', '.claude/workflows/x.js'])
  assert.equal(lines.at(-1), '✗ no-copies: 4 offending path(s) (consumer)')
})

test('pack mode: the fixture pack with its three links → exit 0', () => {
  const r = run(['--pack', PACK, PACK])
  assert.equal(r.code, 0, r.out + r.err)
  assert.equal(r.out, '✓ no-copies: clean (pack: commands, skills, workflows)\n')
  // the repo argument defaults to the cwd's git toplevel (run from a subdirectory)
  const sub = run(['--pack', PACK], { cwd: join(PACK, '.agents', 'commands') })
  assert.equal(sub.code, 0, sub.out + sub.err)
  assert.match(sub.out, /\(pack: /)
})

test('pack mode: .claude/commands replaced by a directory of files → exit 1 naming each file and the link fix', () => {
  const p = fixturePack({ links: false })
  link(p, '.claude/skills', '../.agents/skills')
  link(p, '.claude/workflows', '../.agents/workflows')
  put(p, '.claude/commands/hunt.md', 'copy\n')
  put(p, '.claude/commands/merge.md', 'copy\n')
  commit(p)
  const r = run(['--pack', p, p])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.claude\/commands\/hunt\.md — track `\.claude\/commands` as the link `\.\.\/\.agents\/commands`/m)
  assert.match(r.out, /^✗ \.claude\/commands\/merge\.md — /m)
  assert.match(r.out, /2 offending path\(s\) \(pack\)/)
})

test('pack mode: a link to the wrong target, a missing link → exit 1', () => {
  const p = fixturePack({ links: false })
  link(p, '.claude/commands', '../.agents/skills') // wrong target
  link(p, '.claude/skills', '../.agents/skills')
  commit(p)                                      // .claude/workflows missing
  const r = run(['--pack', p, p])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /^✗ \.claude\/commands — track `\.claude\/commands` as the link `\.\.\/\.agents\/commands`/m)
  assert.match(r.out, /^✗ \.claude\/workflows — missing — track `\.claude\/workflows`/m)
  assert.doesNotMatch(r.out, /^✗ \.claude\/skills /m)
})

test('pack mode: an untracked-but-present correct link does not count (the guard reads the index)', () => {
  const p = fixturePack({ links: false })
  for (const x of ['commands', 'skills', 'workflows']) link(p, `.claude/${x}`, `../.agents/${x}`)
  // nothing committed for the links
  const r = run(['--pack', p, p])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /3 offending path\(s\) \(pack\)/)
})

test('the REAL wolfpack checkout (--pack default = the script\'s own repo) → exit 0 in pack mode', () => {
  const r = run([ROOT])
  assert.equal(r.code, 0, r.out + r.err)
  assert.equal(r.out, '✓ no-copies: clean (pack: commands, skills, workflows)\n')
  const r2 = run([], { cwd: here })
  assert.equal(r2.code, 0, r2.out + r2.err)
})

test('usage and setup errors → exit 2', () => {
  for (const args of [['--bogus'], ['-x'], ['a', 'b'], ['--pack'], ['--pack', '--x'], ['--pack=']]) {
    const r = run(args)
    assert.equal(r.code, 2, `${args}: ${r.out}${r.err}`)
    assert.match(r.err, /^usage: node <pack>\/scripts\/wolfpack-no-copies\.mjs/, String(args))
  }
  const notGit = join(TMP, 'plain'); mkdirSync(notGit, { recursive: true })
  const r = run(['--pack', PACK, notGit])
  assert.equal(r.code, 2)
  assert.match(r.err, /is not a git repository/)
  assert.equal(run(['--pack', PACK, join(TMP, 'nope')]).code, 2)
  assert.equal(run(['--pack', notGit, PACK]).code, 2, 'a --pack that is not a repo')
})

test('consumer without wolfpack-config.md → exit 2; a config reader problem → exit 2', () => {
  const c = fixtureConsumer({ '.claude/commands/hunt.md': 'x\n' }, { config: false })
  const r = guard(c, PACK)
  assert.equal(r.code, 2, r.out + r.err)
  assert.match(r.err, /has no wolfpack-config\.md/)
  const bad = fixtureConsumer({}, { commands: '`Bad_Name`' })
  const r2 = guard(bad, PACK)
  assert.equal(r2.code, 2, r2.out + r2.err)
  assert.match(r2.err, /Project Identity → Project commands: invalid name/)
})

test('CLASSES is exactly commands, skills, workflows (no script class — 4B appends it)', () => {
  assert.deepEqual(CLASSES.map(c => c.name), ['commands', 'skills', 'workflows'])
  for (const c of CLASSES) assert.equal(typeof c.check, 'function')
})

test('packInventory: command names = basenames of .agents/commands/*.md, skills = the 3rd path segment', () => {
  const inv = packInventory(PACK)
  assert.deepEqual([...inv.commands].sort(), ['hunt', 'merge'])
  assert.deepEqual([...inv.skills], ['alpha'])
  const real = packInventory(ROOT)
  for (const name of ['hunt', 'merge', 'release-campaign', 'smoke-wave']) assert.ok(real.commands.has(name), name)
  for (const name of ['alpha', 'tracker', 'watchdog']) assert.ok(real.skills.has(name), name)
})

test('runGuard / main as a module: mode picked from the repo (realpaths compared), SetupError for exit-2 conditions', () => {
  const linked = join(TMP, `pack-alias-${n++}`)
  symlinkSync(PACK, linked)
  assert.equal(runGuard({ repo: linked, pack: PACK }).mode, 'pack', 'a symlinked path to the pack is still the pack')
  assert.equal(runGuard({ repo: fixtureConsumer(), pack: PACK }).mode, 'consumer')
  assert.throws(() => runGuard({ repo: fixtureConsumer({}, { config: false }), pack: PACK }), SetupError)
  const out = []; const err = []
  assert.equal(main(['--pack', PACK, realpathSync(PACK)], { out: s => out.push(s), err: s => err.push(s) }), 0)
  assert.deepEqual(err, [])
  assert.match(out.join(''), /clean \(pack:/)
})

test('Deviation 4: a consumer config that only MISSES keys (no Test command) is not a guard setup error', () => {
  const c = fixtureConsumer({ '.claude/commands/foo.md': 'x\n' }, { commands: '`foo`' })
  writeFileSync(join(c, 'wolfpack-config.md'), CONFIG('`foo`').replace(/^- \*\*Test command:\*\*.*\n/m, ''))
  g(c, 'commit', '-q', '-am', 'drop the test command')
  const r = guard(c, PACK)
  assert.equal(r.code, 0, r.out + r.err)
})
