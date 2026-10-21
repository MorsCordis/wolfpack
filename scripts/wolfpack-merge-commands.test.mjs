#!/usr/bin/env node
// scripts/wolfpack-merge-commands.test.mjs — text contracts for merge-and-state-hygiene:
// the merge commands call scripts/wolfpack-merge-state.mjs (AC1–AC3, AC11), the no-tag fallback
// (AC20), the Tracker "no release-stamp assertions" rule (AC14), version provenance in the seat
// docs (AC7/AC8) and the GLM-node config line (AC18).
// Run: node --test scripts/wolfpack-merge-commands.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const R = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const cmd = (n) => R('.agents', 'commands', n)
const skill = (n) => R('.agents', 'skills', n, 'SKILL.md')

test('AC1: merge.md names a worktree root only as the e.g. example (the root comes from config)', () => {
  const hits = cmd('merge.md').split('\n').filter(l => /\.(agents|claude)\/worktrees/.test(l))
  assert.ok(hits.length >= 1)
  for (const l of hits) assert.match(l, /e\.g\./, l)
  assert.match(cmd('merge.md'), /wolfpack-config\.mjs" --json` and take `worktreeRoot`/)
})

test('AC2/AC3: merge.md + merge-wave.md copy back and stamp through the script; the stamp is unconditional; no cp -r / .prior archive', () => {
  for (const n of ['merge.md', 'merge-wave.md']) {
    const t = cmd(n)
    assert.match(t, /wolfpack-merge-state\.mjs" copy-back --slug /, `${n} copy-back`)
    assert.match(t, /wolfpack-merge-state\.mjs" stamp-merged --slug /, `${n} stamp-merged`)
    assert.doesNotMatch(t, /\bcp -r\b/, `${n}: no bare cp -r`)
    // every line that introduces / runs the stamp (no blank lines separate the numbered steps, so line units)
    for (const l of t.split('\n').filter(l => /stamp-merged|Stamp MERGED|stamp MERGED/.test(l))) {
      assert.doesNotMatch(l, /only if `worktree_path`/, `${n}: the stamp is not conditioned on worktree_path:\n${l}`)
    }
    assert.doesNotMatch(t, /Rename the existing target to `<slug>\.prior-/, `${n}: the archive rule is gone`)
  }
  const m = cmd('merge.md')
  assert.match(m, /MERGE_SHA=\$\(git rev-parse HEAD\)/)
  assert.match(m, /7a\. \*\*Stamp MERGED \(ALWAYS/)
  assert.match(m, /--merge-commit "\$MERGE_SHA" --released-version "<ver>"/)
  assert.match(cmd('merge-wave.md'), /Then ALWAYS \(worktree hunt or `--no-worktree` hunt\) stamp it merged/)
})

test('AC3: /release-campaign keeps its stamp-released call, which delegates every per-hunt stamp to the shared stampMerged()', () => {
  assert.match(cmd('release-campaign.md'), /stamp-released/)
  const rel = R('scripts', 'wolfpack-release.mjs')
  assert.match(rel, /import \{ stampMerged, attributeUnreleased \} from '\.\/wolfpack-merge-state\.mjs'/)
  const body = rel.slice(rel.indexOf('export function cmdStampReleased'))
  assert.match(body.slice(0, 2500), /stampMerged\(root, h\.slug, \{/)
  assert.doesNotMatch(body.slice(0, 2500), /meta\.status = 'merged'/, 'no hand-rolled status write left')
})

test('AC11: merge.md and merge-wave.md attribute untagged [Unreleased] items before the move; the warn-only text is gone', () => {
  const m = cmd('merge.md')
  assert.match(m, /wolfpack-merge-state\.mjs" attribute-changelog --file "<changelog file>" --apply/)
  assert.ok(m.indexOf('attribute-changelog') < m.indexOf('9. **Release tagging'), 'attribution runs in step 8a, before tagging')
  assert.doesNotMatch(m, /Unattributed item warning/)
  const w = cmd('merge-wave.md')
  assert.match(w, /wolfpack-merge-state\.mjs" attribute-changelog --file/)
  assert.doesNotMatch(w, /warn if they're unattributed/)
  assert.match(cmd('release-campaign.md'), /attribut/i)
})

test('AC20: release-campaign Step 4 / merge step 9 / merge-wave / hunt Q5 read releaseTags (Tag pattern: none)', () => {
  const rc = cmd('release-campaign.md')
  const step4 = rc.slice(rc.indexOf('No-tag fallback'))
  assert.match(step4.slice(0, 800), /`releaseTags`/)
  assert.match(step4.slice(0, 800), /Tag pattern/)
  assert.match(step4.slice(0, 800), /released_version: null/)
  assert.match(rc, /`releaseTags`, `changelogFile`/, 'Step 0 keeps the key')
  for (const n of ['merge.md', 'merge-wave.md', 'hunt.md']) {
    assert.match(cmd(n), /`releaseTags` is `false`/, n)
  }
})

test('AC14: the Tracker skill + command forbid assertions a release stamp invalidates', () => {
  const s = skill('tracker')
  assert.match(s, /### No assertions a release stamp invalidates/)
  assert.match(s, /under\s+`\[Unreleased\]` or a version heading/)
  assert.match(s, /`certified` or `merged`/)
  const c = cmd('tracker.md')
  assert.match(c, /release stamp/)
  assert.match(c, /under `\[Unreleased\]` or a version heading/)
})

test('AC7 (docs): alpha/watchdog skills and debrief/watchdog commands carry the set_by:"human" rule; the hand-edit instruction is gone', () => {
  for (const [name, t] of [['alpha skill', skill('alpha')], ['watchdog skill', skill('watchdog')], ['debrief.md', cmd('debrief.md')], ['watchdog.md', cmd('watchdog.md')]]) {
    assert.match(t, /set_by: "human"/, name)
    assert.match(t, /wolfpack-version\.mjs" set/, name)
  }
  const a = skill('alpha')
  assert.doesNotMatch(a, /AND `metadata\.proposed_version` to match/)
  assert.match(a, /--by alpha/)
  assert.match(a, /--by debrief/)
  // /resolve writes the human's version through the same script with --by human
  assert.match(skill('parked'), /wolfpack-version\.mjs" set --plan-dir .* --by human/)
  assert.match(cmd('resolve.md'), /wolfpack-version\.mjs/)
  assert.match(skill('parked'), /SEAT NOTE \(not human direction\)/)
  // the metadata schema documents set_by
  assert.match(skill('wolfpack'), /"set_by": "human\|<role>\|null"/)
})

test('AC8: the /hunt metadata template carries set_by; a campaign Bump pre-fill writes set_by null', () => {
  const h = cmd('hunt.md')
  const tpl = h.slice(h.indexOf('"proposed_version": {'))
  assert.match(tpl.slice(0, 600), /"set_by": "<\\"human\\" when the user answered Q5/)
  assert.match(h, /pre-fill `proposed_version\.bump` too \(with `set_by: null`/)
  assert.match(h, /immutable to seats/)
})

test('AC18: wolfpack-config.md says the GLM review image ships node; the Mistral image still does not', () => {
  const c = R('wolfpack-config.md')
  assert.match(c, /GLM review image ships `node`/)
  assert.match(c, /Containerfile\.wolfpack-glm/)
  assert.match(c, /Mistral\) seat image still has none/)
})
