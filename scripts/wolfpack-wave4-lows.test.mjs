#!/usr/bin/env node
// scripts/wolfpack-wave4-lows.test.mjs — merge-and-state-hygiene AC24 / AC25 (wave-4 close LOWs):
//   AC24 wolfpack-lessons.sh outside a git repo prints the friendly "Not in a git repo" error
//        (set -e no longer kills it silently at the `git rev-parse` line);
//   AC25 wolfpack-live-watch.py finds the local-model manager CLI from WOLFPACK_MODELS_BIN, else
//        `wolfpack-models` on PATH — never a private hard-coded path.
// Run: node --test scripts/wolfpack-wave4-lows.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const DIRS = []
after(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }) })
const tmp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); DIRS.push(d); return d }

test('AC24: wolfpack-lessons.sh outside git → "Not in a git repo — cannot locate .wolfpack/ directory" on stderr, exit ≠ 0', () => {
  const ceiling = tmp('wplessons-')
  const cwd = join(ceiling, 'nogit')
  spawnSync('mkdir', ['-p', cwd])
  const r = spawnSync('bash', [join(here, 'wolfpack-lessons.sh')], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: ceiling, GIT_DIR: '', GIT_WORK_TREE: '' },
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Not in a git repo — cannot locate \.wolfpack\/ directory/, `stderr: ${r.stderr}`)
})

test('AC24: the PROJECT_ROOT line tolerates a failing git under set -e', () => {
  const src = readFileSync(join(here, 'wolfpack-lessons.sh'), 'utf8')
  assert.match(src, /^PROJECT_ROOT="\$\(git rev-parse --show-toplevel 2>\/dev\/null \|\| true\)"$/m)
})

// Evaluate live-watch.py's WM_BIN assignment (and its imports) in isolation — the script itself is a
// long-running watcher, so it is not executed whole.
function wmBin(env) {
  const src = readFileSync(join(here, 'wolfpack-live-watch.py'), 'utf8')
  const line = src.split('\n').find(l => /^WM_BIN = /.test(l))
  assert.ok(line, 'a top-level WM_BIN assignment')
  const py = `import os, shutil\nfrom pathlib import Path\n${line}\nprint(WM_BIN)\n`
  const r = spawnSync('python3', ['-I', '-c', py], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('AC25: WM_BIN = WOLFPACK_MODELS_BIN when set; else `wolfpack-models` on PATH; else the bare name', () => {
  const bin = tmp('wpmodels-')
  const exe = join(bin, 'wolfpack-models')
  writeFileSync(exe, '#!/bin/sh\necho ok\n'); chmodSync(exe, 0o755)
  assert.equal(wmBin({ PATH: '/usr/bin:/bin', WOLFPACK_MODELS_BIN: '/opt/x/wm' }), '/opt/x/wm')
  assert.equal(wmBin({ PATH: `${bin}:/usr/bin:/bin` }), exe)
  assert.equal(wmBin({ PATH: '/usr/bin:/bin', WOLFPACK_MODELS_BIN: '' }), shutilWhichOrBare())
  function shutilWhichOrBare() {
    const w = spawnSync('python3', ['-I', '-c', 'import shutil; print(shutil.which("wolfpack-models") or "")'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    return w.stdout.trim() || 'wolfpack-models'
  }
  const src = readFileSync(join(here, 'wolfpack-live-watch.py'), 'utf8')
  assert.match(src, /^import [^\n]*\bshutil\b|^import shutil$/m, 'shutil imported')
  assert.equal(src.includes('local-llm'), false, 'no private hard-coded manager path')
  assert.match(src, /if not WM_BIN\.is_file\(\):/, 'the missing-CLI state is still shown')
})
