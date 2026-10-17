#!/usr/bin/env node
// scripts/wolfpack-prespec.test.mjs — unit tests for the pre-spec sweep helper.
// Run: node --test scripts/wolfpack-prespec.test.mjs
//
// Set WOLFPACK_PRESPEC_LINT_FILES (path-delimited) to also lint real acceptance files.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  PrespecError,
  parseCampaignHunts,
  selectHunts,
  recordDecision,
  lintAcceptance,
  findSpecPlan,
} from './wolfpack-prespec.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'wolfpack-prespec.mjs')
const run = (args, env = {}) =>
  spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, WOLFPACK_MAX_MANUAL: '', ...env } })

const tmp = () => mkdtempSync(join(tmpdir(), 'prespec-'))

// hunts: [{slug, wave, trigger?, loc: 'worktree'|'main'|null, status, acceptance?, files?, meta?}]
function mkCampaign(root, hunts, extra = '') {
  const dir = join(root, '.wolfpack', 'campaigns', 'demo')
  mkdirSync(dir, { recursive: true })
  let md = `# Campaign demo\n\n${extra}\n## Proposed Hunts (max ${hunts.length})\n\n`
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

function bigFixture() {
  const root = tmp()
  const cpath = mkCampaign(root, [
    { slug: 'w1-merged', wave: 1, loc: 'worktree', status: 'merged' },
    { slug: 'w1-needs', wave: 1, loc: 'worktree', status: 'needs_spec', acceptance: ACC },
    { slug: 'w1-new', wave: 1, loc: null },
    { slug: 'w2-ready', wave: 2, loc: 'worktree', status: 'ready_for_alpha' },
    { slug: 'w2-has', wave: 2, loc: 'worktree', status: 'ready_for_alpha', acceptance: ACC },
    { slug: 'w2-past', wave: 2, loc: 'worktree', status: 'reviewing', files: ['plan.md'] },
    { slug: 'w3-parked', wave: 3, loc: 'worktree', status: 'parked:open_critical' },
    { slug: 'w3-new', wave: 3, loc: null },
    { slug: 'w9-blocked', wave: 'BLOCKED', loc: null },
  ])
  return { root, cpath }
}

test('AC1 default selection spans all waves in wave order', () => {
  const { root, cpath } = bigFixture()
  const r = selectHunts(cpath, { root })
  assert.equal(r.mode, 'all')
  assert.deepEqual(
    r.selected.map((e) => e.slug),
    ['w1-needs', 'w1-new', 'w2-ready', 'w3-new'],
  )
  const all = [...r.selected, ...r.skipped].map((e) => e.slug)
  assert.ok(!all.includes('w9-blocked'))
})

test('AC1 --wave keeps the resume wave only', () => {
  const { root, cpath } = bigFixture()
  const r = selectHunts(cpath, { root, wave: true })
  assert.equal(r.resume_wave, 1)
  assert.deepEqual(r.selected.map((e) => e.slug), ['w1-needs', 'w1-new'])
})

test('resume wave skips a fully-done wave', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [
    { slug: 'a-one', wave: 1, loc: 'worktree', status: 'merged' },
    { slug: 'a-two', wave: 1, loc: 'worktree', status: 'certified' },
    { slug: 'b-one', wave: 2, loc: null },
  ])
  assert.equal(selectHunts(cpath, { root }).resume_wave, 2)
})

test('worktree copy wins over main copy', () => {
  const root = tmp()
  const cpath = mkCampaign(root, [{ slug: 'alpha-one', wave: 1, loc: 'main', status: 'ready_for_alpha' }])
  const wt = join(root, '.claude', 'worktrees', 'alpha-one', '.wolfpack', 'plans', 'alpha-one')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, 'metadata.json'), JSON.stringify({ status: 'ready_for_alpha' }))
  writeFileSync(join(wt, 'acceptance.md'), ACC)
  const r = selectHunts(cpath, { root })
  assert.deepEqual(r.selected, [])
  assert.equal(r.skipped[0].source, 'worktree')
})

test('AC3 re-run is idempotent', () => {
  const { root, cpath } = bigFixture()
  const first = selectHunts(cpath, { root })
  for (const e of first.selected) {
    if (e.source === 'none') {
      mkdirSync(e.plan_dir, { recursive: true })
    }
    writeFileSync(join(e.plan_dir, 'acceptance.md'), ACC)
    writeFileSync(join(e.plan_dir, 'metadata.json'), JSON.stringify({ status: 'ready_for_alpha' }))
  }
  assert.deepEqual(selectHunts(cpath, { root }).selected, [])
})

test('spec plan lookup: trigger, campaign, none, missing', () => {
  const root = tmp()
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'p.md'), '# p')
  const a = findSpecPlan('/hunt x "d. Spec: docs/p.md §7."', '', root)
  assert.equal(a.from, 'trigger')
  assert.equal(a.path, join(root, 'docs', 'p.md'))
  const b = findSpecPlan('/hunt x "d."', '# c\n- Plan: docs/p.md\n', root)
  assert.equal(b.from, 'campaign')
  const c = findSpecPlan('/hunt x "d."', '# c\n', root)
  assert.equal(c.path, null)
  const d = findSpecPlan('/hunt x "Spec: docs/nope.md"', '', root)
  assert.equal(d.path, null)
  assert.match(d.note, /docs\/nope\.md but it does not exist/)
})

test('parse fails loud', () => {
  assert.throws(() => parseCampaignHunts('# c\n## Other\n'), PrespecError)
  assert.throws(() => parseCampaignHunts('## Proposed Hunts\n### 1. a-b\n- **Wave:** soon\n'), /unreadable Wave/)
  const root = tmp()
  const p = join(root, 'campaign.md')
  writeFileSync(p, '# c\n')
  const r = run(['list', p, '--root', root])
  assert.notEqual(r.status, 0)
})

const TABLE = (rows) => `intro\n\n| # | Decision | Status |\n|---|---|---|\n${rows}\n\n*Answers:* after\n`
const row = (n) => `| D${n} | Q${n} | **Decided 2026-10-16:** a${n} |`
const OPTS = { question: 'Q', answer: 'A', hunt: 'alpha-one', date: '2026-10-17' }

test('AC5 next number, exact row, rest byte-identical', () => {
  const md = TABLE([1, 2, 3, 4, 5].map(row).join('\n'))
  const r = recordDecision(md, OPTS)
  assert.equal(r.id, 'D6')
  assert.equal(r.action, 'added')
  const lines = r.md.split('\n')
  const i = lines.indexOf(row(5))
  assert.equal(lines[i + 1], '| D6 | Q | **Decided 2026-10-17** (pre-spec sweep, alpha-one): A |')
  lines.splice(i + 1, 1)
  assert.equal(lines.join('\n'), md)
})

test('gap numbering and empty table', () => {
  assert.equal(recordDecision(TABLE([1, 3].map(row).join('\n')), OPTS).id, 'D4')
  assert.equal(recordDecision('| # | Decision | Status |\n|---|---|---|\n', OPTS).id, 'D1')
})

test('AC5 idempotent', () => {
  const md = TABLE([1, 2].map(row).join('\n'))
  const one = recordDecision(md, OPTS)
  const two = recordDecision(one.md, { ...OPTS, question: '  q ', answer: ' a ' })
  assert.equal(two.action, 'exists')
  assert.equal(two.id, 'D3')
  assert.equal(two.md, one.md)
  assert.equal(one.md.split('\n').filter((l) => l.startsWith('| D')).length, 3)
})

test('conflicting answer throws and CLI leaves file unchanged', () => {
  const md = TABLE([1].map(row).join('\n'))
  const one = recordDecision(md, OPTS)
  assert.throws(() => recordDecision(one.md, { ...OPTS, answer: 'B' }), /different answer/)
  const dir = tmp()
  const f = join(dir, 'plan.md')
  writeFileSync(f, one.md)
  const r = run(['record-decision', f, '--hunt', 'alpha-one', '--question', 'Q', '--answer', 'B'])
  assert.equal(r.status, 1)
  assert.equal(readFileSync(f, 'utf8'), one.md)
})

test('AC5 fail loud: no table', () => {
  const dir = tmp()
  const f = join(dir, 'plan.md')
  writeFileSync(f, '# no table\n')
  const r = run(['record-decision', f, '--hunt', 'alpha-one', '--question', 'Q', '--answer', 'A'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /decisions table/)
  assert.equal(readFileSync(f, 'utf8'), '# no table\n')
})

test('CLI record-decision adds then reports exists', () => {
  const dir = tmp()
  const f = join(dir, 'plan.md')
  writeFileSync(f, TABLE(row(1)))
  const a = run(['record-decision', f, '--hunt', 'alpha-one', '--question', 'Q', '--answer', 'A', '--date', '2026-10-17'])
  assert.equal(a.status, 0)
  assert.match(a.stdout, /D2 added/)
  const bytes = readFileSync(f, 'utf8')
  const b = run(['record-decision', f, '--hunt', 'alpha-one', '--question', 'Q', '--answer', 'A'])
  assert.equal(b.status, 0)
  assert.match(b.stdout, /D2 already recorded — unchanged/)
  assert.equal(readFileSync(f, 'utf8'), bytes)
})

test('ambiguous tables, bad date, empty answer all throw', () => {
  const two = TABLE(row(1)) + TABLE(row(1))
  assert.throws(() => recordDecision(two, OPTS), /ambiguous: 2/)
  const md = TABLE(row(1))
  assert.throws(() => recordDecision(md, { ...OPTS, date: '17/10/2026' }), PrespecError)
  assert.throws(() => recordDecision(md, { ...OPTS, answer: '  ' }), PrespecError)
  assert.throws(() => recordDecision(md, { ...OPTS, question: '' }), PrespecError)
})

test('pipe and newline escaping', () => {
  const r = recordDecision(TABLE(row(1)), { ...OPTS, answer: 'a | b\nc' })
  assert.match(r.md, /: a \\\| b c \|/)
})

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

test('AC9 lint passes a good file', () => {
  const r = lintAcceptance(GOOD)
  assert.equal(r.ok, true)
  assert.deepEqual(r.counts, { auto: 3, manual: 2, compliance: 1 })
})

test('AC9 manual budget (function, CLI flag, env, bad value)', () => {
  const md = GOOD + '\n## More\n'.replace('## More', '## Acceptance criteria 2') + '- AC7 [manual] seven\n'
  const r = lintAcceptance(md)
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /3 \[manual\] criteria \(max 2\): AC4, AC5, AC7/)
  const dir = tmp()
  const f = join(dir, 'a.md')
  writeFileSync(f, md)
  assert.equal(run(['lint', f]).status, 1)
  assert.equal(run(['lint', f, '--max-manual=3']).status, 0)
  assert.equal(run(['lint', f], { WOLFPACK_MAX_MANUAL: '3' }).status, 0)
  assert.equal(run(['lint', f, '--max-manual=x']).status, 2)
})

test('AC9 zero criteria fails', () => {
  assert.equal(lintAcceptance('# nothing\n').ok, false)
})

test('AC9 unparsed tags', () => {
  const md = `## Acceptance criteria
- AC4 [auto-browser] a
- AC5 auto: b
- AC7 [AUTO] c
- AC8 [Manual] d

## Notes
- AC6 [Auto-ish] x
`
  const r = lintAcceptance(md)
  const ids = r.errors.map((e) => e.id).sort()
  assert.deepEqual(ids, ['AC4', 'AC5', 'AC6'])
})

test('AC9 duplicate id', () => {
  const r = lintAcceptance('## Acceptance criteria\n- AC3 [auto] a\n- AC3 [auto] b\n')
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /AC3: duplicate id/)
})

test('AC9 real files', (t) => {
  const env = process.env.WOLFPACK_PRESPEC_LINT_FILES
  if (!env) return t.skip('set WOLFPACK_PRESPEC_LINT_FILES to lint real files')
  for (const p of env.split(delimiter).filter(Boolean)) {
    let md
    try {
      md = readFileSync(p, 'utf8')
    } catch {
      t.test(`missing: ${p}`, (st) => st.skip(`missing: ${p}`))
      continue
    }
    const r = lintAcceptance(md)
    assert.ok(r.ok, `${p}: ${r.errors.map((e) => e.message).join('; ')}`)
  }
})

test('CLI usage', () => {
  assert.equal(run([]).status, 2)
  assert.equal(run(['bogus']).status, 2)
})

test('answered-but-parked hunts are not re-drafted', () => {
  const root = tmp()
  const withLine = ACC + '\n## Source\n- Interview answers (x, 2026-10-17): a\n'
  const cpath = mkCampaign(root, [
    { slug: 'h-line', wave: 1, loc: 'worktree', status: 'needs_spec', acceptance: withLine },
    { slug: 'h-legacy', wave: 1, loc: 'worktree', status: 'needs_spec', acceptance: ACC, meta: { spec: { ambiguity_open: false } } },
    { slug: 'h-open', wave: 1, loc: 'worktree', status: 'needs_spec', acceptance: ACC, meta: { spec: { ambiguity_open: true } } },
    { slug: 'h-new', wave: 1, loc: null },
    { slug: 'h-ready', wave: 1, loc: 'worktree', status: 'ready_for_alpha' },
  ])
  const by = Object.fromEntries(selectHunts(cpath, { root }).selected.map((e) => [e.slug, e]))
  assert.equal(by['h-line'].redraft, false)
  assert.match(by['h-line'].reason, /answers recorded/)
  assert.equal(by['h-legacy'].redraft, false)
  assert.equal(by['h-open'].redraft, true)
  assert.equal(by['h-new'].redraft, true)
  assert.equal(by['h-ready'].redraft, true)
})
