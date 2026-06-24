#!/usr/bin/env node
// scripts/wolfpack-toolcheck.test.mjs — unit tests for the [06] AC1 regression guard.
// Run: node --test scripts/wolfpack-toolcheck.test.mjs
//
// Drives the pure analyzers against the REAL committed shims (the guard must pass
// on what's on disk) plus synthetic re-boxed shims (the guard must fail loud).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { analyzeVibeShim, analyzeAgyShim, CAPABLE_TOOLS } from './wolfpack-toolcheck.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// TODO(de-fracture): these shim filenames are harness-specific (see wolfpack-toolcheck.mjs).
// The "REAL committed shim" tests below auto-skip when the shim is absent so the
// synthetic-fixture coverage still runs in a repo that doesn't ship these shims.
const vibePath = join(here, 'podman-vibe.sh')
const agyPath = join(here, 'podman-agy.sh')

// A minimal capable shim fragment (mirrors the real loop).
const capableShim = `
VIBE_TOOLS_DEFAULT="read grep edit write_file bash"
VIBE_TOOL_FLAGS=()
for _t in \${WOLFPACK_VIBE_TOOLS:-$VIBE_TOOLS_DEFAULT}; do
    VIBE_TOOL_FLAGS+=(--enabled-tools "$_t")
done
`

test('the REAL committed podman-vibe.sh is capable (not re-boxed)', { skip: !existsSync(vibePath) && 'harness shim not present in this repo' }, () => {
  const res = analyzeVibeShim(readFileSync(vibePath, 'utf8'))
  assert.deepEqual(res.problems, [], res.problems.join('\n'))
  assert.equal(res.ok, true)
  for (const t of CAPABLE_TOOLS) assert.ok(res.tools.includes(t), `missing ${t}`)
})

test('synthetic capable shim passes', () => {
  const res = analyzeVibeShim(capableShim)
  assert.equal(res.ok, true)
  assert.deepEqual(res.tools, ['read', 'grep', 'edit', 'write_file', 'bash'])
})

test('the 2-tool cage (read,grep only) fails loud', () => {
  const reboxed = capableShim.replace('read grep edit write_file bash', 'read grep')
  const res = analyzeVibeShim(reboxed)
  assert.equal(res.ok, false)
  // missing edit, write_file, bash
  assert.ok(res.problems.some(p => /"edit" missing/.test(p)))
  assert.ok(res.problems.some(p => /"write_file" missing/.test(p)))
  assert.ok(res.problems.some(p => /"bash" missing/.test(p)))
})

test('comma-joined default (the silent-blinding bug) fails loud', () => {
  const reboxed = capableShim.replace('read grep edit write_file bash', 'read,grep')
  const res = analyzeVibeShim(reboxed)
  assert.equal(res.ok, false)
  assert.ok(res.problems.some(p => /comma/i.test(p)))
})

test('legacy comma-joined --enabled-tools flag fails loud', () => {
  const legacy = `VIBE_TOOLS_DEFAULT="read grep edit write_file bash"
VIBE_TOOL_FLAGS=(--enabled-tools read,grep)
`
  const res = analyzeVibeShim(legacy)
  assert.equal(res.ok, false)
  assert.ok(res.problems.some(p => /comma-joined --enabled-tools/.test(p)))
})

test('comma-joined --enabled-tools with = separator fails loud', () => {
  const eqForm = `VIBE_TOOLS_DEFAULT="read grep edit write_file bash"
VIBE_TOOL_FLAGS=(--enabled-tools=read,grep)
`
  const res = analyzeVibeShim(eqForm)
  assert.equal(res.ok, false)
  assert.ok(res.problems.some(p => /comma-joined --enabled-tools/.test(p)))
})

test('a collapsed (non-repeating) flag build fails loud', () => {
  // capable list present but NOT emitted per-tool via the loop
  const collapsed = `VIBE_TOOLS_DEFAULT="read grep edit write_file bash"
VIBE_TOOL_FLAGS=(--enabled-tools read)
`
  const res = analyzeVibeShim(collapsed)
  assert.equal(res.ok, false)
  assert.ok(res.problems.some(p => /repeating --enabled-tools per tool/.test(p)))
})

test('task in the default set fails loud (self-orchestration must stay off)', () => {
  const withTask = capableShim.replace('read grep edit write_file bash', 'read grep edit write_file bash task')
  const res = analyzeVibeShim(withTask)
  assert.equal(res.ok, false)
  assert.ok(res.problems.some(p => /"task" is in the default/.test(p)))
})

test('missing VIBE_TOOLS_DEFAULT fails loud', () => {
  const res = analyzeVibeShim('echo nothing here')
  assert.equal(res.ok, false)
  assert.ok(res.problems.some(p => /VIBE_TOOLS_DEFAULT not found/.test(p)))
})

test('the REAL committed podman-agy.sh has no allowlist flag', { skip: !existsSync(agyPath) && 'harness shim not present in this repo' }, () => {
  const res = analyzeAgyShim(readFileSync(agyPath, 'utf8'))
  assert.deepEqual(res.problems, [], res.problems.join('\n'))
  assert.equal(res.ok, true)
})

test('agy with a stray --enabled-tools fails loud', () => {
  const res = analyzeAgyShim('agy -p - --enabled-tools read')
  assert.equal(res.ok, false)
  assert.ok(res.problems.some(p => /agy.*no allowlist/i.test(p)))
})

test('CLI exits 0 on the real shims', { skip: !existsSync(vibePath) && 'harness shim not present in this repo' }, () => {
  // Should not throw (exit 0).
  execFileSync('node', [join(here, 'wolfpack-toolcheck.mjs')], { encoding: 'utf8' })
})

test('CLI exits 1 on a re-boxed shim', () => {
  const tmp = join(here, `.toolcheck-reboxed-${process.pid}.sh`)
  writeFileSync(tmp, 'VIBE_TOOLS_DEFAULT="read grep"\nVIBE_TOOL_FLAGS=()\nfor _t in $VIBE_TOOLS_DEFAULT; do VIBE_TOOL_FLAGS+=(--enabled-tools "$_t"); done\n')
  try {
    let code = 0
    try {
      execFileSync('node', [join(here, 'wolfpack-toolcheck.mjs'), tmp], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) { code = e.status }
    assert.equal(code, 1)
  } finally {
    rmSync(tmp, { force: true })
  }
})
