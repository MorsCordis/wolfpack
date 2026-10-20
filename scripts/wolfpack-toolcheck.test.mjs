#!/usr/bin/env node
// scripts/wolfpack-toolcheck.test.mjs — unit tests for the [06] AC1 regression guard.
// Run: node --test scripts/wolfpack-toolcheck.test.mjs
//
// Drives the pure analyzers against the REAL committed shims (the guard must pass
// on what's on disk) plus synthetic re-boxed shims (the guard must fail loud).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  analyzeVibeShim, CAPABLE_TOOLS, analyzeGlmShim, parseSeatProfile, normalizeTool, shimToolsFor,
  checkSeatParity, checkProfiles, defaultProfilesDir, PIPELINE_SEATS, TRACKED_NOT_DISPATCHED,
  TOOL_DENIAL_PATTERN, ROLE_POLICY,
} from './wolfpack-toolcheck.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// The seat shim is the PACK's (exec-layer-into-pack). Inside the pack it sits beside this
// file; a consuming repo has no copy, so the real-shim tests then read
// $WOLFPACK_HOME/scripts/podman-vibe.sh. They auto-skip when neither exists, so the
// synthetic-fixture coverage still runs (`node --test` exits 0 with or without the pack).
const localShim = join(here, 'podman-vibe.sh')
const vibePath = existsSync(localShim) || !process.env.WOLFPACK_HOME
  ? localShim
  : join(process.env.WOLFPACK_HOME, 'scripts', 'podman-vibe.sh')

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

test('CLI exits 0 on the real shims', { skip: !existsSync(vibePath) && 'harness shim not present in this repo' }, () => {
  // Should not throw (exit 0). --profiles points at matching FIXTURE profiles: the default
  // dir is the host's live install, which this unit test must not depend on.
  const dir = fixtureProfilesDir()
  try {
    execFileSync('node', [join(here, 'wolfpack-toolcheck.mjs'), '--shim', vibePath, '--profiles', dir], { encoding: 'utf8', stdio: 'pipe' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI exits 1 on a re-boxed shim', () => {
  const tmp = join(here, `.toolcheck-reboxed-${process.pid}.sh`)
  writeFileSync(tmp, 'VIBE_TOOLS_DEFAULT="read grep"\nVIBE_TOOL_FLAGS=()\nfor _t in $VIBE_TOOLS_DEFAULT; do VIBE_TOOL_FLAGS+=(--enabled-tools "$_t"); done\n')
  try {
    let code = 0
    const dir = fixtureProfilesDir()
    try {
      execFileSync('node', [join(here, 'wolfpack-toolcheck.mjs'), tmp, '--profiles', dir], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) { code = e.status } finally { rmSync(dir, { recursive: true, force: true }) }
    assert.equal(code, 1)
  } finally {
    rmSync(tmp, { force: true })
  }
})

// ─── Seat-profile parity (seat-profiles-into-pack, AC4) ─────────
//
// Fixtures are INLINE (no dependency on the host's ~/.vibe install or on the wolfpack
// vibe-agents/ templates), so the same file runs as the byte copy in a consuming repo.

// A capable shim fragment carrying BOTH halves: the Mistral loop and the GLM lists.
const fullShim = `${capableShim}
GLM_REVIEW_TOOLS_DEFAULT="read_file grep bash write_file dev_cortex_repo_map dev_cortex_file_outline"
GLM_IMPLEMENT_TOOLS_DEFAULT="read_file grep write_file edit dev_cortex_repo_map dev_cortex_file_outline"
GLM_REVIEW_DROP="task edit"
GLM_IMPLEMENT_DROP="bash task"
`

// The permission shapes the tracked templates carry (AC2).
const MISTRAL_REVIEW = { read_file: 'always', grep: 'always', bash: 'always', git_bash: 'always',
  edit: 'never', write_file: 'always', task: 'never', skill: 'never' }
const GLM_REVIEW = { read_file: 'always', grep: 'always', dev_cortex_repo_map: 'always', dev_cortex_file_outline: 'always',
  bash: 'always', git_bash: 'always', edit: 'never', write_file: 'always', task: 'never' }
const GLM_IMPLEMENT = { read_file: 'always', grep: 'always', write_file: 'always', edit: 'always',
  dev_cortex_repo_map: 'always', dev_cortex_file_outline: 'always', bash: 'never', git_bash: 'never', task: 'never' }
// Alpha/Shepherd/Tracker as they are (ask permissions) — never parity-checked.
const AS_IS = { read_file: 'always', grep: 'always', write_file: 'ask', edit: 'ask', bash: 'ask', git_bash: 'ask' }
const FIXTURE_SHAPES = {
  'wolfpack-bloodhound': MISTRAL_REVIEW, 'wolfpack-pointer': MISTRAL_REVIEW, 'wolfpack-watchdog': MISTRAL_REVIEW,
  'wolfpack-bloodhound-glm': GLM_REVIEW, 'wolfpack-pointer-glm': GLM_REVIEW, 'wolfpack-watchdog-glm': GLM_REVIEW,
  'wolfpack-shepherd-glm': GLM_IMPLEMENT,
  'wolfpack-alpha': AS_IS, 'wolfpack-shepherd': AS_IS, 'wolfpack-tracker': AS_IS,
}

const toToml = (perms, extra = '') => `# fixture profile\nactive_model = "x"\n${extra}\n` +
  Object.entries(perms).map(([t, p]) => `[tools.${t}]\npermission = "${p}"\n`).join('\n')

// Writes the 10 fixture profiles (with per-seat permission overrides) to a fresh temp dir.
function fixtureProfilesDir(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'toolcheck-profiles-'))
  for (const [name, shape] of Object.entries(FIXTURE_SHAPES)) {
    writeFileSync(join(dir, `${name}.toml`), toToml({ ...shape, ...(overrides[name] || {}) }))
  }
  return dir
}
const withProfiles = (overrides, fn) => {
  const dir = fixtureProfilesDir(overrides)
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const runCli = (args, env = {}) => spawnSync(process.execPath, [join(here, 'wolfpack-toolcheck.mjs'), ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } })
const seatOf = (res, name) => res.seats.find(s => s.name === name)

test('parseSeatProfile: sections + permissions; comments, top-level keys and allowlist ignored; legacy names normalised', () => {
  const res = parseSeatProfile(`# header comment
active_model = "glm-5.3"  # trailing comment
system_prompt_id = "wolfpack-pointer"

[tools.read]
permission = "always"   # legacy alias of read_file

[tools.search_replace]
permission = 'never'

[tools.task]
permission = "always"
allowlist = ["explore"]

# [tools.bash]
# permission = "never"   (commented out — must not count)

[other.section]
permission = "never"
`)
  assert.deepEqual(res.problems, [])
  assert.deepEqual(res.tools, { read_file: 'always', edit: 'never', task: 'always' })
  assert.equal(normalizeTool('read'), 'read_file')
  assert.equal(normalizeTool('search_replace'), 'edit')
  assert.equal(normalizeTool('bash'), 'bash')
})

test('parseSeatProfile: an unknown or unquoted permission is a PROBLEM (fail loud), as is a conflicting alias', () => {
  const unknown = parseSeatProfile('[tools.bash]\npermission = "sometimes"\n')
  assert.equal(unknown.problems.length, 1)
  assert.match(unknown.problems[0], /\[tools\.bash\] permission = "sometimes" is not one of always\|never\|ask/)
  assert.equal(unknown.tools.bash, undefined, 'an invalid value is never silently adopted')
  const unquoted = parseSeatProfile('[tools.bash]\npermission = always\n')
  assert.match(unquoted.problems[0], /not a quoted string/)
  const conflict = parseSeatProfile('[tools.read]\npermission = "always"\n[tools.read_file]\npermission = "never"\n')
  assert.ok(conflict.problems.some(p => /\[tools\.read_file\] is set twice with different permissions/.test(p)))
  const same = parseSeatProfile('[tools.read]\npermission = "always"\n[tools.read_file]\npermission = "always"\n')
  assert.deepEqual(same.problems, [], 'the same value twice is not a conflict')
})

test('analyzeGlmShim: the fixture GLM block passes; each missing or wrong list fails loud', () => {
  assert.deepEqual(analyzeGlmShim(fullShim).problems, [])
  const noBash = analyzeGlmShim(fullShim.replace('read_file grep bash write_file', 'read_file grep write_file'))
  assert.ok(noBash.problems.some(p => /GLM_REVIEW_TOOLS_DEFAULT lacks "bash"/.test(p)))
  const missing = analyzeGlmShim(fullShim.replace(/^GLM_REVIEW_DROP=.*$/m, ''))
  assert.ok(missing.problems.some(p => /GLM_REVIEW_DROP not found/.test(p)))
  const comma = analyzeGlmShim(fullShim.replace('GLM_IMPLEMENT_DROP="bash task"', 'GLM_IMPLEMENT_DROP="bash,task"'))
  assert.ok(comma.problems.some(p => /GLM_IMPLEMENT_DROP="bash,task" contains a comma/.test(p)))
  const unquoted = analyzeGlmShim(fullShim.replace('GLM_REVIEW_DROP="task edit"', 'GLM_REVIEW_DROP=task'))
  assert.ok(unquoted.problems.some(p => /GLM_REVIEW_DROP=task is not quoted/.test(p)))
  const implBash = analyzeGlmShim(fullShim.replace('GLM_IMPLEMENT_DROP="bash task"', 'GLM_IMPLEMENT_DROP="task"'))
  assert.ok(implBash.problems.some(p => /GLM_IMPLEMENT_DROP lacks "bash"/.test(p)))
  const reviewDropsBash = analyzeGlmShim(fullShim.replace('GLM_REVIEW_DROP="task edit"', 'GLM_REVIEW_DROP="bash task edit"'))
  assert.ok(reviewDropsBash.problems.some(p => /GLM_REVIEW_DROP drops "bash"/.test(p)))
  const taskKept = analyzeGlmShim(fullShim.replace('GLM_REVIEW_DROP="task edit"', 'GLM_REVIEW_DROP="edit"'))
  assert.ok(taskKept.problems.some(p => /GLM_REVIEW_DROP lacks "task"/.test(p)))
})

test('shimToolsFor mirrors the shim per seat (family, mode, Bloodhound task strip, drop lists, env overrides)', () => {
  assert.deepEqual(shimToolsFor(fullShim, 'wolfpack-pointer').tools, ['read_file', 'grep', 'edit', 'write_file', 'bash'])
  assert.deepEqual(shimToolsFor(fullShim, 'wolfpack-pointer-glm').tools,
    ['read_file', 'grep', 'bash', 'write_file', 'dev_cortex_repo_map', 'dev_cortex_file_outline'])
  assert.deepEqual(shimToolsFor(fullShim, 'wolfpack-shepherd-glm').tools,
    ['read_file', 'grep', 'write_file', 'edit', 'dev_cortex_repo_map', 'dev_cortex_file_outline'])
  // operator overrides are honoured, and the drop lists still apply to them
  assert.deepEqual(shimToolsFor(fullShim, 'wolfpack-pointer', { WOLFPACK_VIBE_TOOLS: 'read grep task' }).tools, ['read_file', 'grep', 'task'])
  assert.deepEqual(shimToolsFor(fullShim, 'wolfpack-bloodhound', { WOLFPACK_VIBE_TOOLS: 'read grep task' }).tools, ['read_file', 'grep'],
    'the shim strips task from Bloodhound')
  assert.deepEqual(shimToolsFor(fullShim, 'wolfpack-pointer-glm', { WOLFPACK_GLM_TOOLS: 'read_file bash task' }).tools, ['read_file', 'bash'])
  assert.deepEqual(shimToolsFor(fullShim, 'wolfpack-shepherd-glm', { WOLFPACK_GLM_IMPLEMENT_TOOLS: 'read_file bash edit' }).tools, ['read_file', 'edit'])
  // a missing shim variable is a problem, never a silent default
  const r = shimToolsFor(capableShim, 'wolfpack-pointer-glm')
  assert.deepEqual(r.tools, [])
  assert.ok(r.problems.some(p => /wolfpack-pointer-glm: shim variable GLM_REVIEW_TOOLS_DEFAULT not found/.test(p)))
  assert.ok(shimToolsFor(fullShim, 'wolfpack-alpha').problems.some(p => /not a pipeline seat/.test(p)))
})

test('AC4 fixture: matching profiles × the capable shim → every pipeline seat ok; alpha/shepherd/tracker listed, not checked', () => {
  withProfiles({}, (dir) => {
    const res = checkProfiles(fullShim, dir, {})
    assert.deepEqual(res.problems, [], res.problems.join('\n'))
    assert.equal(res.ok, true)
    for (const name of Object.keys(PIPELINE_SEATS)) assert.equal(seatOf(res, name).status, 'ok', name)
    for (const name of TRACKED_NOT_DISPATCHED) {
      assert.equal(seatOf(res, name).status, 'tracked, not dispatched — not parity-checked', `${name}: "ask" permissions are not a failure`)
    }
  })
})

test('AC4: pointer-glm bash = "never" → not ok, the problem names the seat AND the tool (the GLM repro)', () => {
  withProfiles({ 'wolfpack-pointer-glm': { bash: 'never', git_bash: 'never' } }, (dir) => {
    const res = checkProfiles(fullShim, dir, {})
    assert.equal(res.ok, false)
    assert.equal(seatOf(res, 'wolfpack-pointer-glm').status, 'mismatch')
    assert.ok(res.problems.some(p => p.startsWith('wolfpack-pointer-glm:') && /profile denies "bash"/.test(p)), res.problems.join('\n'))
    assert.ok(res.problems.some(p => /wolfpack-pointer-glm: profile sets "bash" to "never", but the review role requires "always"/.test(p)))
    // the other seats are untouched by one seat's mismatch
    assert.equal(seatOf(res, 'wolfpack-pointer').status, 'ok')
  })
})

test('AC4: the Mistral repro — watchdog bash = "never" while the shim enables bash → rule 2 names it', () => {
  withProfiles({ 'wolfpack-watchdog': { bash: 'never', git_bash: 'never' } }, (dir) => {
    const res = checkProfiles(fullShim, dir, {})
    assert.ok(res.problems.some(p => /^wolfpack-watchdog: profile denies "bash" \(\[tools\.bash\] permission = "never"\) but the shim enables it$/.test(p)),
      res.problems.join('\n'))
  })
})

test('AC4: edit "never" on a Mistral review seat is an INTENDED role denial (shim enables it; not a mismatch)', () => {
  // ROLE_POLICY.review.roleDeny — the reading of AC4 that keeps AC2 satisfiable. seat-handoff-writes:
  // write_file is no longer role-denied (the seat writes its handoff file into the shim out dir).
  assert.deepEqual(ROLE_POLICY.review.roleDeny, ['edit'])
  assert.ok(ROLE_POLICY.review.require.includes('write_file'), 'the review role requires write_file')
  const problems = checkSeatParity('wolfpack-pointer', { tools: MISTRAL_REVIEW }, shimToolsFor(fullShim, 'wolfpack-pointer').tools)
  assert.deepEqual(problems, [])
})

test('AC4 rule 5: Bloodhound [tools.task] "always" (shim omits task) → fails naming task; skill "always" → same rule', () => {
  const bh = checkSeatParity('wolfpack-bloodhound', { tools: { ...MISTRAL_REVIEW, task: 'always' } }, shimToolsFor(fullShim, 'wolfpack-bloodhound').tools)
  assert.ok(bh.some(p => /^wolfpack-bloodhound: profile enables "task" \(\[tools\.task\] permission = "always"\) but the shim omits it$/.test(p)), bh.join('\n'))
  assert.ok(bh.some(p => /wolfpack-bloodhound: profile sets "task" to "always" — the review role forbids it/.test(p)), 'rule 6 also fires')
  const sk = checkSeatParity('wolfpack-pointer', { tools: { ...MISTRAL_REVIEW, skill: 'always' } }, shimToolsFor(fullShim, 'wolfpack-pointer').tools)
  assert.deepEqual(sk, ['wolfpack-pointer: profile enables "skill" ([tools.skill] permission = "always") but the shim omits it'])
  const askSkill = checkSeatParity('wolfpack-pointer', { tools: { ...MISTRAL_REVIEW, skill: 'ask' } }, shimToolsFor(fullShim, 'wolfpack-pointer').tools)
  assert.ok(askSkill.some(p => /profile enables "skill" \(\[tools\.skill\] permission = "ask"\)/.test(p)))
})

test('AC4 rule 7: edit "always" on a review seat → fails (read-only by role)', () => {
  const p = checkSeatParity('wolfpack-pointer-glm', { tools: { ...GLM_REVIEW, edit: 'always' } }, shimToolsFor(fullShim, 'wolfpack-pointer-glm').tools)
  assert.ok(p.some(x => /wolfpack-pointer-glm: profile sets "edit" to "always" — the review role is read-only/.test(x)), p.join('\n'))
  const unset = { ...GLM_REVIEW }; delete unset.edit
  const q = checkSeatParity('wolfpack-pointer-glm', { tools: unset }, shimToolsFor(fullShim, 'wolfpack-pointer-glm').tools)
  assert.ok(q.some(x => /profile sets "edit" to nothing \(Vibe default\)/.test(x)), 'an UNSET role-denied tool also fails')
})

test('AC4 rule 8: git_bash ≠ bash → fails (shell companion must mirror bash)', () => {
  const p = checkSeatParity('wolfpack-pointer-glm', { tools: { ...GLM_REVIEW, git_bash: 'never' } }, shimToolsFor(fullShim, 'wolfpack-pointer-glm').tools)
  assert.deepEqual(p, ['wolfpack-pointer-glm: "git_bash" is "never" but "bash" is "always" — git_bash is bash\'s shell companion and must match it'])
  // git_bash "always" is NOT flagged by rule 5 although the shim never enables it
  assert.deepEqual(checkSeatParity('wolfpack-pointer-glm', { tools: GLM_REVIEW }, shimToolsFor(fullShim, 'wolfpack-pointer-glm').tools), [])
})

test('AC4 rule 3/4: bash "ask" on a review seat → fails (headless runs deny every ask); an UNSET bash → fails', () => {
  const p = checkSeatParity('wolfpack-pointer-glm', { tools: { ...GLM_REVIEW, bash: 'ask', git_bash: 'ask' } }, shimToolsFor(fullShim, 'wolfpack-pointer-glm').tools)
  assert.ok(p.some(x => /wolfpack-pointer-glm: "bash" is "ask" — a headless vibe -p run denies \(or hangs on\) every ask/.test(x)), p.join('\n'))
  assert.ok(p.some(x => /profile sets "bash" to "ask", but the review role requires "always"/.test(x)))
  const unset = { ...GLM_REVIEW }; delete unset.bash; delete unset.git_bash
  const q = checkSeatParity('wolfpack-pointer-glm', { tools: unset }, shimToolsFor(fullShim, 'wolfpack-pointer-glm').tools)
  assert.ok(q.some(x => /profile does not set \[tools\.bash\] — it falls to Vibe's default/.test(x)), q.join('\n'))
})

test('AC4 rule 6 (implement): shepherd-glm bash "always" → fails; the --implement shim never enables bash', () => {
  const p = checkSeatParity('wolfpack-shepherd-glm', { tools: { ...GLM_IMPLEMENT, bash: 'always', git_bash: 'always' } }, shimToolsFor(fullShim, 'wolfpack-shepherd-glm').tools)
  assert.ok(p.some(x => /wolfpack-shepherd-glm: profile sets "bash" to "always" — the implement role forbids it/.test(x)), p.join('\n'))
  assert.ok(p.some(x => /wolfpack-shepherd-glm: profile enables "bash" .* but the shim omits it/.test(x)))
  // a shim that leaked bash into implement mode is caught on the shim side too
  const leaky = fullShim.replace('GLM_IMPLEMENT_DROP="bash task"', 'GLM_IMPLEMENT_DROP="task"')
    .replace('GLM_IMPLEMENT_TOOLS_DEFAULT="read_file grep write_file edit', 'GLM_IMPLEMENT_TOOLS_DEFAULT="read_file grep bash write_file edit')
  const q = checkSeatParity('wolfpack-shepherd-glm', { tools: GLM_IMPLEMENT }, shimToolsFor(leaky, 'wolfpack-shepherd-glm').tools)
  assert.ok(q.some(x => /the shim enables "bash", which the implement role forbids/.test(x)), q.join('\n'))
})

test('AC4 rule 9: a pipeline seat with no installed profile → fails naming the installer', () => {
  withProfiles({}, (dir) => {
    unlinkSync(join(dir, 'wolfpack-watchdog-glm.toml'))
    const res = checkProfiles(fullShim, dir, {})
    assert.equal(res.ok, false)
    assert.equal(seatOf(res, 'wolfpack-watchdog-glm').status, 'missing')
    assert.ok(res.problems.some(p => /^wolfpack-watchdog-glm: profile not installed in .* — run node <wolfpack>\/scripts\/wolfpack-install-vibe-agents\.mjs$/.test(p)))
  })
  withProfiles({}, (dir) => {
    // a missing NOT-dispatched profile is not a parity failure (it is never run through the shim)
    unlinkSync(join(dir, 'wolfpack-alpha.toml'))
    assert.equal(checkProfiles(fullShim, dir, {}).ok, true)
  })
})

test('AC4 rule 1: the GLM shim without bash in GLM_REVIEW_TOOLS_DEFAULT → every GLM review seat fails + analyzeGlmShim fails', () => {
  const boxed = fullShim.replace('read_file grep bash write_file', 'read_file grep write_file')
  withProfiles({}, (dir) => {
    const res = checkProfiles(boxed, dir, {})
    for (const s of ['wolfpack-bloodhound-glm', 'wolfpack-pointer-glm', 'wolfpack-watchdog-glm']) {
      assert.ok(res.problems.some(p => p.startsWith(`${s}: the shim does not enable "bash", which the review role requires`)), `${s}\n${res.problems.join('\n')}`)
    }
    assert.equal(seatOf(res, 'wolfpack-pointer').status, 'ok', 'Mistral seats are unaffected')
  })
  assert.equal(analyzeGlmShim(boxed).ok, false)
})

test('AC4: an operator override WOLFPACK_GLM_TOOLS="read_file grep" is honoured → rule 1 for the GLM review seats', () => {
  withProfiles({}, (dir) => {
    const res = checkProfiles(fullShim, dir, { WOLFPACK_GLM_TOOLS: 'read_file grep' })
    assert.ok(res.problems.some(p => /^wolfpack-pointer-glm: the shim does not enable "bash"/.test(p)), res.problems.join('\n'))
    // ... and the profile's dev_cortex "always" now has no shim tool behind it (rule 5)
    assert.ok(res.problems.some(p => /wolfpack-pointer-glm: profile enables "dev_cortex_repo_map".* but the shim omits it/.test(p)))
    assert.equal(seatOf(res, 'wolfpack-shepherd-glm').status, 'ok', 'the review override does not touch implement mode')
  })
})

test('AC4: a profile parse problem surfaces under its seat (fail loud, not ignored)', () => {
  withProfiles({ 'wolfpack-pointer': { bash: 'sometimes' } }, (dir) => {
    const res = checkProfiles(fullShim, dir, {})
    assert.equal(res.ok, false)
    assert.ok(res.problems.some(p => /^wolfpack-pointer: line \d+: \[tools\.bash\] permission = "sometimes"/.test(p)), res.problems.join('\n'))
  })
})

test('defaultProfilesDir: explicit override > sandbox mount > headless dir', () => {
  assert.equal(defaultProfilesDir({ WOLFPACK_VIBE_AGENTS_DIR: '/x', HOME: '/h', WOLFPACK_SANDBOX: '1' }), '/x')
  assert.equal(defaultProfilesDir({ HOME: '/h', WOLFPACK_SANDBOX: '1' }), join('/h', '.vibe', 'agents'))
  assert.equal(defaultProfilesDir({ HOME: '/h' }), join('/h', '.vibe', 'agents-headless'))
})

// ─── CLI (AC4) ─────────────────────────────────────────────────

function withShim(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'toolcheck-shim-'))
  const p = join(dir, 'podman-vibe.sh')
  writeFileSync(p, text)
  try { return fn(p) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('CLI: capable fixture shim + matching profiles → exit 0, one ✓ per pipeline seat, · for not-dispatched', () => {
  withShim(fullShim, (shim) => withProfiles({}, (dir) => {
    const r = runCli(['--shim', shim, '--profiles', dir])
    assert.equal(r.status, 0, r.stderr + r.stdout)
    for (const name of Object.keys(PIPELINE_SEATS)) assert.match(r.stdout, new RegExp(`✓ ${name}: profile matches the shim`))
    for (const name of TRACKED_NOT_DISPATCHED) assert.match(r.stdout, new RegExp(`· ${name}: tracked, not dispatched`))
  }))
})

test('CLI AC4: pointer-glm bash = "never" → exit 1, stderr names the seat and bash', () => {
  withShim(fullShim, (shim) => withProfiles({ 'wolfpack-pointer-glm': { bash: 'never', git_bash: 'never' } }, (dir) => {
    const r = runCli(['--shim', shim, '--profiles', dir])
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /✗ wolfpack-pointer-glm: PROFILE ≠ SHIM/)
    assert.match(r.stderr, /wolfpack-pointer-glm: profile denies "bash"/)
  }))
})

test('CLI: positional shim path still works (backward compatible)', () => {
  withShim(fullShim, (shim) => withProfiles({}, (dir) => {
    assert.equal(runCli([shim, '--profiles', dir]).status, 0)
  }))
})

test('CLI: env overrides reach the parity check (WOLFPACK_GLM_TOOLS without bash → exit 1)', () => {
  withShim(fullShim, (shim) => withProfiles({}, (dir) => {
    const r = runCli(['--shim', shim, '--profiles', dir], { WOLFPACK_GLM_TOOLS: 'read_file grep' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /wolfpack-pointer-glm: the shim does not enable "bash"/)
  }))
})

test('CLI: profiles dir missing → exit 2 naming the installer; shim missing → exit 2; bad flag → exit 2', () => {
  withShim(fullShim, (shim) => {
    const gone = join(tmpdir(), `toolcheck-no-such-dir-${process.pid}`)
    const r = runCli(['--shim', shim, '--profiles', gone])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /seat profiles dir not found: .*wolfpack-install-vibe-agents\.mjs/)
    // the default dir honours WOLFPACK_VIBE_AGENTS_DIR — a missing one is exit 2, never a skip
    assert.equal(runCli(['--shim', shim], { WOLFPACK_VIBE_AGENTS_DIR: gone }).status, 2)
  })
  withProfiles({}, (dir) => {
    assert.equal(runCli(['--shim', join(tmpdir(), `no-shim-${process.pid}.sh`), '--profiles', dir]).status, 2)
  })
  const bad = runCli(['--skip-profiles'])
  assert.equal(bad.status, 2, 'there is no profile-skip flag')
  assert.match(bad.stderr, /unknown flag --skip-profiles/)
  assert.equal(runCli(['--profiles']).status, 2)
})

test('CLI: the profiles dir default is WOLFPACK_VIBE_AGENTS_DIR when set', () => {
  withShim(fullShim, (shim) => withProfiles({}, (dir) => {
    assert.equal(runCli(['--shim', shim], { WOLFPACK_VIBE_AGENTS_DIR: dir }).status, 0)
  }))
})

test('the REAL committed shim × matching fixture profiles → every pipeline seat ok', { skip: !existsSync(vibePath) && 'harness shim not present in this repo' }, () => {
  const shimText = readFileSync(vibePath, 'utf8')
  assert.deepEqual(analyzeGlmShim(shimText).problems, [])
  withProfiles({}, (dir) => {
    const res = checkProfiles(shimText, dir, {})
    assert.deepEqual(res.problems, [], res.problems.join('\n'))
  })
  // and the pre-hunt profile shape (bash "never" on review seats) fails against it
  withProfiles({ 'wolfpack-bloodhound-glm': { bash: 'never', git_bash: 'never' } }, (dir) => {
    assert.equal(checkProfiles(shimText, dir, {}).ok, false)
  })
})

const templatesDir = join(here, '..', 'vibe-agents')
test('the tracked vibe-agents/ templates pass checkProfiles against the capable fixture shim', { skip: !existsSync(templatesDir) && 'seat templates not present in this repo' }, () => {
  const res = checkProfiles(fullShim, templatesDir, {})
  assert.deepEqual(res.problems, [], res.problems.join('\n'))
  if (existsSync(vibePath)) assert.deepEqual(checkProfiles(readFileSync(vibePath, 'utf8'), templatesDir, {}).problems, [])
})

test('TOOL_DENIAL_PATTERN compiles, matches the observed denial phrases, and spares a clean transcript', () => {
  const re = new RegExp(TOOL_DENIAL_PATTERN, 'i')
  for (const line of [
    "Tool 'bash' is permanently disabled",
    'Tool execution denied by approval policy',
    'tool execution denied by the approval policy',
    "Unknown tool 'bash'",
    "<tool_error>Tool 'bash' was denied by hook 'guard': no shell</tool_error>",
    'fatal: not a git repository (or any of the parent directories): .git',
  ]) assert.ok(re.test(line), line)
  // Anchored on the emitted message shapes, not prose: a seat discussing denials does not match.
  for (const prose of [
    'Two tool calls were denied',
    'the toolcheck flags a profile where bash is permanently disabled',
    'an Unknown tool error would mark the seat audit-only',
    'the pattern matches "not a git repository" lines',
  ]) assert.equal(re.test(prose), false, prose)
  const clean = `$ git diff --stat main..HEAD
 scripts/podman-vibe.sh | 79 +++++++--
 1 file changed, 70 insertions(+), 9 deletions(-)
Ran 12 tests in 0.4s
OK
<verdict>{"verdict":"APPROVED","findings":[],"tool_access":{"shell":"ok","denied_tools":[]}}</verdict>`
  assert.equal(re.test(clean), false)
  // POSIX-ERE compatible: grep -E accepts it and finds the same line
  const g = spawnSync('grep', ['-E', '-i', '-o', TOOL_DENIAL_PATTERN], { input: "x\nTool 'bash' is permanently disabled\ny\n", encoding: 'utf8' })
  if (!g.error) assert.equal(g.stdout.trim(), "Tool 'bash' is permanently disabled")
})

// exec-layer-into-pack: with no --shim, the CLI's default shim is $WOLFPACK_HOME/scripts/podman-vibe.sh
// (else the one beside the script); a pack without it is exit 2 naming the path and the fix.
test('CLI default shim: WOLFPACK_HOME/scripts/podman-vibe.sh is the one checked', () => {
  const home = mkdtempSync(join(tmpdir(), 'tc-home-'))
  const dir = fixtureProfilesDir()
  try {
    mkdirSync(join(home, 'scripts'))
    // A RE-BOXED shim at the WOLFPACK_HOME path: exit 1 proves that file (not the local one) was read.
    writeFileSync(join(home, 'scripts', 'podman-vibe.sh'), 'VIBE_TOOLS_DEFAULT="read grep"\nVIBE_TOOL_FLAGS=()\nfor _t in $VIBE_TOOLS_DEFAULT; do VIBE_TOOL_FLAGS+=(--enabled-tools "$_t"); done\n')
    const res = runCli(['--profiles', dir], { WOLFPACK_HOME: home })
    assert.equal(res.status, 1, `${res.stdout}${res.stderr}`)
    // --shim still wins over WOLFPACK_HOME
    if (existsSync(vibePath)) {
      const res2 = runCli(['--shim', vibePath, '--profiles', dir], { WOLFPACK_HOME: home })
      assert.equal(res2.status, 0, `${res2.stdout}${res2.stderr}`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI default shim: a WOLFPACK_HOME without scripts/podman-vibe.sh → exit 2, the path + the fix', () => {
  const home = mkdtempSync(join(tmpdir(), 'tc-empty-'))
  const dir = fixtureProfilesDir()
  try {
    const res = runCli(['--profiles', dir], { WOLFPACK_HOME: home })
    assert.equal(res.status, 2)
    const want = `shim not found: ${join(home, 'scripts', 'podman-vibe.sh')}`
    assert.ok(res.stderr.includes(want), res.stderr)
    assert.match(res.stderr, /— pass --shim <path> or set WOLFPACK_HOME to the pack checkout/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI default shim: an explicit --shim that does not exist → exit 2 with the same prefix (the workflow regex)', () => {
  const res = runCli(['--shim', '/nonexistent/scripts/podman-vibe.sh', '--profiles', '/nonexistent'], { WOLFPACK_HOME: '' })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /^✗ toolcheck: shim not found: \/nonexistent\/scripts\/podman-vibe\.sh — /m)
})

// ─── seat-handoff-writes: review seats write their own handoff file ─────────
//
// AC3: write_file is REQUIRED (always) on a review/certify seat; edit stays role-denied.
// The GLM shim must enable write_file for review, never enable edit, and drop edit from
// an operator override.

test('seat-handoff-writes AC3: a review profile with write_file "always" passes (both families)', () => {
  assert.deepEqual(checkSeatParity('wolfpack-pointer', { tools: MISTRAL_REVIEW }, shimToolsFor(fullShim, 'wolfpack-pointer').tools), [])
  assert.deepEqual(checkSeatParity('wolfpack-watchdog-glm', { tools: GLM_REVIEW }, shimToolsFor(fullShim, 'wolfpack-watchdog-glm').tools), [])
  assert.deepEqual(checkSeatParity('wolfpack-bloodhound-glm', { tools: GLM_REVIEW }, shimToolsFor(fullShim, 'wolfpack-bloodhound-glm').tools), [])
})

test('seat-handoff-writes AC3: a review profile with write_file "never" or "ask" or unset fails, naming write_file', () => {
  for (const seat of ['wolfpack-pointer', 'wolfpack-pointer-glm']) {
    const base = seat.endsWith('-glm') ? GLM_REVIEW : MISTRAL_REVIEW
    const shimTools = shimToolsFor(fullShim, seat).tools
    const never = checkSeatParity(seat, { tools: { ...base, write_file: 'never' } }, shimTools)
    assert.ok(never.some(x => x.includes(`${seat}: profile sets "write_file" to "never", but the review role requires "always"`)), never.join('\n'))
    const ask = checkSeatParity(seat, { tools: { ...base, write_file: 'ask' } }, shimTools)
    assert.ok(ask.some(x => x.includes(`${seat}: profile sets "write_file" to "ask", but the review role requires "always"`)), ask.join('\n'))
    const unset = { ...base }; delete unset.write_file
    const u = checkSeatParity(seat, { tools: unset }, shimTools)
    assert.ok(u.some(x => x.includes(`${seat}: profile does not set [tools.write_file]`)), u.join('\n'))
  }
})

test('seat-handoff-writes AC3: a review profile with edit "always" fails naming edit (both families)', () => {
  for (const seat of ['wolfpack-bloodhound', 'wolfpack-watchdog-glm']) {
    const base = seat.endsWith('-glm') ? GLM_REVIEW : MISTRAL_REVIEW
    const p = checkSeatParity(seat, { tools: { ...base, edit: 'always' } }, shimToolsFor(fullShim, seat).tools)
    assert.ok(p.some(x => x.startsWith(`${seat}: profile sets "edit" to "always"`)), p.join('\n'))
  }
})

test('seat-handoff-writes: analyzeGlmShim — review list lacking write_file, enabling edit, or a drop list lacking edit each fail loud', () => {
  const noWrite = analyzeGlmShim(fullShim.replace('read_file grep bash write_file dev_cortex', 'read_file grep bash dev_cortex'))
  assert.equal(noWrite.ok, false)
  assert.ok(noWrite.problems.includes('GLM_REVIEW_TOOLS_DEFAULT lacks "write_file" — review/certify seats cannot write their handoff file'), noWrite.problems.join('\n'))
  const withEdit = analyzeGlmShim(fullShim.replace('read_file grep bash write_file dev_cortex', 'read_file grep bash write_file edit dev_cortex'))
  assert.equal(withEdit.ok, false)
  assert.ok(withEdit.problems.includes('GLM_REVIEW_TOOLS_DEFAULT enables "edit" — review/certify seats are edit-denied by role'), withEdit.problems.join('\n'))
  const dropNoEdit = analyzeGlmShim(fullShim.replace('GLM_REVIEW_DROP="task edit"', 'GLM_REVIEW_DROP="task"'))
  assert.equal(dropNoEdit.ok, false)
  assert.deepEqual(dropNoEdit.problems, ['GLM_REVIEW_DROP lacks "edit" — an operator override could hand a review seat edit'])
  // the pre-change GLM block (the shim before seat-handoff-writes) fails on exactly the two new list rules
  const preChange = analyzeGlmShim(fullShim.replace('read_file grep bash write_file dev_cortex', 'read_file grep bash dev_cortex')
    .replace('GLM_REVIEW_DROP="task edit"', 'GLM_REVIEW_DROP="task"'))
  assert.equal(preChange.problems.length, 2, preChange.problems.join('\n'))
})

test('seat-handoff-writes: an operator override WOLFPACK_GLM_TOOLS that adds edit is dropped for review seats (shim parity)', () => {
  assert.deepEqual(shimToolsFor(fullShim, 'wolfpack-pointer-glm', { WOLFPACK_GLM_TOOLS: 'read_file grep bash write_file edit' }).tools,
    ['read_file', 'grep', 'bash', 'write_file'])
  // the implement mode keeps edit (its drop list is bash task)
  assert.ok(shimToolsFor(fullShim, 'wolfpack-shepherd-glm').tools.includes('edit'))
})

test('seat-handoff-writes: the REAL committed shim\'s GLM block passes analyzeGlmShim (write_file in review, edit dropped)', { skip: !existsSync(vibePath) && 'no pack shim' }, () => {
  const real = readFileSync(vibePath, 'utf8')
  assert.deepEqual(analyzeGlmShim(real).problems, [])
  const tools = shimToolsFor(real, 'wolfpack-watchdog-glm').tools
  assert.ok(tools.includes('write_file') && !tools.includes('edit'), tools.join(' '))
})

test('seat-handoff-writes: the installer output + the real shim → toolcheck CLI exits 0', { skip: !existsSync(vibePath) && 'no pack shim' }, () => {
  const installer = join(here, 'wolfpack-install-vibe-agents.mjs')
  if (!existsSync(installer)) return
  const dest = mkdtempSync(join(tmpdir(), 'tc-install-'))
  try {
    execFileSync(process.execPath, [installer, '--dest', join(dest, 'agents')], { stdio: 'pipe' })
    const r = runCli(['--shim', vibePath, '--profiles', join(dest, 'agents')])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    for (const name of Object.keys(PIPELINE_SEATS)) assert.match(r.stdout, new RegExp(`✓ ${name}: profile matches the shim`))
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})
