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
  expandHome, execLayer, execLines, imageHasTag, EXEC_KEYS, validWorktreeRoot, smokeLoginHookValue,
  STAGE_KEYS, pairList, prodHostSuffixOf,
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

// ─── pack-install-model (AC8): Project Identity → Worktree root ──────────
const withRoot = (line) => FULL.replace('- **Worktree links:**', `${line}\n- **Worktree links:**`)

test('AC8: Worktree root present → the value (trailing / stripped); absent → null with NO problem', () => {
  assert.equal(readConfig(withRoot('- **Worktree root:** `.agents/worktrees`')).worktreeRoot, '.agents/worktrees')
  assert.equal(readConfig(withRoot('- **Worktree root:** `.agents/worktrees/`')).worktreeRoot, '.agents/worktrees')
  assert.equal(readConfig(withRoot('- **Worktree root:** `.claude/worktrees//` — prose after')).worktreeRoot, '.claude/worktrees')
  const c = readConfig(withRoot('- **Worktree root:** `.wt/hunts`'))
  assert.equal(c.worktreeRoot, '.wt/hunts')
  assert.deepEqual(c.problems, [])
  const absent = readConfig(FULL)
  assert.equal(absent.worktreeRoot, null)
  assert.deepEqual(absent.problems, [])
  assert.deepEqual(absent.missing, [], 'optional for the reader; the workflows require it')
})

test('AC8: validWorktreeRoot accepts the dot-dir roots and plain names; rejects every malformed shape', () => {
  for (const ok of ['.agents/worktrees', '.claude/worktrees', '.wt/hunts', 'worktrees', 'a_b/c-d.e', '_x']) {
    assert.equal(validWorktreeRoot(ok), true, ok)
  }
  for (const bad of ['', '/abs', '~/x', '~', '../x', 'a/../b', './x', '..x/y', '.', '..', 'a b', '.git/x', '.git', '`$x`', '$x', 'a/*', "it's", 'a//b', 'a/', '-x', null, undefined, 7]) {
    assert.equal(validWorktreeRoot(bad), false, String(bad))
  }
})

test('AC8: a malformed Worktree root → a problems entry + null (reader exit 2)', () => {
  for (const v of ['/abs', '~/x', '../x', 'a/../b', './x', '..x/y', 'a b', '.git/x', '$x']) {
    const c = readConfig(withRoot(`- **Worktree root:** \`${v}\``))
    assert.equal(c.worktreeRoot, null, v)
    assert.ok(c.problems.some(p => /^Project Identity → Worktree root must be a repo-relative path like `\.agents\/worktrees`/.test(p)), `${v}: ${c.problems}`)
  }
  withTemp((dir) => {
    const p = writeCfg(dir, withRoot('- **Worktree root:** `../escape`'))
    const r = runCli(['--json', p])
    assert.equal(r.status, 2, r.stdout + r.stderr)
  })
})

test('AC8: the REAL wolfpack-config.md resolves Worktree root `.agents/worktrees` with no problem; the CLI carries it in --json and the summary', () => {
  const c = loadConfig(REAL)
  assert.equal(c.worktreeRoot, '.agents/worktrees')
  assert.deepEqual(c.problems, [])
  const j = runCli(['--json', REAL])
  assert.equal(j.status, 0, j.stderr)
  assert.equal(JSON.parse(j.stdout).worktreeRoot, '.agents/worktrees')
  const s = runCli([REAL])
  assert.equal(s.status, 0)
  assert.match(s.stdout, /^worktreeRoot: \.agents\/worktrees$/m)
  // the example carries the REQUIRED key too, and reads clean
  const ex = loadConfig(join(ROOT, 'wolfpack-config.example.md'))
  assert.equal(typeof ex.worktreeRoot, 'string')
  assert.ok(validWorktreeRoot(ex.worktreeRoot), ex.worktreeRoot)
})

test('AC8 parity: both workflows inline the reader\'s validWorktreeRoot rule (same segment regex, .git and ~ guards)', () => {
  const src = readFileSync(join(here, 'wolfpack-config.mjs'), 'utf8')
  const seg = '/^\\.?[A-Za-z0-9_][A-Za-z0-9_.-]*$/'
  assert.ok(src.includes(seg))
  for (const n of ['hunt-pipeline.js', 'campaign-runner.js']) {
    const w = readFileSync(join(ROOT, '.agents', 'workflows', n), 'utf8')
    assert.ok(w.includes(`segs.every(seg => ${seg}.test(seg))`), n)
    assert.ok(w.includes("segs[0] !== '.git'"), n)
    assert.ok(w.includes("!value.startsWith('~')"), n)
  }
})

// ─── pack-commands-canonical: Smoke login hook (D3/AC4) + Project commands (D4) ───────────
const withHook = (v) => FULL.replace('- Backlog file:', `- Smoke login hook: ${v}\n- Backlog file:`)
const withCommands = (v) => FULL.replace('- **Worktree links:**', `- **Project commands:** ${v}\n- **Worktree links:**`)
const hookProblems = (c) => c.problems.filter(p => p.startsWith('Deployment Notes → Smoke login hook'))

test('D3: a set Smoke login hook → the template and the accounts (first is the default), no problem', () => {
  const c = readConfig(withHook('`./scripts/smoke-login --host {host} --account {account}` accounts `smoke-user` `smoke-other`'))
  assert.equal(c.smokeLoginHook, './scripts/smoke-login --host {host} --account {account}')
  assert.deepEqual(c.smokeLoginAccounts, ['smoke-user', 'smoke-other'])
  assert.deepEqual(c.problems, [])
  assert.deepEqual(c.missing, [])
  // a template with {host} only needs no accounts
  const h = readConfig(withHook('`./login {host}`'))
  assert.equal(h.smokeLoginHook, './login {host}')
  assert.deepEqual(h.smokeLoginAccounts, [])
  assert.deepEqual(h.problems, [])
})

test('D3: Smoke login hook `none` / absent → null and [] with no problem and nothing missing', () => {
  for (const text of [withHook('none'), withHook('none — nothing is deployed.'), withHook('`none`'), FULL]) {
    const c = readConfig(text)
    assert.equal(c.smokeLoginHook, null)
    assert.deepEqual(c.smokeLoginAccounts, [])
    assert.deepEqual(c.problems, [])
    assert.deepEqual(c.missing, [], 'optional key')
  }
})

test('D3 (Bloodhound r1 #1): the consumer-shaped line — notes after ` — ` with backticked flags are never accounts', () => {
  const c = readConfig(withHook('`venv/bin/python scripts/smoke/login.py --host {host} --account {account}` accounts `smoke-a` `smoke-b` — signs the smoke browser in; `--check` probes; exit 3 = `browser not reachable`.'))
  assert.equal(c.smokeLoginHook, 'venv/bin/python scripts/smoke/login.py --host {host} --account {account}')
  assert.deepEqual(c.smokeLoginAccounts, ['smoke-a', 'smoke-b'])
  assert.deepEqual(c.problems, [])
  // backticked spans BEFORE the word `accounts` (after the template) are not accounts either
  const d = smokeLoginHookValue('`./l {host} {account}` (see `docs/x.md`) accounts `u1`')
  assert.deepEqual(d, { hook: './l {host} {account}', accounts: ['u1'] })
})

test('D3: every Smoke login hook defect is a problem and nulls both values', () => {
  const cases = [
    ['`./scripts/smoke-login --account {account}` accounts `u`', /must contain \{host\}/],
    ['`./scripts/smoke-login --host {host} --account {account}`', /uses \{account\} but lists no accounts/],
    ['`./scripts/smoke-login --host {host} --account {account}` accounts', /uses \{account\} but lists no accounts/],
    ['`./l --host {host}` accounts `ok` `bad name!`', /account name\(s\) 'bad name!' must match/],
    ['`./l --host {host}` accounts `x;rm`', /account name\(s\) 'x;rm'/],
    ['`./l\t--host {host}`', /TAB or newline/],
    // an unbackticked template: the first backticked span (`u`) is read as the template → no {host} → a problem
    ['./scripts/smoke-login --host {host} accounts `u`', /template 'u' must contain \{host\}/],
    ['./scripts/smoke-login --host {host}', /must start with a backticked command template/],
    ['just words — `./l {host}` in the notes only', /must start with a backticked command template/],
  ]
  for (const [v, re] of cases) {
    const c = readConfig(withHook(v))
    assert.equal(c.smokeLoginHook, null, v)
    assert.deepEqual(c.smokeLoginAccounts, [], v)
    const ps = hookProblems(c)
    assert.equal(ps.length, 1, `${v}: ${c.problems}`)
    assert.match(ps[0], re, v)
  }
  // the pure helper: pushes onto the given array, returns null/[]
  const problems = []
  assert.deepEqual(smokeLoginHookValue('`./l`', problems), { hook: null, accounts: [] })
  assert.equal(problems.length, 1)
  assert.deepEqual(smokeLoginHookValue(undefined), { hook: null, accounts: [] })
})

test('D3: a Smoke login hook problem makes the CLI exit 2; a set hook shows in --json and the summary', () => {
  withTemp((dir) => {
    const bad = runCli(['--json', writeCfg(dir, withHook('`./l --account {account}`'), 'bad.md')])
    assert.equal(bad.status, 2, bad.stdout + bad.stderr)
    const p = writeCfg(dir, withHook('`./l --host {host}` accounts `u`'))
    const j = runCli(['--json', p])
    assert.equal(j.status, 0, j.stderr)
    const o = JSON.parse(j.stdout)
    assert.equal(o.smokeLoginHook, './l --host {host}')
    assert.deepEqual(o.smokeLoginAccounts, ['u'])
    const s = runCli([p])
    assert.equal(s.status, 0)
    assert.match(s.stdout, /^smokeLoginHook: \.\/l --host \{host\}$/m)
    assert.match(runCli([writeCfg(dir, FULL, 'none.md')]).stdout, /^smokeLoginHook: none$/m)
  })
})

test('D4: Project commands set / none / absent / bad name', () => {
  const set = readConfig(withCommands('`doc-reviewer`, `structural-audit`, `test` — thin entry points to project skills.'))
  assert.deepEqual(set.projectCommands, ['doc-reviewer', 'structural-audit', 'test'])
  assert.deepEqual(set.problems, [])
  assert.deepEqual(readConfig(withCommands('doc-reviewer, test2')).projectCommands, ['doc-reviewer', 'test2'], 'comma list without backticks')
  for (const text of [withCommands('none'), withCommands('none — project-only commands (e.g. `doc-reviewer`)'), FULL]) {
    const c = readConfig(text)
    assert.deepEqual(c.projectCommands, [])
    assert.deepEqual(c.problems, [])
    assert.deepEqual(c.missing, [])
  }
  for (const badName of ['Doc-Reviewer', '-x', 'sub/foo', 'a b', 'x.md', 'README', '_x']) {
    const c = readConfig(withCommands(`\`ok\`, \`${badName}\``))
    assert.deepEqual(c.projectCommands, [], badName)
    assert.ok(c.problems.some(p => p.startsWith('Project Identity → Project commands: invalid name(s)') && p.includes(`'${badName}'`)), `${badName}: ${c.problems}`)
  }
  withTemp((dir) => {
    assert.equal(runCli(['--json', writeCfg(dir, withCommands('`Bad`'))]).status, 2)
    const j = runCli(['--json', writeCfg(dir, withCommands('`a`, `b`'), 'ok.md')])
    assert.equal(j.status, 0, j.stderr)
    assert.deepEqual(JSON.parse(j.stdout).projectCommands, ['a', 'b'])
  })
})

test('D3/D4: the REAL wolfpack-config.md and the example → smokeLoginHook null, accounts [], projectCommands [], no problems; --exec unchanged', () => {
  for (const p of [REAL, join(ROOT, 'wolfpack-config.example.md')]) {
    const c = loadConfig(p)
    assert.equal(c.smokeLoginHook, null, p)
    assert.deepEqual(c.smokeLoginAccounts, [], p)
    assert.deepEqual(c.projectCommands, [], p)
    assert.deepEqual(c.problems, [], p)
  }
  const e = runCli(['--exec', REAL])
  // The first line names the config path, which may itself contain "smoke" (e.g. a hunt worktree
  // named wave-auto-smoke); only the key lines are judged.
  const keyLines = e.stdout.split('\n').filter(l => !l.startsWith('config\t')).join('\n')
  assert.match(e.stdout, /^config\t/, 'the path line is still first')
  assert.doesNotMatch(keyLines, /smoke|projectCommands|Project commands/i, '--exec output carries only the execution-layer keys')
})

// ─── scripts-unfork: Model Pool `gate=<ENV>` → gates (the router's enabled set) ─────────────
const gatedPool = (lines) => FULL.replace(POOL, `## Model Pool
### Family → model mapping
${lines}
`)
const BASE_LINES = {
  j: '- judgment    → fam-a:big:high',
  w: '- work-horse  → fam-a:small',
  a: '- reviewer-a  → fam-b:1',
  b: '- reviewer-b  → fam-c:2',
}
const lines = (over = {}) => Object.values({ ...BASE_LINES, ...over }).join('\n')

test('gates: gate= on reviewer and coder-alt lines → { family: ENV }; none → {} (never null on a clean pool)', () => {
  const c = readConfig(gatedPool(lines({
    a: '- reviewer-a  → fam-b:1 gate=WOLFPACK_ENABLE_B   # first examiner',
    b: '- reviewer-b  → fam-c:2   gate=WOLFPACK_ENABLE_C_AUTO',
    x: '- reviewer-c  → fam-d:3 gate=WOLFPACK_ENABLE_D',
    y: '- coder-alt   → fam-b:1 gate=WOLFPACK_ENABLE_B',
  })))
  assert.deepEqual(c.problems, [])
  assert.deepEqual(c.gates, { 'fam-b': 'WOLFPACK_ENABLE_B', 'fam-c': 'WOLFPACK_ENABLE_C_AUTO', 'fam-d': 'WOLFPACK_ENABLE_D' })
  // the token is still the first word — gate= never leaks into models/pool
  assert.equal(c.models['reviewer-a'], 'fam-b:1')
  assert.equal(c.pool.reviewerB, 'fam-c')
  assert.deepEqual(readConfig(FULL).gates, {})
})

test('gates: a family gated on one line and ungated on another is gated (the gate names the family)', () => {
  const c = readConfig(gatedPool(lines({ a: '- reviewer-a  → fam-b:1', y: '- coder-alt   → fam-b:1 gate=WOLFPACK_ENABLE_B' })))
  assert.deepEqual(c.problems, [])
  assert.deepEqual(c.gates, { 'fam-b': 'WOLFPACK_ENABLE_B' })
})

test('gates: `#`-comment text is never parsed — prose like (WOLFPACK_ENABLE_X=0 disables) or gate=… after # is ignored', () => {
  const c = readConfig(gatedPool(lines({
    a: '- reviewer-a  → fam-b:1   # first link (WOLFPACK_ENABLE_B=0 disables) gate=WOLFPACK_ENABLE_B',
    b: '- reviewer-b  → fam-c:2 # gate=WOLFPACK_ENABLE_C',
  })))
  assert.deepEqual(c.problems, [])
  assert.deepEqual(c.gates, {})
})

test('gates: an invalid name → problem naming the role; gates/pool/models all null (reader exit 2)', () => {
  for (const bad of ['enable_b', 'WOLFPACK_', 'WOLFPACK_enable', 'OTHER_ENABLE_B', 'WOLFPACK_A-B', '']) {
    const text = gatedPool(lines({ a: `- reviewer-a  → fam-b:1 gate=${bad}` }))
    const c = readConfig(text)
    assert.deepEqual(c.problems, [`Model Pool: reviewer-a gate '${bad}' must match WOLFPACK_[A-Z0-9_]+`], bad)
    assert.equal(c.gates, null, bad)
    assert.equal(c.pool, null, bad)
    assert.equal(c.models, null, bad)
  }
  withTemp((dir) => {
    const r = runCli(['--json', writeCfg(dir, gatedPool(lines({ a: '- reviewer-a  → fam-b:1 gate=nope' })))])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /✗ wolfpack-config: .*Model Pool: reviewer-a gate 'nope' must match WOLFPACK_\[A-Z0-9_\]\+/)
    assert.equal(JSON.parse(r.stdout).gates, null)
  })
})

test('gates: judgment / work-horse cannot be gated (implementer families are always on)', () => {
  for (const [k, role] of [['j', 'judgment'], ['w', 'work-horse']]) {
    const c = readConfig(gatedPool(lines({ [k]: `${BASE_LINES[k]} gate=WOLFPACK_ENABLE_A` })))
    assert.deepEqual(c.problems, [`Model Pool: ${role} cannot be gated (implementer families are always on)`], role)
    assert.equal(c.gates, null)
  }
})

test('gates: two roles of the SAME family with different gates → conflicting-gates problem', () => {
  const c = readConfig(gatedPool(lines({
    a: '- reviewer-a  → fam-b:1 gate=WOLFPACK_ENABLE_B',
    y: '- coder-alt   → fam-b:9 gate=WOLFPACK_ENABLE_OTHER',
  })))
  assert.deepEqual(c.problems, ['Model Pool: family fam-b has conflicting gates WOLFPACK_ENABLE_B, WOLFPACK_ENABLE_OTHER'])
  assert.equal(c.gates, null)
  // family match is case-insensitive (the pool lowercases the token before `:`)
  const d = readConfig(gatedPool(lines({ a: '- reviewer-a  → FAM-B:1 gate=WOLFPACK_ENABLE_B', y: '- coder-alt   → fam-b:1 gate=WOLFPACK_ENABLE_C' })))
  assert.match(d.problems.join(';'), /family fam-b has conflicting gates/)
})

test('gates: more than one gate= on a line → problem (even when both name the same env)', () => {
  for (const tail of ['gate=WOLFPACK_ENABLE_B gate=WOLFPACK_ENABLE_C', 'gate=WOLFPACK_ENABLE_B gate=WOLFPACK_ENABLE_B']) {
    const c = readConfig(gatedPool(lines({ a: `- reviewer-a  → fam-b:1 ${tail}` })))
    assert.deepEqual(c.problems, ['Model Pool: reviewer-a has more than one gate= word'], tail)
    assert.equal(c.gates, null)
  }
})

test('gates: unknown roles keep landing in unknownRoles (no problem) — a gate= on one is not parsed as a gate', () => {
  const c = readConfig(gatedPool(lines({ z: '- reviewer-z  → fam-a:big:high gate=WOLFPACK_ENABLE_Z   # LAST RESORT' })))
  assert.deepEqual(c.problems, [])
  assert.deepEqual(c.unknownRoles, ['reviewer-z'])
  assert.deepEqual(c.gates, {})
})

test('gates: the REAL pack config yields {glm: WOLFPACK_ENABLE_GLM, mistral: WOLFPACK_ENABLE_MISTRAL_AUTO}; --json and the summary carry it', () => {
  const c = loadConfig(REAL)
  assert.deepEqual(c.gates, { glm: 'WOLFPACK_ENABLE_GLM', mistral: 'WOLFPACK_ENABLE_MISTRAL_AUTO' })
  const j = runCli(['--json', REAL])
  assert.equal(j.status, 0, j.stderr)
  assert.deepEqual(JSON.parse(j.stdout).gates, c.gates)
  const s = runCli([REAL])
  assert.match(s.stdout, /^gate glm ← WOLFPACK_ENABLE_GLM$/m)
  assert.match(s.stdout, /^gate mistral ← WOLFPACK_ENABLE_MISTRAL_AUTO$/m)
  // the example template documents the word and still reads clean with gates
  const ex = loadConfig(join(ROOT, 'wolfpack-config.example.md'))
  assert.deepEqual(ex.problems, [])
  assert.ok(ex.gates && Object.keys(ex.gates).length >= 1, JSON.stringify(ex.gates))
  // the env names the workflows read are exactly the ones the pack's config declares
  for (const wf of ['hunt-pipeline.js', 'campaign-runner.js']) {
    const src = readFileSync(join(ROOT, '.agents', 'workflows', wf), 'utf8')
    for (const env of Object.values(c.gates)) assert.ok(src.includes(env), `${wf} reads ${env}`)
  }
})

test('mainWorktree: a hunt worktree resolves to its MAIN checkout; outside git → null', async () => {
  const { mainWorktree } = await import('./wolfpack-config.mjs')
  const { execFileSync } = await import('node:child_process')
  const { realpathSync, mkdirSync } = await import('node:fs')
  withTemp((dir) => {
    const main = realpathSync(dir)
    const gg = (...a) => execFileSync('git', ['-C', main, ...a], { stdio: 'ignore' })
    gg('init', '-q', '-b', 'main')
    gg('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i')
    const wt = join(main, '.claude', 'worktrees', 'h')
    gg('worktree', 'add', '-q', '-b', 'feat/h', wt)
    mkdirSync(join(wt, 'sub', 'deeper'), { recursive: true })
    assert.equal(mainWorktree(main), main)
    assert.equal(mainWorktree(wt), main)
    assert.equal(mainWorktree(join(wt, 'sub', 'deeper')), main)
  })
  withTemp((dir) => assert.equal(mainWorktree(dir), null))
  assert.equal(mainWorktree('/nonexistent/path/for/wolfpack-test'), null)
})

// ─── run-observability: Test verdict command (P5) + the single-quote guard on Wolfpack home (AC12) ───
const withVerdict = (line) => FULL.replace(/(- \*\*Test command:\*\*.*\n)/, `$1${line}\n`)

test('run-observability P5: Test verdict command — present → the code span; none / absent → null; never a problem', () => {
  assert.equal(readConfig(FULL).testVerdictCommand, null)
  const c = readConfig(withVerdict('- **Test verdict command:** `python3 {main}/v.py --log {log} --runner-exit {exit}` — decides pass/fail'))
  assert.equal(c.testVerdictCommand, 'python3 {main}/v.py --log {log} --runner-exit {exit}')
  assert.deepEqual(c.missing, [])
  assert.deepEqual(c.problems, [])
  for (const v of ['none', '`none`', 'none — the suite exit code is the verdict', 'n/a']) {
    const n = readConfig(withVerdict(`- **Test verdict command:** ${v}`))
    assert.equal(n.testVerdictCommand, null, v)
    assert.deepEqual(n.missing, [], v)
  }
  // the Test command itself is unaffected by the new key
  assert.equal(c.testCommand, 'make test')
})

test('run-observability P5: the REAL pack config and the example both read testVerdictCommand as null; the CLI summary prints it', () => {
  assert.equal(loadConfig(REAL).testVerdictCommand, null)
  assert.equal(loadConfig(join(ROOT, 'wolfpack-config.example.md')).testVerdictCommand, null)
  const j = JSON.parse(runCli(['--json', REAL]).stdout)
  assert.ok('testVerdictCommand' in j)
  assert.equal(j.testVerdictCommand, null)
  withTemp((dir) => {
    const p = writeCfg(dir, withVerdict('- **Test verdict command:** `check {log}`'))
    const r = runCli([p])
    assert.match(r.stdout, /^testVerdictCommand: check \{log\}$/m)
    assert.match(runCli([writeCfg(dir, FULL, 'b.md')]).stdout, /^testVerdictCommand: none$/m)
  })
})

test("run-observability AC12: a Wolfpack home containing a single quote is a config problem (never a garbled probe); plain paths stay accepted", () => {
  for (const v of ["`/opt/o'brien/pack`", "/opt/o'brien/pack", "`~/it's/pack`"]) {
    const c = readConfig(withHome(`- **Wolfpack home:** ${v}`))
    assert.equal(c.wolfpackHome, null, v)
    assert.ok(c.problems.includes('Project Identity → Wolfpack home must not contain a single quote'), `${v}: ${c.problems}`)
  }
  const ok = readConfig(withHome('- **Wolfpack home:** `/opt/pack`'))
  assert.equal(ok.wolfpackHome, '/opt/pack')
  assert.deepEqual(ok.problems, [])
  // a path with a space or a $ is NOT refused (the single-quoted key leg makes it inert)
  assert.equal(readConfig(withHome('- **Wolfpack home:** `/opt/my pack`')).wolfpackHome, '/opt/my pack')
  assert.equal(readConfig(withHome('- **Wolfpack home:** `/opt/$x/pack`')).wolfpackHome, '/opt/$x/pack')
})

// ─── merge-and-state-hygiene AC20: releaseTags (Deployment Notes → Tag pattern: none) ─────────
test('AC20: releaseTags is false only for a PRESENT `none` / n/a Tag pattern; a pattern, an absent key or a blank key keep tagging', () => {
  const withTag = (line) => FULL.replace('- Tag pattern: `v[0-9]*`\n', line)
  const cases = [
    ['- Tag pattern: `v[0-9]*`\n', true],
    ['- Tag pattern: `release-*`\n', true],
    ['- Tag pattern: none\n', false],
    ['- Tag pattern: `none`\n', false],
    ['- Tag pattern: NONE — this project does not tag releases\n', false],
    ['- Tag pattern: n/a\n', false],
    ['', true],                            // key absent → today's v[0-9]* default, unchanged
    ['- Tag pattern:\n', true],            // present but blank → never silently turns tagging off
  ]
  for (const [line, want] of cases) {
    const c = readConfig(withTag(line))
    assert.equal(c.releaseTags, want, JSON.stringify(line))
  }
  assert.equal(loadConfig(REAL).releaseTags, true, 'the pack tags its releases')
})

test('AC20: releaseTags reaches --json and the summary', () => {
  withTemp((dir) => {
    const p = join(dir, 'wolfpack-config.md')
    writeFileSync(p, FULL.replace('- Tag pattern: `v[0-9]*`\n', '- Tag pattern: none\n'))
    const j = runCli(['--json', p])
    assert.equal(JSON.parse(j.stdout).releaseTags, false, j.stdout + j.stderr)
    const s = runCli([p])
    assert.match(s.stdout + s.stderr, /releaseTags: false/)
  })
  const src = readFileSync(CLI, 'utf8')
  assert.match(src.slice(0, src.indexOf('import ')), /\/\/\s+releaseTags\s+false when Deployment Notes → Tag pattern is PRESENT and `none`/, 'documented in the RESOLVED KEYS header')
})


// ─── wave-auto-smoke: the post-merge stage keys ───────────────────────────────────────────
const STAGE_DEP = [
  '- Post-merge smoke stage: `on` — chain mode post-merge stage.',
  '- Migration command: `make migrate-dev`',
  '- Migration file pattern: `/migrations/[0-9]`',
  '- Never-smoke hosts: `example.com` `demo.example.dev` `Clone.Example.dev`',
  '- Prod URL: `https://*.example.vet`',
  '- Smoke tenants: `surgical=surgical.example.dev` `mobile=dev.example.dev`',
  '- Smoke tenant manifests: `mobile=scripts/smoke/mobile-manifest.md`',
  '- Smoke tenant ensure command: `scripts/ops/ensure_tenant.sh run` — idempotent.',
  '- Wave report dir command: `venv/bin/python report.py wave-dir --campaign {campaign} --wave {wave}`',
  '- Wave report build command: `venv/bin/python report.py build --dir {dir}`',
  '- Campaign report command: `venv/bin/python report.py build-campaign --campaign {campaign} --issue-log {issue_log}`',
  '- Report URL command: `venv/bin/python report.py url --dir {dir}`',
].join('\n')
const STAGE_ID = [
  '- **App marker file:** `apps.py` — a Django app.',
  '- **Integration test args:** `--isolated-db {campaign}`',
  '- **Integration full-suite paths:** `settings/` `requirements.txt` `Dockerfile`',
].join('\n')
const withStage = (dep = STAGE_DEP, id = STAGE_ID, triage = '- **Triage block paths:** `billing/` `records/`') => FULL
  .replace('- Backlog file:', `${dep}\n- Backlog file:`)
  .replace('- **Worktree links:**', `${id}\n- **Worktree links:**`)
  .replace('- **Risk-surface paths:**', `${triage}\n- **Risk-surface paths:**`)
const stageProblems = (c) => c.problems.filter(p => /Post-merge|Smoke tenant/.test(p))

test('stage keys: every field parsed from a full stage block, no problem', () => {
  const c = readConfig(withStage())
  assert.deepEqual(c.problems, [])
  assert.equal(c.postMergeStage, true)
  assert.equal(c.migrateCommand, 'make migrate-dev')
  assert.equal(c.migrationFilePattern, '/migrations/[0-9]')
  assert.deepEqual(c.neverSmokeHosts, ['example.com', 'demo.example.dev', 'clone.example.dev'], 'lower-cased')
  assert.equal(c.prodHostSuffix, 'example.vet')
  assert.deepEqual(c.smokeTenants, { surgical: 'surgical.example.dev', mobile: 'dev.example.dev' })
  assert.deepEqual(c.smokeManifests, { mobile: 'scripts/smoke/mobile-manifest.md' })
  assert.equal(c.smokeTenantEnsureCommand, 'scripts/ops/ensure_tenant.sh run')
  assert.equal(c.waveReportDirCommand, 'venv/bin/python report.py wave-dir --campaign {campaign} --wave {wave}')
  assert.equal(c.waveReportBuildCommand, 'venv/bin/python report.py build --dir {dir}')
  assert.equal(c.campaignReportCommand, 'venv/bin/python report.py build-campaign --campaign {campaign} --issue-log {issue_log}')
  assert.equal(c.reportUrlCommand, 'venv/bin/python report.py url --dir {dir}')
  assert.equal(c.appMarkerFile, 'apps.py')
  assert.equal(c.integrationTestArgs, '--isolated-db {campaign}')
  assert.deepEqual(c.integrationFullSuitePaths, ['settings/', 'requirements.txt', 'Dockerfile'])
  assert.deepEqual(c.triageBlockPaths, ['billing/', 'records/'])
})

test('stage keys: absent → off, empty maps/lists, nulls; never added to missing', () => {
  const c = readConfig(FULL)
  assert.equal(c.postMergeStage, false)
  assert.deepEqual(c.smokeTenants, {})
  assert.deepEqual(c.smokeManifests, {})
  assert.deepEqual(c.neverSmokeHosts, [])
  assert.deepEqual(c.integrationFullSuitePaths, [])
  assert.deepEqual(c.triageBlockPaths, [])
  for (const k of ['migrateCommand', 'migrationFilePattern', 'prodHostSuffix', 'smokeTenantEnsureCommand', 'waveReportDirCommand',
    'waveReportBuildCommand', 'campaignReportCommand', 'reportUrlCommand', 'appMarkerFile', 'integrationTestArgs']) {
    assert.equal(c[k], null, k)
  }
  assert.deepEqual(c.missing, [])
  assert.deepEqual(c.problems, [])
  assert.equal(readConfig(withStage(STAGE_DEP.replace('`on` — chain mode post-merge stage.', '`off`'))).postMergeStage, false)
  assert.equal(readConfig(withStage(STAGE_DEP.replace('`on` — chain mode post-merge stage.', 'none'))).postMergeStage, false)
})

test('stage keys: the REAL pack config has the stage off and no problem', () => {
  const c = loadConfig(REAL)
  assert.equal(c.postMergeStage, false)
  assert.deepEqual(c.smokeTenants, {})
})

test('stage keys: problems — bad stage value, malformed / duplicate / bad-host tenant pairs, malformed manifest pair', () => {
  const cases = [
    [STAGE_DEP.replace('`on` — chain mode post-merge stage.', '`yes`'), /Post-merge smoke stage must be `on` or `off` \(got 'yes'\)/],
    [STAGE_DEP.replace('`surgical=surgical.example.dev`', '`surgical`'), /Smoke tenants: malformed pair 'surgical'/],
    [STAGE_DEP.replace('`surgical=surgical.example.dev`', '`Surgical=surgical.example.dev`'), /Smoke tenants: malformed pair/],
    [STAGE_DEP.replace('`surgical=surgical.example.dev`', '`surgical=Surgical.Example.dev`'), /Smoke tenants: 'Surgical\.Example\.dev' \(for surgical\) must match/],
    [STAGE_DEP.replace('`surgical=surgical.example.dev`', '`surgical=x.example.dev/path`'), /Smoke tenants: .* must match/],
    [STAGE_DEP.replace('`mobile=dev.example.dev`', '`surgical=dev.example.dev`'), /Smoke tenants: duplicate name 'surgical'/],
    [STAGE_DEP.replace('`mobile=scripts/smoke/mobile-manifest.md`', '`scripts/smoke/mobile-manifest.md`'), /Smoke tenant manifests: malformed pair/],
  ]
  for (const [dep, re] of cases) {
    const c = readConfig(withStage(dep))
    assert.ok(stageProblems(c).some(p => re.test(p)), `${re}: ${JSON.stringify(c.problems)}`)
  }
  // A malformed tenant list yields {} (never a partial map).
  assert.deepEqual(readConfig(withStage(cases[1][0])).smokeTenants, {})
  // ...and makes the CLI exit 2.
  withTemp((dir) => assert.equal(runCli(['--json', writeCfg(dir, withStage(cases[0][0]))]).status, 2))
})

test('pairList and prodHostSuffixOf', () => {
  const problems = []
  assert.deepEqual(pairList('`a=x.y` `b-2=z`', 'K', problems, { valueRe: /^[a-z0-9.-]+$/ }), { a: 'x.y', 'b-2': 'z' })
  assert.deepEqual(problems, [])
  assert.deepEqual(pairList(undefined, 'K', problems), {})
  assert.deepEqual(pairList('`=x`', 'K', problems), {})
  assert.equal(problems.length, 1)
  assert.equal(prodHostSuffixOf('`https://*.example.vet`'), 'example.vet')
  assert.equal(prodHostSuffixOf('`https://app.example.vet/login` — the prod app'), 'app.example.vet')
  assert.equal(prodHostSuffixOf('`https://*.Example.VET:443/`'), 'example.vet')
  assert.equal(prodHostSuffixOf('none'), null)
  assert.equal(prodHostSuffixOf(undefined), null)
  assert.equal(prodHostSuffixOf('`https://*.ex_ample.vet`'), null, 'not a hostname')
})

test('STAGE_KEYS: [field, written name, required]; only the full-suite paths are optional; names section-qualified', () => {
  assert.ok(STAGE_KEYS.length >= 19)
  const fields = new Set()
  for (const [field, written, required] of STAGE_KEYS) {
    assert.equal(typeof field, 'string')
    assert.match(written, /^(Deployment Notes|Project Identity|Compliance Requirements) → \S/)
    assert.equal(typeof required, 'boolean')
    assert.ok(!fields.has(field), `duplicate ${field}`)
    fields.add(field)
    assert.ok(field in readConfig(withStage()), `${field} is a reader field`)
  }
  assert.deepEqual(STAGE_KEYS.filter(k => !k[2]).map(k => k[0]), ['integrationFullSuitePaths'])
  for (const f of ['smokeLoginHook', 'testCommand', 'testVerdictCommand', 'smokeTenants', 'waveReportBuildCommand']) assert.ok(fields.has(f), f)
})

test('stage keys: the summary shows postMergeStage; --json carries the fields', () => {
  withTemp((dir) => {
    const p = writeCfg(dir, withStage())
    const s = runCli([p])
    assert.equal(s.status, 0, s.stderr)
    assert.match(s.stdout, /^postMergeStage: on$/m)
    const j = JSON.parse(runCli(['--json', p]).stdout)
    assert.deepEqual(j.smokeTenants, { surgical: 'surgical.example.dev', mobile: 'dev.example.dev' })
    assert.equal(j.prodHostSuffix, 'example.vet')
  })
})
