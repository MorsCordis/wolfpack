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
  expandHome, execLayer, execLines, imageHasTag, EXEC_KEYS,
} from './wolfpack-config.mjs'
import { homedir } from 'node:os'

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

// ─── exec-layer-into-pack: Project Identity → Wolfpack home + ## Execution Layer ──────────
const HOME_DIR = homedir()
const withHome = (line) => FULL.replace('- **Worktree links:**', `${line}\n- **Worktree links:**`)
const EXEC = `## Execution Layer
- **Sandbox image:** \`demo-sandbox:latest\` — prose after the value
- **GLM image:** \`demo-sandbox-glm:v2\`
- **Sandbox project layer:** \`containers/Layer.demo\` — a relative path
- **Seat extra mounts:** \`/opt/ref\` \`~/data:/data\`
- **Sandbox extra mounts:** \`~/.config/tool\`
- **Secrets paths:** \`~/.secrets\` \`/etc/demo-keys\`
- **Vibe agent dir:** \`~/.vibe/agents-headless\`
- **Seat test env:** \`APP_KEY=test-only\` \`EMPTY=\`
`
const withExec = (exec = EXEC) => `${FULL}\n${exec}`
const execWith = (key, value) => EXEC.replace(new RegExp(`^- \\*\\*${key}:\\*\\*.*$`, 'm'), `- **${key}:** ${value}`)
const execWithout = (key) => EXEC.replace(new RegExp(`^- \\*\\*${key}:\\*\\*.*\\n`, 'm'), '')

test('Wolfpack home: absent / none → null, no problem; ~ and ~/x expand; absolute kept; relative → problem', () => {
  assert.equal(readConfig(FULL).wolfpackHome, null)
  assert.deepEqual(readConfig(FULL).problems, [])
  for (const v of ['none', '`none`', 'none — every run exports it', 'n/a']) {
    const c = readConfig(withHome(`- **Wolfpack home:** ${v}`))
    assert.equal(c.wolfpackHome, null, v)
    assert.deepEqual(c.problems, [], v)
  }
  assert.equal(readConfig(withHome('- **Wolfpack home:** `~/src/pack` — prose with `ticks`')).wolfpackHome, join(HOME_DIR, 'src/pack'))
  assert.equal(readConfig(withHome('- **Wolfpack home:** `~`')).wolfpackHome, HOME_DIR)
  assert.equal(readConfig(withHome('- Wolfpack home: /opt/pack')).wolfpackHome, '/opt/pack')
  assert.equal(readConfig(withHome('- **Wolfpack home:** `/opt/pack`')).wolfpackHome, '/opt/pack')
  for (const v of ['`src/pack`', '`./pack`', '`~user/pack`', '`/opt/pack` ', '`pack`']) {
    const c = readConfig(withHome(`- **Wolfpack home:** ${v}`))
    if (v.startsWith('`/')) { assert.equal(c.wolfpackHome, '/opt/pack'); continue }
    assert.equal(c.wolfpackHome, null, v)
    assert.ok(c.problems.includes('Project Identity → Wolfpack home must be an absolute path or ~/…'), `${v}: ${c.problems}`)
  }
  // only Project Identity counts
  const elsewhere = FULL.replace('## Deployment Notes\n', '## Deployment Notes\n- **Wolfpack home:** `/opt/other`\n')
  assert.equal(readConfig(elsewhere).wolfpackHome, null)
})

test('expandHome: ~ and ~/… only; anything else unchanged', () => {
  assert.equal(expandHome('~'), HOME_DIR)
  assert.equal(expandHome('~/a/b'), `${HOME_DIR}/a/b`)
  assert.equal(expandHome('~user/a'), '~user/a')
  assert.equal(expandHome('/x/~/y'), '/x/~/y')
  assert.equal(expandHome('rel'), 'rel')
  assert.equal(expandHome(undefined), undefined)
})

test('imageHasTag: a tag after the last / only (registry ports are not tags)', () => {
  for (const ok of ['a:latest', 'reg.io/a/b:v1', 'localhost:5000/a:1.2']) assert.equal(imageHasTag(ok), true, ok)
  for (const bad of ['a', 'localhost:5000/a', 'a:', ':x', 'reg:5000/a/b']) assert.equal(imageHasTag(bad), false, bad)
})

test('Execution Layer absent: exit-0 config, every shim-required key in exec.missing, nothing in the top-level missing/problems', () => {
  const c = readConfig(FULL)
  assert.deepEqual(c.missing, [])
  assert.deepEqual(c.problems, [])
  assert.deepEqual(c.exec.missing, ['Sandbox image', 'GLM image', 'Sandbox project layer', 'Seat extra mounts', 'Secrets paths', 'Vibe agent dir'])
  assert.deepEqual(c.exec.missing, EXEC_KEYS.filter(k => k[2]).map(k => k[0]), 'exactly the shim-required keys, as written')
  withTemp((dir) => {
    const r = runCli([writeCfg(dir, FULL)])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^exec: missing Sandbox image, GLM image, Sandbox project layer, Seat extra mounts, Secrets paths, Vibe agent dir$/m)
    assert.match(r.stdout, /^wolfpackHome: none$/m)
  })
})

test('Execution Layer: every key parses (~ expansion, layer resolved against the config dir, list syntax, prose ignored)', () => {
  const c = readConfig(withExec(), { configDir: '/cfg/dir' })
  assert.deepEqual(c.problems, [])
  assert.deepEqual(c.exec.missing, [])
  assert.deepEqual(c.exec.problems, [])
  const e = c.exec
  assert.equal(e.sandboxImage, 'demo-sandbox:latest')
  assert.equal(e.glmImage, 'demo-sandbox-glm:v2')
  assert.equal(e.projectLayer, '/cfg/dir/containers/Layer.demo')
  assert.deepEqual(e.seatExtraMounts, [{ host: '/opt/ref', container: '/opt/ref' }, { host: `${HOME_DIR}/data`, container: '/data' }])
  assert.deepEqual(e.sandboxExtraMounts, [{ host: `${HOME_DIR}/.config/tool`, container: `${HOME_DIR}/.config/tool` }])
  assert.deepEqual(e.secretsPaths, [`${HOME_DIR}/.secrets`, '/etc/demo-keys'])
  assert.equal(e.vibeAgentDir, `${HOME_DIR}/.vibe/agents-headless`)
  assert.deepEqual(e.seatTestEnv, ['APP_KEY=test-only', 'EMPTY='])
  // absolute / ~ layer paths are kept as given (not re-resolved)
  assert.equal(readConfig(withExec(execWith('Sandbox project layer', '`/abs/Layer`')), { configDir: '/cfg' }).exec.projectLayer, '/abs/Layer')
  assert.equal(readConfig(withExec(execWith('Sandbox project layer', '`~/Layer`')), { configDir: '/cfg' }).exec.projectLayer, `${HOME_DIR}/Layer`)
  // loadConfig passes the FILE's directory as configDir
  withTemp((dir) => {
    const l = loadConfig(writeCfg(dir, withExec()))
    assert.equal(l.exec.projectLayer, join(dir, 'containers/Layer.demo'))
  })
})

test('Execution Layer: none handling — legal for layer / mounts / secrets / seat env, never for the images or the agent dir', () => {
  const c = readConfig(withExec([
    ['Sandbox project layer', 'none — the base is enough'], ['Seat extra mounts', 'none'], ['Sandbox extra mounts', 'none'],
    ['Secrets paths', 'none'], ['Seat test env', '`none`'],
  ].reduce((t, [k, v]) => t.replace(new RegExp(`^- \\*\\*${k}:\\*\\*.*$`, 'm'), `- **${k}:** ${v}`), EXEC)))
  assert.deepEqual(c.exec.missing, [])
  assert.deepEqual(c.problems, [])
  assert.equal(c.exec.projectLayer, null)
  assert.deepEqual([c.exec.seatExtraMounts, c.exec.sandboxExtraMounts, c.exec.secretsPaths, c.exec.seatTestEnv], [[], [], [], []])
  for (const k of ['Sandbox image', 'GLM image', 'Vibe agent dir']) {
    const n = readConfig(withExec(execWith(k, 'none')))
    assert.deepEqual(n.exec.missing, [k], `${k}: none → missing`)
  }
  // optional keys may be absent entirely
  const opt = readConfig(withExec(execWithout('Sandbox extra mounts').replace(/^- \*\*Seat test env:\*\*.*\n/m, '')))
  assert.deepEqual(opt.exec.missing, [])
  assert.deepEqual(opt.exec.sandboxExtraMounts, [])
  assert.deepEqual(opt.exec.seatTestEnv, [])
  // each required key, when absent, is named as written
  for (const [k, , required] of EXEC_KEYS) {
    const m = readConfig(withExec(execWithout(k)))
    assert.deepEqual(m.exec.missing, required ? [k] : [], k)
  }
})

test('Execution Layer: every validation defect is a reader problem (exit 2), merged only when the section exists', () => {
  const cases = [
    ['Sandbox image', '`demo sandbox:latest`', /Sandbox image 'demo sandbox:latest' must not contain whitespace/],
    ['Sandbox image', '`demo-sandbox`', /Sandbox image 'demo-sandbox' must carry an explicit :tag/],
    ['GLM image', '`localhost:5000/glm`', /GLM image 'localhost:5000\/glm' must carry an explicit :tag/],
    ['Seat extra mounts', '`/a:/b:rw`', /Seat extra mounts entry '\/a:\/b:rw' has a third ':' field/],
    ['Seat extra mounts', '`rel/dir`', /Seat extra mounts entry 'rel\/dir' must have an absolute \(or ~\/…\) host path/],
    ['Seat extra mounts', '`/a:rel`', /Seat extra mounts entry '\/a:rel' must have an absolute \(or ~\/…\) container path/],
    ['Sandbox extra mounts', '`/a:/b:ro`', /Sandbox extra mounts entry '\/a:\/b:ro' has a third ':' field/],
    ['Secrets paths', '`.secrets`', /Secrets paths entry '\.secrets' must be an absolute path or ~\/…/],
    ['Vibe agent dir', '`agents`', /Vibe agent dir 'agents' must be an absolute path or ~\/…/],
    ['Seat test env', '`novalue`', /Seat test env entry 'novalue' must be NAME=value/],
    ['Seat test env', '`1BAD=x`', /Seat test env entry '1BAD=x' must be NAME=value/],
    ['Seat test env', '`HOME=/x`', /Seat test env entry 'HOME=\/x' uses a reserved name/],
    ['Seat test env', '`PATH=/x`', /reserved name/],
    ['Seat test env', '`WOLFPACK_SANDBOX=0`', /reserved name/],
    ['Seat test env', '`GIT_DIR=/x`', /reserved name/],
    ['Sandbox image', '`a:latest`\tx', /Sandbox image contains a TAB/],
  ]
  for (const [k, v, re] of cases) {
    const c = readConfig(withExec(execWith(k, v)))
    assert.ok(c.problems.some(p => re.test(p)), `${k}=${v}: ${JSON.stringify(c.problems)}`)
    assert.ok(c.problems.every(p => !/^Execution Layer/.test(p) || c.exec.problems.includes(p)))
    assert.ok(problemLine(c), `${k}=${v}: problemLine is non-empty → exit 2`)
  }
  // Reserved names do not over-match ordinary ones.
  assert.deepEqual(readConfig(withExec(execWith('Seat test env', '`HOMEPAGE=x` `MYPATH=y` `GITHUB_X=z`'))).exec.seatTestEnv, ['HOMEPAGE=x', 'MYPATH=y', 'GITHUB_X=z'])
  // An absent section never contributes problems; execLayer(undefined) has none either.
  assert.deepEqual(execLayer(undefined).problems, [])
  withTemp((dir) => {
    const r = runCli([writeCfg(dir, withExec(execWith('Secrets paths', '`rel`')))])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /Execution Layer: Secrets paths entry 'rel' must be an absolute path/)
  })
})

test('CLI --exec: the exact TAB lines (stdout), exit 0', () => {
  withTemp((dir) => {
    const p = writeCfg(dir, withExec())
    const r = runCli(['--exec', p], { env: { ...process.env, HOME: HOME_DIR } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stderr, '')
    assert.equal(r.stdout, [
      `config\t${p}`,
      'sandbox_image\tdemo-sandbox:latest',
      'glm_image\tdemo-sandbox-glm:v2',
      `project_layer\t${join(dir, 'containers/Layer.demo')}`,
      'seat_mount\t/opt/ref\t/opt/ref',
      `seat_mount\t${HOME_DIR}/data\t/data`,
      `sandbox_mount\t${HOME_DIR}/.config/tool\t${HOME_DIR}/.config/tool`,
      `secrets_path\t${HOME_DIR}/.secrets`,
      'secrets_path\t/etc/demo-keys',
      `vibe_agent_dir\t${HOME_DIR}/.vibe/agents-headless`,
      'seat_env\tAPP_KEY=test-only',
      'seat_env\tEMPTY=',
      '',
    ].join('\n'))
    // execLines (the same function) — none layer → an EMPTY project_layer value, no mount lines
    const none = readConfig(withExec(execWith('Sandbox project layer', 'none').replace(/^- \*\*Seat extra mounts:\*\*.*$/m, '- **Seat extra mounts:** none')))
    const lines = execLines({ ...none, path: '/x/wolfpack-config.md' }).split('\n')
    assert.ok(lines.includes('project_layer\t'))
    assert.equal(lines.some(l => l.startsWith('seat_mount\t')), false)
  })
})

test('CLI --exec: a missing key → stdout EMPTY, stderr names the keys as written, exit 2; a problem likewise', () => {
  withTemp((dir) => {
    const r = runCli(['--exec', writeCfg(dir, withExec(execWithout('Sandbox image').replace(/^- \*\*Vibe agent dir:\*\*.*\n/m, '')))])
    assert.equal(r.status, 2)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '✗ wolfpack-config: Execution Layer: missing Sandbox image, Vibe agent dir\n')
    const r2 = runCli(['--exec', writeCfg(dir, FULL, 'b.md')])
    assert.equal(r2.status, 2)
    assert.equal(r2.stdout, '')
    assert.match(r2.stderr, /^✗ wolfpack-config: Execution Layer: missing Sandbox image, GLM image, Sandbox project layer, Seat extra mounts, Secrets paths, Vibe agent dir\n$/)
    const r3 = runCli(['--exec', writeCfg(dir, withExec(execWith('GLM image', '`glm`')), 'c.md')])
    assert.equal(r3.status, 2)
    assert.equal(r3.stdout, '')
    assert.match(r3.stderr, /GLM image 'glm' must carry an explicit :tag/)
    // a non-exec problem (e.g. the Model Pool) also blocks --exec: the shim never runs on a broken config
    const r4 = runCli(['--exec', writeCfg(dir, withExec().replace(/^- judgment .*\n/m, ''), 'd.md')])
    assert.equal(r4.status, 2)
    assert.equal(r4.stdout, '')
    assert.match(r4.stderr, /Model Pool/)
    // absent file
    const r5 = runCli(['--exec', join(dir, 'nope.md')])
    assert.equal(r5.status, 2)
    assert.equal(r5.stdout, '')
    assert.match(r5.stderr, /not found at/)
  })
})

test('CLI: --exec together with --json → usage, exit 2', () => {
  withTemp((dir) => {
    const p = writeCfg(dir, withExec())
    for (const args of [['--exec', '--json', p], ['--json', '--exec', p]]) {
      const r = runCli(args)
      assert.equal(r.status, 2)
      assert.equal(r.stdout, '')
      assert.match(r.stderr, /usage: node scripts\/wolfpack-config\.mjs \[--json \| --exec\]/)
    }
  })
})

test('CLI --json carries wolfpackHome and exec; bare mode summarises them', () => {
  withTemp((dir) => {
    const p = writeCfg(dir, withExec().replace('- **Worktree links:**', '- **Wolfpack home:** `/opt/pack`\n- **Worktree links:**'))
    const j = JSON.parse(runCli(['--json', p]).stdout)
    assert.equal(j.wolfpackHome, '/opt/pack')
    assert.equal(j.exec.sandboxImage, 'demo-sandbox:latest')
    assert.deepEqual(j.exec.missing, [])
    const bare = runCli([p]).stdout
    assert.match(bare, /^wolfpackHome: \/opt\/pack$/m)
    assert.match(bare, new RegExp(`^exec: sandbox demo-sandbox:latest · glm demo-sandbox-glm:v2 · layer ${join(dir, 'containers/Layer.demo').replace(/[.]/g, '\\.')}$`, 'm'))
  })
})

test('the REAL wolfpack-config.md and the example both read clean under --exec and --json', () => {
  for (const f of [REAL, join(ROOT, 'wolfpack-config.example.md')]) {
    const e = runCli(['--exec', f])
    assert.equal(e.status, 0, `${f}: ${e.stderr}`)
    assert.match(e.stdout, /^sandbox_image\t\S+:\S+$/m)
    assert.match(e.stdout, /^vibe_agent_dir\t\//m)
    const j = runCli(['--json', f])
    assert.equal(j.status, 0, `${f}: ${j.stderr}`)
    const c = JSON.parse(j.stdout)
    assert.equal(typeof c.wolfpackHome, 'string', `${f}: Wolfpack home is set`)
    assert.ok(c.wolfpackHome.startsWith('/'))
  }
  const real = loadConfig(REAL)
  assert.equal(real.exec.sandboxImage, 'wolfpack-pack-sandbox:latest', 'the pack names its own image apart from any consumer (H13)')
  assert.equal(real.exec.glmImage, 'wolfpack-pack-sandbox-glm:latest')
  assert.equal(real.exec.projectLayer, null)
  // the example documents every key
  const ex = readFileSync(join(ROOT, 'wolfpack-config.example.md'), 'utf8')
  for (const [k] of EXEC_KEYS) assert.match(ex, new RegExp(`^- \\*\\*${k}:\\*\\*`, 'm'), k)
  assert.match(ex, /^- \*\*Wolfpack home:\*\*/m)
})
