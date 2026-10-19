#!/usr/bin/env node
// scripts/wolfpack-config.test.mjs — the deterministic wolfpack-config.md reader (AC1).
// Run: node --test scripts/wolfpack-config.test.mjs
//
// (a) the REAL wolfpack-config.md of this repo resolves completely; (b) fixture texts pin
// the key contract (sections, fields, NONE, lists, Model Pool defects) and the CLI exit
// codes. Fixtures are generic: this is a public repo, so no consuming-project values here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  parseSections, field, code, list, isNone, modelPool, readConfig, loadConfig, problemLine,
} from './wolfpack-config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const CLI = join(here, 'wolfpack-config.mjs')
const REAL = join(ROOT, 'wolfpack-config.md')

const runCli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts })

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wp-config-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const writeCfg = (dir, text, name = 'wolfpack-config.md') => { const p = join(dir, name); writeFileSync(p, text); return p }

// A complete generic config; tests mutate it with String.replace.
const POOL = `## Model Pool
### Family → model mapping
- judgment    → fam-a:big:high     # planner
- work-horse  → fam-a:small        # light implementer
- reviewer-a  → fam-b:1            # first examiner
- reviewer-b  → fam-c:2
### Hard constraints
- reviewers never implement
`
const FULL = `# Config

## Project Identity
- **Name:** demo-project
- **Test command:** \`make test\` — narrow with \`make test ONLY=x\`
- **Worktree links:** \`.env\`, \`venv\`

## Hard Rules (agents will be fired for violating these)
1. Stage by name.

## Compliance Requirements (if any)
- **Compliance areas:** payments (card data)
- **Risk-surface paths:** \`app/payments/\`, \`app/ledger.py\`

${POOL}
## Deployment Notes
- Dev deploy command: \`make deploy-dev\`
- Changelog file: \`CHANGELOG.md\`
- Tag pattern: \`v[0-9]*\`
- Backlog file: \`TODO.md\`
`

// ─── (a) the real file ────────────────────────────────────────────────
test('AC1 (a): the REAL wolfpack-config.md resolves completely (missing/problems empty)', () => {
  const c = loadConfig(REAL)
  assert.deepEqual(c.missing, [])
  assert.deepEqual(c.problems, [])
  assert.match(c.name, /^wolfpack/)
  assert.equal(c.testCommand, 'bash scripts/test-all.sh')
  assert.equal(c.devDeployCommand, null, 'the pack is not deployed')
  assert.equal(c.changelogFile, 'CHANGELOG.md')
  assert.equal(c.tagPattern, 'v[0-9]*')
  assert.equal(c.backlogFile, 'TODO.md')
  assert.deepEqual(c.worktreeLinks, [])
  assert.equal(c.complianceAreas, null, 'tooling repo: no regulated area')
  assert.deepEqual(c.compliancePaths, [])
  assert.deepEqual(c.unknownRoles, [])
  assert.equal(c.path, resolve(REAL))
  for (const s of ['Project Identity', 'Hard Rules', 'Compliance Requirements', 'Model Pool', 'Module Map', 'Deployment Notes']) {
    assert.ok(c.sections.includes(s), `section ${s}`)
  }
})

test('AC1 (a): the real Hard Rules carry the public-repo + git rules', () => {
  const body = parseSections(readFileSync(REAL, 'utf8')).find(s => s.key === 'Hard Rules').body
  assert.match(body, /private identifiers/i)
  assert.match(body, /conventional commits/i)
  assert.match(body, /--no-ff/)
  assert.match(body, /origin/)
})

test('AC1 (a): the real Model Pool — pool families + models keyed by config spelling (deepEqual)', () => {
  const c = loadConfig(REAL)
  assert.deepEqual(c.pool, { judgment: 'claude', workHorse: 'claude', reviewerA: 'glm', reviewerB: 'mistral', coderAlt: 'glm' })
  assert.deepEqual(c.models, {
    judgment: 'claude:opus:high', 'work-horse': 'claude:opus:high', 'reviewer-a': 'glm:5.3',
    'reviewer-b': 'mistral:large-4', 'coder-alt': 'glm:5.3',
  })
})

test('AC1 (a): the CLI on the real file exits 0 and prints the same JSON', () => {
  const r = runCli(['--json', REAL])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  const j = JSON.parse(r.stdout)
  assert.equal(j.testCommand, 'bash scripts/test-all.sh')
  assert.deepEqual(j, JSON.parse(JSON.stringify(loadConfig(REAL))))
})

test('AC1 (a): the CLI default path is ./wolfpack-config.md of the CWD', () => {
  const r = runCli(['--json'], { cwd: ROOT })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).path, resolve(REAL))
})

test('the example template still parses with the documented keys (exit 0)', () => {
  const r = runCli(['--json', join(ROOT, 'wolfpack-config.example.md')])
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
})

// ─── (b) fixtures: the key contract ───────────────────────────────────
test('fixture: a complete config resolves every key', () => {
  const c = readConfig(FULL)
  assert.deepEqual(c.missing, [])
  assert.deepEqual(c.problems, [])
  assert.equal(c.name, 'demo-project')
  assert.equal(c.testCommand, 'make test', 'code() = the FIRST backtick span')
  assert.deepEqual(c.worktreeLinks, ['.env', 'venv'])
  assert.equal(c.complianceAreas, 'payments (card data)')
  assert.deepEqual(c.compliancePaths, ['app/payments/', 'app/ledger.py'])
  assert.equal(c.devDeployCommand, 'make deploy-dev')
  assert.deepEqual(c.pool, { judgment: 'fam-a', workHorse: 'fam-a', reviewerA: 'fam-b', reviewerB: 'fam-c' })
  assert.deepEqual(c.models, { judgment: 'fam-a:big:high', 'work-horse': 'fam-a:small', 'reviewer-a': 'fam-b:1', 'reviewer-b': 'fam-c:2' })
  assert.deepEqual(c.sections, ['Project Identity', 'Hard Rules', 'Compliance Requirements', 'Model Pool', 'Deployment Notes'])
})

test('fixture: a trailing-parenthetical heading resolves to the bare key', () => {
  const secs = parseSections('## Hard Rules (agents will be fired…)\nx\n## Compliance Requirements (if any)\ny\n')
  assert.deepEqual(secs.map(s => s.key), ['Hard Rules', 'Compliance Requirements'])
  assert.equal(secs[0].title, 'Hard Rules (agents will be fired…)')
  assert.equal(secs[0].body.trim(), 'x')
})

test('fixture: a `## ` line inside a fenced block does not split the section', () => {
  const secs = parseSections('## Deployment Notes\n```markdown\n## not a section\n- Dev deploy command: `go`\n```\n## Next\n')
  assert.deepEqual(secs.map(s => s.key), ['Deployment Notes', 'Next'])
  assert.equal(field(secs[0].body, 'Dev deploy command'), '`go`')
})

test('fixture: field() — bold and plain, case-insensitive, first match wins', () => {
  const body = '- **Test Command:** `a`\n- test command: `b`\n-   Name: n'
  assert.equal(field(body, 'test command'), '`a`')
  assert.equal(field(body, 'name'), 'n')
  assert.equal(field(body, 'absent'), undefined)
  assert.equal(field(undefined, 'x'), undefined)
  // a regex metacharacter in the name is literal
  assert.equal(field('- Risk-surface paths: `p/`', 'Risk-surface paths'), '`p/`')
  assert.equal(field('- Deploy command (dev): none', 'Deploy command (dev)'), 'none')
})

test('fixture: NONE — empty, none, n/a, "none — x", "none." → null / []', () => {
  for (const v of ['', '   ', 'none', 'None', '`none`', 'n/a', 'N/A', 'none — tooling repo', 'none—x', 'none.', 'none, nothing', undefined, null]) {
    assert.equal(isNone(v), true, JSON.stringify(v))
    assert.deepEqual(list(v), [], JSON.stringify(v))
  }
  for (const v of ['nonexistent-cmd', 'nonee', '`make`', 'a none b']) assert.equal(isNone(v), false, v)
  const c = readConfig(FULL.replace('- Dev deploy command: `make deploy-dev`', '- Dev deploy command: none — nothing is deployed'))
  assert.equal(c.devDeployCommand, null)
  assert.deepEqual(c.missing, [], 'an optional key may be none')
})

test('fixture: code() and list() — backtick spans, bare comma fallback', () => {
  assert.equal(code('`a b` then `c`'), 'a b')
  assert.equal(code('  plain  '), 'plain')
  assert.deepEqual(list('`x/`, `y.py` and `z`'), ['x/', 'y.py', 'z'])
  assert.deepEqual(list('a, b ,c'), ['a', 'b', 'c'])
})

test('fixture: a missing Test command → missing names testCommand; CLI exits 2 with the ✗ line, JSON still printed', () => {
  const text = FULL.replace(/- \*\*Test command:\*\*.*\n/, '')
  assert.deepEqual(readConfig(text).missing, ['testCommand'])
  withTemp((dir) => {
    const r = runCli(['--json', writeCfg(dir, text)])
    assert.equal(r.status, 2)
    assert.deepEqual(JSON.parse(r.stdout).missing, ['testCommand'])
    assert.match(r.stderr, /✗ wolfpack-config: missing testCommand/)
  })
})

test('fixture: Test command "none" counts as missing (required key)', () => {
  const c = readConfig(FULL.replace(/(- \*\*Test command:\*\*).*\n/, '$1 none\n'))
  assert.deepEqual(c.missing, ['testCommand'])
  assert.equal(c.testCommand, null)
})

test('fixture: Compliance areas / Risk-surface paths are REQUIRED but may be none', () => {
  const none = readConfig(FULL.replace('payments (card data)', 'none').replace('`app/payments/`, `app/ledger.py`', 'none'))
  assert.deepEqual(none.missing, [])
  assert.equal(none.complianceAreas, null)
  assert.deepEqual(none.compliancePaths, [])
  const absent = readConfig(FULL.replace(/- \*\*Compliance areas:\*\*.*\n/, '').replace(/- \*\*Risk-surface paths:\*\*.*\n/, ''))
  assert.deepEqual(absent.missing, ['complianceAreas', 'compliancePaths'])
})

test('fixture: Worktree links absent → [] (optional, not missing)', () => {
  const c = readConfig(FULL.replace(/- \*\*Worktree links:\*\*.*\n/, ''))
  assert.deepEqual(c.worktreeLinks, [])
  assert.deepEqual(c.missing, [])
})

test('fixture: an unknown pool role is reported in unknownRoles, not an error', () => {
  const c = readConfig(FULL.replace('- reviewer-b  → fam-c:2', '- reviewer-b  → fam-c:2\n- reviewer-z  → fam-d:9'))
  assert.deepEqual(c.unknownRoles, ['reviewer-z'])
  assert.deepEqual(c.problems, [])
  assert.ok(c.pool && !('reviewerZ' in c.pool))
})

test('fixture: `->` is accepted as the arrow; reviewer-c and coder-alt map to camelCase', () => {
  const c = readConfig(FULL.replace('- reviewer-b  → fam-c:2', '- reviewer-c -> Fam-E:3\n- coder-alt -> fam-b:1'))
  assert.equal(c.pool.reviewerC, 'fam-e', 'family lowercased')
  assert.equal(c.pool.coderAlt, 'fam-b')
  assert.equal(c.models['reviewer-c'], 'Fam-E:3', 'model token kept verbatim')
})

for (const role of ['judgment', 'reviewer-a']) {
  test(`fixture: a pool with no ${role} line → Model Pool problem, pool/models null, missing untouched, CLI exit 2`, () => {
    const text = FULL.replace(new RegExp(`- ${role} .*\\n`), '')
    const c = readConfig(text)
    assert.deepEqual(c.problems, [`Model Pool: missing required role(s) ${role}`])
    assert.equal(c.pool, null)
    assert.equal(c.models, null)
    assert.deepEqual(c.missing, [], 'pool defects never land in missing')
    withTemp((dir) => {
      const r = runCli(['--json', writeCfg(dir, text)])
      assert.equal(r.status, 2)
      assert.match(r.stderr, new RegExp(`Model Pool: missing required role\\(s\\) ${role}`))
      assert.equal(JSON.parse(r.stdout).pool, null)
    })
  })
}

test('fixture: both required roles absent → ONE problem naming exactly both', () => {
  const c = readConfig(FULL.replace(/- judgment .*\n/, '').replace(/- reviewer-a .*\n/, ''))
  assert.deepEqual(c.problems, ['Model Pool: missing required role(s) judgment, reviewer-a'])
})

test('fixture: no ## Model Pool section → "Model Pool: section absent", pool null, CLI exit 2', () => {
  const text = FULL.replace(POOL, '')
  const c = readConfig(text)
  assert.deepEqual(c.problems, ['Model Pool: section absent'])
  assert.equal(c.pool, null)
  assert.deepEqual(c.missing, [])
  withTemp((dir) => assert.equal(runCli(['--json', writeCfg(dir, text)]).status, 2))
})

test('fixture: an empty model token (or only a comment) is a Model Pool problem — never a partial pool', () => {
  for (const repl of ['- judgment    →', '- judgment    →    # planner']) {
    const c = readConfig(FULL.replace(/- judgment .*/, repl))
    assert.deepEqual(c.problems, ['Model Pool: empty model token for role(s) judgment'], repl)
    assert.equal(c.pool, null, repl)
    assert.equal(c.models, null, repl)
  }
})

test('fixture: a duplicated role line is a Model Pool problem', () => {
  const c = readConfig(FULL.replace('- reviewer-b  → fam-c:2', '- reviewer-b  → fam-c:2\n- reviewer-a  → fam-x:1'))
  assert.deepEqual(c.problems, ['Model Pool: duplicate line(s) for role(s) reviewer-a'])
  assert.equal(c.pool, null)
})

test('modelPool(undefined) = section absent; problemLine joins missing + problems', () => {
  assert.deepEqual(modelPool(undefined).problems, ['Model Pool: section absent'])
  assert.equal(problemLine({ missing: [], problems: [] }), '')
  assert.equal(problemLine({ missing: ['name', 'testCommand'], problems: ['Model Pool: section absent'] }),
    '✗ wolfpack-config: missing name, testCommand; Model Pool: section absent')
})

// ─── CLI contract ─────────────────────────────────────────────────────
test('CLI: an absent file → exit 2 with the not-found message (and loadConfig throws it)', () => {
  withTemp((dir) => {
    const p = join(dir, 'nope', 'wolfpack-config.md')
    const r = runCli(['--json', p])
    assert.equal(r.status, 2)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /wolfpack-config\.md not found at .*nope.*copy wolfpack-config\.example\.md/)
    assert.throws(() => loadConfig(p), /not found at/)
  })
})

test('CLI: an unknown flag or two paths → usage, exit 2', () => {
  for (const args of [['--bogus'], ['-j'], ['a.md', 'b.md']]) {
    const r = runCli(args)
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, /^usage: node scripts\/wolfpack-config\.mjs/)
  }
})

test('CLI bare mode: a human summary (not JSON), same exit codes', () => {
  withTemp((dir) => {
    const ok = runCli([writeCfg(dir, FULL)])
    assert.equal(ok.status, 0, ok.stderr)
    assert.throws(() => JSON.parse(ok.stdout))
    assert.match(ok.stdout, /^name: demo-project$/m)
    assert.match(ok.stdout, /^testCommand: make test$/m)
    assert.match(ok.stdout, /^devDeployCommand: make deploy-dev$/m)
    assert.match(ok.stdout, /^pool judgment → fam-a:big:high$/m)
    const bad = runCli([writeCfg(dir, FULL.replace(POOL, ''), 'bad.md')])
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /^problems: Model Pool: section absent$/m)
    assert.match(bad.stdout, /^devDeployCommand: make deploy-dev$/m)
    assert.match(bad.stderr, /✗ wolfpack-config: Model Pool: section absent/)
  })
})
