#!/usr/bin/env node
// scripts/wolfpack-workflows.test.mjs — the stamped-workflow generator/checker
// (pack-install-model AC4 + D2/D3). Run: node --test scripts/wolfpack-workflows.test.mjs
//
// Real files, real git: a FIXTURE pack (temp git repo holding copies of the canonical
// .agents/workflows/*.js, tagged v9.9.9) and temp consumers. AC4 also runs against the REAL pack.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  STAMP_RE, CANONICAL_STAMP_LINE, sourceHash, stampLine, render, parseStamp, packInfo,
  workflowNames, checkWorkflow, checkAll, generate, installFix,
} from './wolfpack-workflows.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REAL_PACK = join(here, '..')
const CLI = join(here, 'wolfpack-workflows.mjs')
const NAMES = ['campaign-runner.js', 'hunt-pipeline.js']

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', cwd, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

// A fixture pack: a git repo with the canonical workflows, committed and tagged v9.9.9.
function fixturePack() {
  const dir = tmp('wf-pack-')
  mkdirSync(join(dir, '.agents', 'workflows'), { recursive: true })
  for (const n of NAMES) copyFileSync(join(REAL_PACK, '.agents', 'workflows', n), join(dir, '.agents', 'workflows', n))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '.agents/workflows')
  git(dir, 'commit', '-q', '-m', 'init')
  git(dir, 'tag', 'v9.9.9')
  return dir
}
const consumerDir = () => tmp('wf-consumer-')
const wf = (consumer, name) => join(consumer, '.claude', 'workflows', name)
// Every file under a tree with its bytes (for "nothing written" assertions).
function snapshot(root) {
  const out = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) out[p] = `link`
      else if (e.isDirectory()) { if (e.name !== '.git') walk(p) }
      else out[p] = readFileSync(p, 'utf8')
    }
  }
  walk(root)
  return out
}

test('every real canonical workflow carries exactly ONE null stamp line, the canonical form', () => {
  for (const n of NAMES) {
    const text = readFileSync(join(REAL_PACK, '.agents', 'workflows', n), 'utf8')
    const m = [...text.matchAll(new RegExp(STAMP_RE.source, 'gm'))]
    assert.equal(m.length, 1, n)
    assert.equal(m[0][1], 'null', n)
    assert.equal(m[0][0], CANONICAL_STAMP_LINE, n)
    assert.ok(text.startsWith('export const meta'), n)
  }
  assert.deepEqual(workflowNames(REAL_PACK), NAMES)
})

test('render refuses a canonical with 0 or 2 stamp lines, an already-stamped one, or one not starting with export const meta', () => {
  const canon = readFileSync(join(REAL_PACK, '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
  const stamp = { workflow: 'hunt-pipeline.js', commit: 'a'.repeat(40), version: 'v1', source: sourceHash(canon) }
  assert.throws(() => render(canon.replace(CANONICAL_STAMP_LINE, '// no stamp'), stamp), /exactly one wolfpack-stamp line, found 0/)
  assert.throws(() => render(`${canon}\n${CANONICAL_STAMP_LINE}\n`, stamp), /exactly one wolfpack-stamp line, found 2/)
  assert.throws(() => render(render(canon, stamp), stamp), /not the null form/)
  assert.throws(() => render(`// header\n${canon}`, stamp), /does not start with 'export const meta'/)
  // a good render changes exactly the one stamp line
  const out = render(canon, stamp)
  const a = canon.split('\n'), b = out.split('\n')
  assert.equal(a.length, b.length)
  const diff = a.map((l, i) => (l === b[i] ? null : i)).filter(i => i !== null)
  assert.equal(diff.length, 1)
  assert.equal(b[diff[0]], stampLine(stamp))
})

test('parseStamp: round-trips a rendered stamp; names every malformed shape', () => {
  const canon = readFileSync(join(REAL_PACK, '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
  const stamp = { workflow: 'campaign-runner.js', commit: 'b'.repeat(40), version: 'v9.9.9', source: sourceHash(canon) }
  assert.deepEqual(parseStamp(render(canon, stamp)), { stamp, error: null })
  assert.match(parseStamp('x').error, /no wolfpack-stamp line/)
  assert.match(parseStamp(canon).error, /null stamp/)
  assert.match(parseStamp(`${stampLine(stamp)}\n${stampLine(stamp)}`).error, /2 wolfpack-stamp lines/)
  assert.match(parseStamp('const WOLFPACK_STAMP = {not json} // wolfpack-stamp').error, /not valid JSON/)
  assert.match(parseStamp(stampLine({ ...stamp, commit: 'abc' })).error, /commit \(40-hex\)/)
  assert.match(parseStamp(stampLine({ ...stamp, source: 'md5:x' })).error, /source \(sha256:<64-hex>\)/)
  assert.match(parseStamp(stampLine({ ...stamp, workflow: '', version: '' })).error, /workflow, version/)
})

test('AC4: generate into a temp consumer from the REAL pack — stamp names HEAD, describe, source hash; a second run is unchanged and byte-identical', () => {
  const consumer = consumerDir()
  try {
    const head = git(REAL_PACK, 'rev-parse', 'HEAD')
    const describe = git(REAL_PACK, 'describe', '--tags', '--match', 'v[0-9]*')
    const r1 = generate({ pack: REAL_PACK, consumer })
    assert.equal(r1.ok, true)
    assert.deepEqual(r1.results.map(x => x.action), ['generated', 'generated'])
    const first = {}
    for (const n of NAMES) {
      const text = readFileSync(wf(consumer, n), 'utf8')
      first[n] = text
      assert.ok(text.startsWith('export const meta'), n)
      const { stamp, error } = parseStamp(text)
      assert.equal(error, null, n)
      assert.equal(stamp.workflow, n)
      assert.equal(stamp.commit, head)
      assert.equal(stamp.version, describe)
      assert.equal(stamp.source, sourceHash(readFileSync(join(REAL_PACK, '.agents', 'workflows', n), 'utf8')))
      assert.equal(statSync(wf(consumer, n)).mode & 0o777, 0o644, `${n} mode`)
      assert.equal(lstatSync(wf(consumer, n)).isSymbolicLink(), false)
    }
    const r2 = generate({ pack: REAL_PACK, consumer })
    assert.deepEqual(r2.results.map(x => x.action), ['unchanged', 'unchanged'])
    for (const n of NAMES) assert.equal(readFileSync(wf(consumer, n), 'utf8'), first[n], `${n} byte-identical`)
    // no temp files left behind
    assert.deepEqual(readdirSync(join(consumer, '.claude', 'workflows')).sort(), NAMES)
    const c = checkAll({ pack: REAL_PACK, consumer })
    assert.equal(c.ok, true)
    assert.deepEqual(c.workflows.map(w => w.state), ['current', 'current'])
    assert.equal(c.packCommit, head)
    assert.equal(c.packVersion, describe)
  } finally { rmSync(consumer, { recursive: true, force: true }) }
})

test('staleness is by CONTENT: an unrelated pack commit stays current; a canonical change is stale; a hand edit is modified; a removed stamp is unstamped; a deleted copy is missing', () => {
  const pack = fixturePack()
  const consumer = consumerDir()
  try {
    generate({ pack, consumer })
    assert.deepEqual(checkAll({ pack, consumer }).workflows.map(w => w.state), ['current', 'current'])
    // (A1) unrelated commit: pack HEAD moves, the canonical bytes do not
    writeFileSync(join(pack, 'README.md'), 'x\n')
    git(pack, 'add', 'README.md'); git(pack, 'commit', '-q', '-m', 'unrelated')
    const after = checkAll({ pack, consumer })
    assert.deepEqual(after.workflows.map(w => w.state), ['current', 'current'])
    assert.equal(after.ok, true)
    assert.notEqual(after.packCommit, after.workflows[0].stamp.commit, 'HEAD moved but the copy is still current')
    // a canonical change → stale, with the install fix
    const hp = join(pack, '.agents', 'workflows', 'hunt-pipeline.js')
    writeFileSync(hp, `${readFileSync(hp, 'utf8')}\n// changed\n`)
    const stale = checkWorkflow({ pack, consumer, name: 'hunt-pipeline.js' })
    assert.equal(stale.state, 'stale')
    assert.equal(stale.fix, `bash '${pack}/install.sh' --consumer '${consumer}'`)
    assert.equal(stale.canonicalSource, sourceHash(readFileSync(hp, 'utf8')))
    assert.notEqual(stale.stamp.source, stale.canonicalSource)
    assert.equal(checkAll({ pack, consumer }).ok, false)
    // regenerate → current again. Both are rewritten: the runner copy was still CURRENT, but its
    // stamp's display commit is the pre-README HEAD, so the generated bytes differ ('regenerated').
    const re = generate({ pack, consumer })
    assert.deepEqual(re.results.map(x => [x.name, x.action]), [['campaign-runner.js', 'regenerated'], ['hunt-pipeline.js', 'regenerated']])
    assert.deepEqual(generate({ pack, consumer }).results.map(x => x.action), ['unchanged', 'unchanged'], 'same HEAD → unchanged')
    assert.equal(checkWorkflow({ pack, consumer, name: 'hunt-pipeline.js' }).state, 'current')
    // a hand edit under an intact stamp → modified
    const cr = wf(consumer, 'campaign-runner.js')
    const good = readFileSync(cr, 'utf8')
    writeFileSync(cr, good.replace('phase(\'Parse\')', 'phase(\'Parse\') // hand edit'))
    const mod = checkWorkflow({ pack, consumer, name: 'campaign-runner.js' })
    assert.equal(mod.state, 'modified')
    assert.equal(mod.fix, `bash '${pack}/install.sh' --consumer '${consumer}'`)
    assert.ok(mod.stamp && mod.stamp.source === mod.canonicalSource, 'the stamp itself is intact')
    // the stamp line removed → unstamped
    writeFileSync(cr, good.replace(/^const WOLFPACK_STAMP = .*$/m, ''))
    const un = checkWorkflow({ pack, consumer, name: 'campaign-runner.js' })
    assert.equal(un.state, 'unstamped')
    assert.match(un.error, /no wolfpack-stamp line/)
    // the canonical (null) form copied verbatim into a consumer → unstamped too (never 'current')
    copyFileSync(join(pack, '.agents', 'workflows', 'campaign-runner.js'), cr)
    assert.equal(checkWorkflow({ pack, consumer, name: 'campaign-runner.js' }).state, 'unstamped')
    // deleted → missing
    rmSync(cr)
    assert.equal(checkWorkflow({ pack, consumer, name: 'campaign-runner.js' }).state, 'missing')
    // and generate repairs every state
    generate({ pack, consumer })
    assert.deepEqual(checkAll({ pack, consumer }).workflows.map(w => w.state), ['current', 'current'])
  } finally {
    rmSync(pack, { recursive: true, force: true }); rmSync(consumer, { recursive: true, force: true })
  }
})

test('canonical-self: a consumer whose .claude/workflows links to the pack\'s .agents/workflows is canonical; generate writes nothing', () => {
  const pack = fixturePack()
  try {
    mkdirSync(join(pack, '.claude'))
    symlinkSync('../.agents/workflows', join(pack, '.claude', 'workflows'))
    const before = snapshot(pack)
    const c = checkAll({ pack, consumer: pack })
    assert.equal(c.ok, true)
    assert.deepEqual(c.workflows.map(w => [w.state, w.fix]), [['canonical', null], ['canonical', null]])
    const g = generate({ pack, consumer: pack })
    assert.equal(g.ok, true)
    assert.deepEqual(g.results.map(x => x.action), ['canonical', 'canonical'])
    assert.deepEqual(snapshot(pack), before, 'canonical bytes unchanged, nothing new written')
    // a separate consumer whose dir links (absolute) to the pack's canonical dir → canonical too
    const consumer = consumerDir()
    mkdirSync(join(consumer, '.claude'))
    symlinkSync(join(pack, '.agents', 'workflows'), join(consumer, '.claude', 'workflows'))
    assert.deepEqual(checkAll({ pack, consumer }).workflows.map(w => w.state), ['canonical', 'canonical'])
    rmSync(consumer, { recursive: true, force: true })
  } finally { rmSync(pack, { recursive: true, force: true }) }
})

test('a FILE-level symlink to the canonical is canonical; to anything else it is foreign-link (generate rc-refuses)', () => {
  const pack = fixturePack()
  const consumer = consumerDir()
  const other = tmp('wf-other-')
  try {
    mkdirSync(join(consumer, '.claude', 'workflows'), { recursive: true })
    symlinkSync(join(pack, '.agents', 'workflows', 'hunt-pipeline.js'), wf(consumer, 'hunt-pipeline.js'))
    writeFileSync(join(other, 'campaign-runner.js'), 'export const meta = {}\n')
    symlinkSync(join(other, 'campaign-runner.js'), wf(consumer, 'campaign-runner.js'))
    const c = checkAll({ pack, consumer })
    const by = Object.fromEntries(c.workflows.map(w => [w.name, w]))
    assert.equal(by['hunt-pipeline.js'].state, 'canonical')
    assert.equal(by['campaign-runner.js'].state, 'foreign-link')
    assert.equal(by['campaign-runner.js'].target, join(other, 'campaign-runner.js'))
    assert.match(by['campaign-runner.js'].fix, /^remove .*campaign-runner\.js or point WOLFPACK_HOME at the pack it links to$/)
    const before = readFileSync(join(other, 'campaign-runner.js'), 'utf8')
    const g = generate({ pack, consumer })
    assert.equal(g.ok, false)
    const gby = Object.fromEntries(g.results.map(x => [x.name, x]))
    assert.equal(gby['campaign-runner.js'].refused, true)
    assert.equal(gby['hunt-pipeline.js'].action, 'canonical')
    assert.equal(readFileSync(join(other, 'campaign-runner.js'), 'utf8'), before, 'never written through the link')
    assert.equal(lstatSync(wf(consumer, 'campaign-runner.js')).isSymbolicLink(), true, 'the link is left in place')
  } finally {
    for (const d of [pack, consumer, other]) rmSync(d, { recursive: true, force: true })
  }
})

test('a DIR link to another dir holding a copy → foreign-link, generate rc 2; a dir link to an EMPTY dir → rc 2, nothing written', () => {
  const pack = fixturePack()
  const consumer = consumerDir()
  const elsewhere = tmp('wf-else-')
  const empty = tmp('wf-empty-')
  try {
    // elsewhere holds a (current-looking) generated copy from the same pack
    const scratch = consumerDir()
    generate({ pack, consumer: scratch })
    for (const n of NAMES) copyFileSync(wf(scratch, n), join(elsewhere, n))
    rmSync(scratch, { recursive: true, force: true })
    mkdirSync(join(consumer, '.claude'))
    symlinkSync(elsewhere, join(consumer, '.claude', 'workflows'))
    assert.deepEqual(checkAll({ pack, consumer }).workflows.map(w => w.state), ['foreign-link', 'foreign-link'])
    const before = snapshot(elsewhere)
    let r = cli('generate', '--pack', pack, '--consumer', consumer)
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /✗ refused .*campaign-runner\.js/)
    assert.deepEqual(snapshot(elsewhere), before)
    // dangling-ish: a dir link to an empty dir
    rmSync(join(consumer, '.claude', 'workflows'))
    symlinkSync(empty, join(consumer, '.claude', 'workflows'))
    const c = checkAll({ pack, consumer })
    assert.deepEqual(c.workflows.map(w => w.state), ['foreign-link', 'foreign-link'])
    r = cli('generate', '--pack', pack, '--consumer', consumer)
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.deepEqual(readdirSync(empty), [], 'nothing written through the dir link')
    // a symlinked <consumer>/.claude (not .claude/workflows) is refused too
    rmSync(join(consumer, '.claude'), { recursive: true, force: true })
    const realClaude = tmp('wf-claude-')
    symlinkSync(realClaude, join(consumer, '.claude'))
    const g = generate({ pack, consumer })
    assert.equal(g.ok, false)
    assert.ok(g.results.every(x => x.refused && /is a symlink — refusing to write through it/.test(x.reason)), JSON.stringify(g.results))
    assert.deepEqual(readdirSync(realClaude), [])
    rmSync(realClaude, { recursive: true, force: true })
  } finally {
    for (const d of [pack, consumer, elsewhere, empty]) rmSync(d, { recursive: true, force: true })
  }
})

test('the REAL wolfpack checkout: checkAll({ pack: root, consumer: root }) → both canonical', () => {
  const c = checkAll({ pack: REAL_PACK, consumer: REAL_PACK })
  assert.equal(c.ok, true)
  assert.deepEqual(c.workflows.map(w => [w.name, w.state]), [['campaign-runner.js', 'canonical'], ['hunt-pipeline.js', 'canonical']])
})

test('packInfo: the version is the nearest RELEASE tag (v*), never a lightweight pre-hunt marker tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wpwf-tag-'))
  try {
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a'), '1\n')
    git(dir, 'add', 'a'); git(dir, 'commit', '-q', '-m', 'one')
    git(dir, 'tag', '-a', 'v1.2.3', '-m', 'release')
    writeFileSync(join(dir, 'a'), '2\n')
    git(dir, 'commit', '-q', '-am', 'two')
    git(dir, 'tag', 'pre-hunt-something')
    const { version } = packInfo(dir)
    assert.match(version, /^v1\.2\.3-1-g[0-9a-f]+$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('packInfo: a pack with no reachable tag fails loud with the fetch --tags fix', () => {
  const dir = tmp('wf-notag-')
  try {
    mkdirSync(join(dir, '.agents', 'workflows'), { recursive: true })
    copyFileSync(join(REAL_PACK, '.agents', 'workflows', 'hunt-pipeline.js'), join(dir, '.agents', 'workflows', 'hunt-pipeline.js'))
    git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'x')
    assert.throws(() => packInfo(dir), new RegExp(`no v\\* release tag reachable\\) — fix: git -C '${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' fetch --tags`))
    const consumer = consumerDir()
    const r = cli('check', '--pack', dir, '--consumer', consumer)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /fetch --tags/)
    rmSync(consumer, { recursive: true, force: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI: exit codes 0 / 1 / 2 and the --json shape', () => {
  const pack = fixturePack()
  const consumer = consumerDir()
  try {
    // usage errors → 2
    for (const args of [[], ['frob'], ['check'], ['check', '--consumer'], ['check', '--consumer', '--json'], ['check', '--consumer', consumer, '--bogus']]) {
      const r = cli(...args)
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`)
      assert.match(r.stderr, /usage: node scripts\/wolfpack-workflows\.mjs generate\|check/)
    }
    // a consumer that is not a directory → 2 naming it
    const nodir = join(consumer, 'nope')
    let r = cli('check', '--pack', pack, '--consumer', nodir)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /consumer is not a directory: .*nope/)
    // nothing generated yet → 1, a ✗ missing line per workflow with the fix
    r = cli('check', '--pack', pack, '--consumer', consumer)
    assert.equal(r.status, 1)
    assert.equal(r.stdout.trim().split('\n').filter(l => l.startsWith('✗ missing ')).length, 2)
    assert.ok(r.stdout.includes(`— fix: bash '${pack}/install.sh' --consumer '${consumer}'`))
    // generate → 0
    r = cli('generate', '--pack', pack, '--consumer', consumer)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^generated .*campaign-runner\.js \(v9\.9\.9 @ [0-9a-f]{12}\)$/m)
    r = cli('generate', '--pack', pack, '--consumer', consumer)
    assert.match(r.stdout, /^unchanged .*hunt-pipeline\.js/m)
    // check → 0, with ✓ current lines
    r = cli('check', '--pack', pack, '--consumer', consumer)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^✓ current .*hunt-pipeline\.js \(v9\.9\.9 @ [0-9a-f]{12}\)$/m)
    // --json: ONE object with the documented fields
    r = cli('check', '--pack', pack, '--consumer', consumer, '--json')
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim().split('\n').length, 1, 'one line')
    const j = JSON.parse(r.stdout)
    assert.deepEqual(Object.keys(j).sort(), ['consumer', 'ok', 'pack', 'packCommit', 'packVersion', 'workflows'])
    assert.equal(j.ok, true)
    assert.equal(j.packVersion, 'v9.9.9')
    assert.match(j.packCommit, /^[0-9a-f]{40}$/)
    for (const w of j.workflows) {
      for (const k of ['name', 'file', 'state', 'stamp', 'canonicalSource', 'fix']) assert.ok(k in w, `${w.name}.${k}`)
      assert.equal(w.state, 'current')
      assert.equal(w.fix, null)
      assert.match(w.canonicalSource, /^sha256:[0-9a-f]{64}$/)
    }
    // a hand edit → check --json exit 1, ok false, the entry modified with its fix
    const hp = wf(consumer, 'hunt-pipeline.js')
    writeFileSync(hp, `${readFileSync(hp, 'utf8')}// edit\n`)
    r = cli('check', '--pack', pack, '--consumer', consumer, '--json')
    assert.equal(r.status, 1)
    const j2 = JSON.parse(r.stdout)
    assert.equal(j2.ok, false)
    const e = j2.workflows.find(w => w.name === 'hunt-pipeline.js')
    assert.equal(e.state, 'modified')
    assert.equal(e.fix, `bash '${pack}/install.sh' --consumer '${consumer}'`)
    r = cli('check', '--pack', pack, '--consumer', consumer)
    assert.match(r.stdout, /^✗ modified .*hunt-pipeline\.js \(stamped v9\.9\.9 @ [0-9a-f]{12}; stamp intact but the bytes are not the generated copy\) — fix: /m)
    // --pack defaults to this script's repo root
    const d = cli('check', '--consumer', REAL_PACK, '--json')
    assert.equal(d.status, 0, d.stderr)
    assert.equal(JSON.parse(d.stdout).pack, REAL_PACK)
    assert.equal(existsSync(join(consumer, '.claude', 'workflows')), true)
  } finally {
    rmSync(pack, { recursive: true, force: true }); rmSync(consumer, { recursive: true, force: true })
  }
})

// ─── merge-and-state-hygiene AC22: installFix shell-quotes both paths ─────────────────────────
test("AC22: installFix's line round-trips argv for paths with ', space and $ (bash -c)", () => {
  const cases = [
    ["/tmp/o'brien/pack", "/tmp/o b'x/repo"],
    ['/tmp/a b/$HOME/pack', "/tmp/it's $(x)/r"],
    ["/p'''q", "/c'"],
  ]
  for (const [pack, consumer] of cases) {
    const cmd = installFix(pack, consumer).replace(/^bash /, "printf '%s\\n' ")
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
    assert.equal(r.status, 0, `bash cannot run: ${cmd}\n${r.stderr}`)
    assert.deepEqual(r.stdout.replace(/\n$/, '').split('\n'), [`${pack}/install.sh`, '--consumer', consumer], cmd)
  }
})

test('AC22: a quote-free path keeps the exact old fix line (byte-identical)', () => {
  assert.equal(installFix('/pack', '/repo'), "bash '/pack/install.sh' --consumer '/repo'")
  assert.equal(installFix('/a b/pack', '/c d'), "bash '/a b/pack/install.sh' --consumer '/c d'")
})
