#!/usr/bin/env node
// scripts/wolfpack-prespec.edge.test.mjs — Tracker edge cases for the pre-spec sweep helper
// (state probing, classification, resume wave, campaign parse, decisions table, lint, CLI).
// Run: node --test scripts/wolfpack-prespec.edge.test.mjs
//
// Self-contained (its own fixtures), so it can be copied as-is next to
// wolfpack-prespec.mjs in any repo that ships the helper.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PrespecError, parseCampaignHunts, selectHunts, recordDecision, lintAcceptance, findSpecPlan } from './wolfpack-prespec.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'wolfpack-prespec.mjs')
const run = (args, env = {}) =>
  spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, WOLFPACK_MAX_MANUAL: '', ...env } })

const tmp = () => mkdtempSync(join(tmpdir(), 'prespec-edge-'))

// hunts: [{slug, wave, trigger?, loc: 'worktree'|'main'|null, status, acceptance?, files?, meta?}]
function mkCampaign(root, hunts) {
  const dir = join(root, '.wolfpack', 'campaigns', 'demo')
  mkdirSync(dir, { recursive: true })
  let md = `# Campaign demo\n\n## Proposed Hunts (max ${hunts.length})\n\n`
  hunts.forEach((h, i) => {
    md += `### ${i + 1}. ${h.slug}\n- **Wave:** ${h.wave}\n- **Trigger:** \`/hunt ${h.slug} "x. ${h.trigger || ''}"\`\n\n`
  })
  md += '## Wave Diagram\nnothing\n'
  const cpath = join(dir, 'campaign.md')
  writeFileSync(cpath, md)
  for (const h of hunts) {
    if (!h.loc) continue
    const pd =
      h.loc === 'worktree'
        ? join(root, '.claude', 'worktrees', h.slug, '.wolfpack', 'plans', h.slug)
        : join(root, '.wolfpack', 'plans', h.slug)
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, 'metadata.json'), JSON.stringify({ status: h.status, ...(h.meta || {}) }))
    if (h.acceptance) writeFileSync(join(pd, 'acceptance.md'), h.acceptance)
    for (const f of h.files || []) writeFileSync(join(pd, f), 'x')
  }
  return cpath
}

const ACC = '# Acceptance\n\n## Acceptance criteria\n- AC1 [auto] thing. Check: cmd.\n'
const TABLE = (rows) => `intro\n\n| # | Decision | Status |\n|---|---|---|\n${rows}\n\n*Answers:* after\n`
const row = (n) => `| D${n} | Q${n} | **Decided 2026-10-16:** a${n} |`
const OPTS = { question: 'Q', answer: 'A', hunt: 'alpha-one', date: '2026-10-17' }
const GOOD = `# Acceptance
## Acceptance criteria
- AC1 [auto] one
- AC2 [auto] two
- AC3 [auto] three
- AC4 [manual] four
- AC5 [manual] five
- AC6 [compliance] six

## Repro
- AC2 only: still fine
`

test('state: .agents/worktrees is probed; main-only needs_spec is selected', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [
    { slug: 'agent-one', wave: 1, loc: null },
    { slug: 'main-one', wave: 1, loc: 'main', status: 'needs_spec', acceptance: ACC },
  ])
  const ad = join(root, '.agents', 'worktrees', 'agent-one', '.wolfpack', 'plans', 'agent-one')
  mkdirSync(ad, { recursive: true })
  writeFileSync(join(ad, 'metadata.json'), JSON.stringify({ status: 'ready_for_alpha' }))
  writeFileSync(join(ad, 'acceptance.md'), ACC)
  const r = selectHunts(cpath, { root })
  const sk = Object.fromEntries(r.skipped.map((e) => [e.slug, e]))
  assert.equal(sk['agent-one'].source, 'worktree')
  assert.equal(sk['agent-one'].plan_dir, ad)
  assert.equal(sk['agent-one'].reason, 'has acceptance.md')
  assert.deepEqual(r.selected.map((e) => [e.slug, e.source]), [['main-one', 'main']])
})

test('state: unscaffolded plan_dir is the first worktree candidate', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [{ slug: 'fresh-one', wave: 1, loc: null }])
  const [e] = selectHunts(cpath, { root }).selected
  assert.equal(e.source, 'none')
  assert.equal(e.plan_dir, join(root, '.claude', 'worktrees', 'fresh-one', '.wolfpack', 'plans', 'fresh-one'))
  assert.equal(e.status, null)
})

test('state: malformed metadata.json fails loud, naming the file (fn + CLI exit 1)', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [{ slug: 'bad-meta', wave: 1, loc: 'worktree', status: 'x' }])
  const mf = join(root, '.claude', 'worktrees', 'bad-meta', '.wolfpack', 'plans', 'bad-meta', 'metadata.json')
  writeFileSync(mf, '{ not json')
  assert.throws(() => selectHunts(cpath, { root }), (e) => e instanceof PrespecError && e.message.includes(mf))
  const r = run(['list', cpath, '--root', root])
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes(mf))
})

test('classify: parked without acceptance, unknown status, plan artifacts', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [
    { slug: 'p-park', wave: 1, loc: 'worktree', status: 'parked:needs_human' },
    { slug: 'p-odd', wave: 1, loc: 'worktree', status: 'planning' },
    { slug: 'p-rev', wave: 1, loc: 'worktree', status: 'ready_for_alpha', files: ['review-1.md'] },
    { slug: 'p-revised', wave: 1, loc: 'worktree', status: 'ready_for_alpha', files: ['plan-revised-2.md'] },
    { slug: 'p-cnm', wave: 1, loc: 'worktree', status: 'certified_not_merged' },
  ])
  const r = selectHunts(cpath, { root })
  assert.deepEqual(r.selected, [])
  const why = Object.fromEntries(r.skipped.map((e) => [e.slug, e.reason]))
  assert.equal(why['p-park'], 'parked (past Spec — /resolve)')
  assert.equal(why['p-odd'], 'past Spec (planning)')
  assert.equal(why['p-rev'], 'past Spec')
  assert.equal(why['p-revised'], 'past Spec')
  assert.equal(why['p-cnm'], 'done')
})

test('resume wave: a wave holding only a parked hunt is still the resume wave', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [
    { slug: 'a-one', wave: 1, loc: 'worktree', status: 'merged' },
    { slug: 'b-one', wave: 2, loc: 'worktree', status: 'parked:open_critical' },
    { slug: 'c-one', wave: 3, loc: null },
  ])
  const r = selectHunts(cpath, { root, wave: true })
  assert.equal(r.resume_wave, 2)
  assert.equal(r.mode, 'wave')
  assert.deepEqual(r.selected, [])
  assert.deepEqual(r.skipped.map((e) => e.slug), ['b-one'])
  assert.equal(selectHunts(cpath, { root }).resume_wave, 2)
})

test('resume wave is null when every hunt is done', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [{ slug: 'a-one', wave: 1, loc: 'worktree', status: 'merged' }])
  const r = selectHunts(cpath, { root, wave: true })
  assert.equal(r.resume_wave, null)
  assert.deepEqual(r.selected, [])
})

test('root defaults from .wolfpack/campaigns/<slug>/campaign.md', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [{ slug: 'alpha-one', wave: 1, loc: 'worktree', status: 'ready_for_alpha' }])
  const r = selectHunts(cpath)
  assert.equal(r.root, root)
  assert.deepEqual(r.selected.map((e) => [e.slug, e.source]), [['alpha-one', 'worktree']])
  const c = run(['list', cpath, '--wave'])
  assert.equal(c.status, 0)
  const j = JSON.parse(c.stdout)
  assert.equal(j.root, root)
  assert.equal(j.mode, 'wave')
  assert.equal(j.resume_wave, 1)
})

test('parse: wave forms, BLOCKED variants, section bounds, field order', () => {
  const md = `# c
## Proposed Hunts (max 9)
### 1. late-one
- **Trigger:** \`/hunt late-one "x"\`
- **Wave:** 3 (after T1)
### 2. bold-one
- **Wave:** **2**
#### notes
- **Wave:** 9
### 3. block-one
- **Wave:** BLOCKED — needs a decision
### 4. block-two
- **Wave:** **Blocked**
### 5. early-one
- **Wave:** 2
## Wave Diagram
### 6. outside-one
- **Wave:** 1
`
  const h = parseCampaignHunts(md)
  assert.deepEqual(h.map((x) => [x.slug, x.wave]), [['bold-one', 2], ['early-one', 2], ['late-one', 3]])
  assert.equal(h.find((x) => x.slug === 'late-one').trigger, '`/hunt late-one "x"`')
  assert.throws(() => parseCampaignHunts('## Proposed Hunts\n### 1. no-wave\n- **Trigger:** x\n'), /hunt no-wave: unreadable Wave ''/)
  assert.throws(() => parseCampaignHunts('## Proposed Hunts\nnothing here\n'), /lists no hunts/)
})

test('spec plan: Trigger path wins over campaign Plan; quoted/§ forms parse', () => {
  const root = tmp()
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'a.md'), '# a')
  writeFileSync(join(root, 'docs', 'b.md'), '# b')
  const r = findSpecPlan('/hunt x "d. Spec: `docs/a.md`§7.4, §7.5a."', '**Plan:** docs/b.md\n', root)
  assert.deepEqual(r, { path: join(root, 'docs', 'a.md'), from: 'trigger' })
  const m = findSpecPlan('/hunt x "d."', '- **Plan:** `docs/missing.md`\n', root)
  assert.equal(m.path, null)
  assert.match(m.note, /Campaign names docs\/missing\.md but it does not exist/)
})

test('decisions: extra columns are padded, escaped-pipe questions stay idempotent', () => {
  const md = '| # | Decision | Status | Owner |\n|---|---|---|---|\n| D2 | Q2 | **Decided 2026-10-16:** a2 | me |\n'
  const one = recordDecision(md, { ...OPTS, question: 'Size | weight?' })
  assert.equal(one.id, 'D3')
  const added = one.md.split('\n')[3]
  assert.equal(added, '| D3 | Size \\| weight? | **Decided 2026-10-17** (pre-spec sweep, alpha-one): A |  |')
  assert.equal(one.md.endsWith('\n'), true)
  const two = recordDecision(one.md, { ...OPTS, question: 'size |  WEIGHT?' })
  assert.equal(two.action, 'exists')
  assert.equal(two.md, one.md)
})

test('decisions: an answer contained in a longer Decided status counts as exists', () => {
  const md = TABLE('| D1 | Capacity model | **Decided 2026-10-16:** kennel inventory by size in Settings; overflow by hand |')
  const r = recordDecision(md, { ...OPTS, question: 'capacity model', answer: 'Kennel inventory by size in Settings' })
  assert.deepEqual([r.action, r.id, r.md], ['exists', 'D1', md])
})

test('decisions: non-D rows are kept and ignored for numbering; header without separator is not a table', () => {
  const md = '| # | Decision | Status |\n|---|---|---|\n| X1 | other | n/a |\n| D7 | Q7 | **Decided 2026-10-16:** a7 |\n'
  const r = recordDecision(md, OPTS)
  assert.equal(r.id, 'D8')
  assert.ok(r.md.includes('| X1 | other | n/a |\n| D7 |'))
  assert.throws(() => recordDecision('| # | Decision | Status |\n| D1 | q | s |\n', OPTS), /no recognisable decisions table/)
})

test('CLI record-decision: missing flags → 2, missing file → 2, no temp file left', () => {
  const dir = tmp()
  const f = join(dir, 'plan.md')
  writeFileSync(f, TABLE(row(1)))
  assert.equal(run(['record-decision', f, '--hunt', 'alpha-one', '--question', 'Q']).status, 2)
  assert.equal(run(['record-decision', join(dir, 'nope.md'), '--hunt', 'h', '--question', 'Q', '--answer', 'A']).status, 2)
  const bad = run(['record-decision', f, '--hunt', 'h', '--question', 'Q', '--answer', 'A', '--date', '2026/10/17'])
  assert.equal(bad.status, 1)
  assert.equal(readFileSync(f, 'utf8'), TABLE(row(1)))
  const ok = run(['record-decision', f, '--hunt', 'h', '--question', 'Q', '--answer', 'A', '--date', '2026-10-17'])
  assert.equal(ok.status, 0)
  assert.deepEqual(readdirSync(dir).sort(), ['plan.md'])
  assert.match(readFileSync(f, 'utf8'), /\| D2 \| Q \| \*\*Decided 2026-10-17\*\* \(pre-spec sweep, h\): A \|/)
})

test('lint: tag with no text, ### inside the section, one error per bad line', () => {
  const md = `## Acceptance criteria
- AC1 [auto]
### Sub-group
- AC2 [bogus] x
- AC3 [auto] fine
`
  const r = lintAcceptance(md)
  assert.equal(r.ok, false)
  assert.deepEqual(r.errors.map((e) => e.id), ['AC1', 'AC2'])
  assert.match(r.errors[0].message, /AC1: not parsed .* release\/smoke would drop it/)
})

test('lint: out-of-section untagged AC prose stays legal; duplicate reported once', () => {
  const md = `## Acceptance criteria
- AC1 [auto] a
- AC1 [auto] b
- AC1 [manual] c

## Repro
- AC1 only: run it
- AC2 then the other
`
  const r = lintAcceptance(md)
  assert.deepEqual(r.errors.map((e) => e.message), ['AC1: duplicate id'])
})

test('lint CLI: OK line text, error lines on stdout, missing file / negative budget → 2', () => {
  const dir = tmp()
  const f = join(dir, 'a.md')
  writeFileSync(f, GOOD)
  const ok = run(['lint', f])
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout.trim(), `OK ${f}: 6 criteria (3 auto, 2 manual, 1 compliance)`)
  const z = run(['lint', f, '--max-manual=0'])
  assert.equal(z.status, 1)
  assert.match(z.stdout, /2 \[manual\] criteria \(max 0\): AC4, AC5/)
  assert.equal(run(['lint', join(dir, 'nope.md')]).status, 2)
  assert.equal(run(['lint', f, '--max-manual=-1']).status, 2)
  assert.equal(run(['lint', f], { WOLFPACK_MAX_MANUAL: 'two' }).status, 2)
})
