#!/usr/bin/env node
// scripts/wolfpack-ci.test.mjs — the public-repo CI contract (AC8): GitHub-hosted runners only,
// push + pull_request, Node set up, and the ONE test entry point. A line-based parse of
// .github/workflows/ci.yml (no YAML dependency — the pack has none).
// Run: node --test scripts/wolfpack-ci.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WF_DIR = join(here, '..', '.github', 'workflows')
const CI = readFileSync(join(WF_DIR, 'ci.yml'), 'utf8')
const lines = CI.split(/\r?\n/)
const indentOf = (l) => l.match(/^ */)[0].length
const strip = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')

// The block of lines under a top-level key (`<key>:` at column 0) up to the next top-level key.
function topBlock(key) {
  const i = lines.findIndex(l => new RegExp(`^${key}:`).test(l))
  if (i < 0) return null
  const out = [lines[i]]
  for (let j = i + 1; j < lines.length && !/^\S/.test(lines[j]); j++) out.push(lines[j])
  return out
}

test('AC8: every runs-on is ubuntu-latest (GitHub-hosted), with at least one job', () => {
  const runsOn = lines.filter(l => /^\s+runs-on:/.test(l)).map(l => strip(l.split('runs-on:')[1]))
  assert.ok(runsOn.length >= 1, 'at least one job')
  for (const r of runsOn) assert.equal(r, 'ubuntu-latest')
  const jobs = topBlock('jobs')
  assert.ok(jobs, 'a jobs: block')
  const jobIndent = Math.min(...jobs.slice(1).filter(l => l.trim()).map(indentOf))
  const jobNames = jobs.slice(1).filter(l => l.trim() && indentOf(l) === jobIndent).map(l => l.trim().replace(/:.*$/, ''))
  assert.ok(jobNames.length >= 1)
  assert.equal(runsOn.length, jobNames.length, 'every job declares runs-on')
})

test('AC8: the substring "self-hosted" appears nowhere — in ci.yml or any other workflow file', () => {
  assert.equal(CI.includes('self-hosted'), false)
  for (const f of readdirSync(WF_DIR)) {
    assert.equal(readFileSync(join(WF_DIR, f), 'utf8').includes('self-hosted'), false, f)
  }
})

test('AC8: on: lists push and pull_request', () => {
  const on = topBlock('on')
  assert.ok(on, 'an on: block')
  const inline = strip(on[0].slice(3))
  const keys = inline
    ? inline.replace(/^\[|\]$/g, '').split(',').map(s => s.trim())
    : on.slice(1).filter(l => l.trim()).map(l => l.trim().replace(/:.*$/, ''))
  assert.ok(keys.includes('push'), keys.join(','))
  assert.ok(keys.includes('pull_request'), keys.join(','))
})

test('AC8: an actions/setup-node step exists and a run: invokes scripts/test-all.sh', () => {
  assert.ok(lines.some(l => /^\s*-?\s*uses:\s*actions\/setup-node@/.test(l)), 'setup-node')
  assert.ok(lines.some(l => /^\s*-?\s*uses:\s*actions\/checkout@/.test(l)), 'checkout')
  assert.ok(lines.some(l => /^\s*-?\s*run:\s*bash scripts\/test-all\.sh\s*$/.test(l)), 'run: bash scripts/test-all.sh')
})

test('AC8: least-privilege token and podman tests skipped visibly in CI', () => {
  const perms = topBlock('permissions')
  assert.ok(perms, 'a top-level permissions: block')
  assert.ok(perms.some(l => /^\s+contents:\s*read\s*$/.test(l)))
  assert.equal(perms.some(l => /:\s*write\b/.test(l)), false, 'no write permission')
  assert.ok(lines.some(l => /WOLFPACK_TEST_NO_PODMAN:\s*['"]?1['"]?/.test(l)))
})
