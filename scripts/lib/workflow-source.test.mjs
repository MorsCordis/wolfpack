#!/usr/bin/env node
// scripts/lib/workflow-source.test.mjs — unit tests for the test-only "load like the runtime"
// helper (workflow-meta-runtime AC4/AC5). Run: node --test scripts/lib/workflow-source.test.mjs
//
// The two harnesses lean on splitMeta / stripMeta / runtimeMetaRefs; a bug here would silently
// re-hide the `meta is not defined` regression, so the helper is pinned on its own, and the AC5
// guard is proven against EVERY line of the two real workflow bodies (not just one mutation).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitMeta, stripMeta, runtimeMetaRefs } from './workflow-source.mjs'
import { render, STAMP_RE } from '../wolfpack-workflows.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const WF = join(here, '..', '..', '.agents', 'workflows')
const CANON = {
  'hunt-pipeline': readFileSync(join(WF, 'hunt-pipeline.js'), 'utf8'),
  'campaign-runner': readFileSync(join(WF, 'campaign-runner.js'), 'utf8'),
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// ── splitMeta / stripMeta ────────────────────────────────────────────────────────────────

test('splitMeta: a brace in the header // comment, braces in strings, and a trailing ; are handled', () => {
  const src = "export const meta = {\n  // header { with a stray brace\n  name: 'x', s: '}', t: \"{{\", u: `}`,\n  /* block } */ n: { deep: 1 },\n};\nconst after = 1\n"
  const { metaText, body, meta } = splitMeta(src)
  assert.deepEqual(meta, { name: 'x', s: '}', t: '{{', u: '}', n: { deep: 1 } })
  assert.ok(metaText.endsWith('};'), 'the trailing ; belongs to the meta text')
  assert.equal(body, '\nconst after = 1\n')
  assert.equal(metaText + body, src, 'nothing is lost or rewritten — the split is exact')
})

test('splitMeta: no trailing ; → the body starts right after the closing brace', () => {
  const { body, meta } = splitMeta("export const meta = { name: 'y' }\nrest()")
  assert.equal(meta.name, 'y')
  assert.equal(body, '\nrest()')
})

test('splitMeta: fails loud on a source that does not START with the meta block, or an unbalanced one', () => {
  assert.throws(() => splitMeta("// lead\nexport const meta = { name: 'x' }"), /does not start with `export const meta`/)
  assert.throws(() => splitMeta("const meta = { name: 'x' }"), /does not start with `export const meta`/)
  assert.throws(() => splitMeta("export const meta = { name: 'x', o: { a: 1 }"), /not brace-balanced/)
  assert.throws(() => splitMeta('export const meta'), /no opening brace/)
})

for (const [name, src] of Object.entries(CANON)) {
  test(`stripMeta (${name}.js): the body REMOVES the meta block (never rewrites it), keeps the stamp line, and evaluates without meta`, async () => {
    const { metaText, body, meta } = splitMeta(src)
    assert.equal(meta.name, name)
    assert.equal(metaText + body, src)
    assert.doesNotMatch(body, /^\s*(export\s+)?const meta\b/m, 'no meta declaration survives in the runtime body')
    assert.match(body, STAMP_RE, 'the stamp line is outside the meta block and survives')
    assert.equal(stripMeta(src), body)
    // Compiles as the runtime would see it (parse only; a ReferenceError would only fire on run).
    assert.doesNotThrow(() => new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', body))
  })

  test(`stripMeta (${name}.js): a STAMPED copy strips to the same body apart from the stamp line`, () => {
    const stamp = { workflow: `${name}.js`, commit: 'c'.repeat(40), version: 'v9.9.9', source: `sha256:${'7'.repeat(64)}` }
    const stamped = render(src, stamp)
    const a = stripMeta(src).replace(STAMP_RE, '<stamp>')
    const b = stripMeta(stamped).replace(STAMP_RE, '<stamp>')
    assert.equal(b, a)
    assert.equal(splitMeta(stamped).meta.name, name)
  })
}

// ── runtimeMetaRefs ──────────────────────────────────────────────────────────────────────

test('runtimeMetaRefs: hits code and string/template text; ignores comments and longer identifiers', () => {
  assert.equal(runtimeMetaRefs('const self = `${meta.name}.js`').length, 1, 'the original bug shape')
  assert.equal(runtimeMetaRefs("const a = 'meta'").length, 1, 'string contents are KEPT on purpose')
  assert.equal(runtimeMetaRefs('x = meta').length, 1)
  assert.equal(runtimeMetaRefs('// meta\n/* meta\n meta */\nconst metadata = 1, META_X = 2, metaName = 3').length, 0)
  assert.equal(runtimeMetaRefs("const u = 'http://x'; const s = meta.name").length, 1, '// inside a string is not a comment')
  assert.equal(runtimeMetaRefs('const t = `a ${ `b ${ {x:1}.x } // c` } d`; meta').length, 1, 'nested templates + braces resync')
  assert.equal(runtimeMetaRefs('const t = `a ${ f({}) } b`\n// meta in a comment\nconst y = meta').length, 1)
})

test('runtimeMetaRefs (Pointer r2 #1 shape): the shq regex /\'/g followed by a meta ref is still caught', () => {
  const shq = "const shq = (v) => `'${String(v).replace(/'/g, `'\\\\''`)}'`\n"
  assert.equal(runtimeMetaRefs(shq + 'const self = `${meta.name}.js`').length, 1)
  assert.equal(runtimeMetaRefs(shq + 'const self = meta.name').length, 1)
})

for (const [name, src] of Object.entries(CANON)) {
  test(`AC5 guard (${name}.js): a meta ref injected before ANY non-comment line of the real body is detected`, () => {
    // Property check over the REAL file: wherever a future edit introduces `meta`, the scanner must
    // be in code/string state there (never a fake comment). Proves no cross-line scanner desync
    // (e.g. a regex literal read as `/*`, or a stale `${` frame) blinds the guard anywhere in
    // today's body — shq's /'/g included. Known residual (Pointer r2 #1, tracker-log): a quote-
    // bearing regex followed on the SAME line by a string holding `//` blanks the rest of that line.
    const body = stripMeta(src)
    assert.deepEqual(runtimeMetaRefs(body), [], 'the fixed body is clean')
    const lines = body.split('\n')
    const missed = []
    let tried = 0
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(\/\/|\/\*|\*)/.test(lines[i])) continue // a real comment line: blanking it is correct
      tried++
      const mutated = [...lines.slice(0, i), 'void meta.name', ...lines.slice(i)].join('\n')
      if (runtimeMetaRefs(mutated).length !== 1) missed.push(i + 1)
    }
    assert.ok(tried > 500, `sanity: scanned ${tried} lines`)
    assert.deepEqual(missed, [], `the guard is blind at body line(s) ${missed.join(', ')}`)
  })
}
