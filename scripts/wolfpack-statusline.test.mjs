// Tests for wolfpack-statusline.mjs (usage-limit-gate AC1) — run: node --test scripts/wolfpack-statusline.test.mjs
// Kept byte-identical with consuming-project copies until scripts-unfork reconciles them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { extractSnapshot, resolveInner, writeSnapshot } from './wolfpack-statusline.mjs'

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), 'wolfpack-statusline.mjs')
const NODE = process.execPath
// Fake inner status command: echoes stdin bytes back with a prefix (no re-encoding — raw bytes).
const FAKE_SRC = "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat([Buffer.from('HUD['),Buffer.concat(c),Buffer.from(']')]))})"
const FAKE = [NODE, '-e', FAKE_SRC]

const fixture = (extra = {}) => ({
  session_id: 'sess-123', transcript_path: '/tmp/u/.claude/projects/p/t.jsonl', cwd: '/tmp/u/proj',
  model: { id: 'claude-opus', display_name: 'Opus' }, prompt: 'secret prompt text',
  rate_limits: {
    five_hour: { used_percentage: 42.4, resets_at: 1760620000, extra_field: 'drop me' },
    seven_day: { used_percentage: 61, resets_at: 1760900000 },
  },
  ...extra,
})

function tmp() { return mkdtempSync(join(tmpdir(), 'wfsl-')) }
function runWrapper(input, { args = ['--', ...FAKE], env = {}, snapPath } = {}) {
  const r = spawnSync(NODE, [WRAPPER, ...args], {
    input, env: { ...process.env, WOLFPACK_STATUSLINE_DEBUG: '', ...(snapPath ? { WOLFPACK_USAGE_SNAPSHOT: snapPath } : {}), ...env },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString() }
}
function runFakeDirect(input) {
  const r = spawnSync(FAKE[0], FAKE.slice(1), { input })
  return r.stdout
}

test('AC1(a): both windows ⇒ snapshot holds EXACTLY {rate_limits, captured_at} — no cwd/transcript/model/session/prompt', () => {
  const d = tmp()
  try {
    const snapPath = join(d, 'cache', 'claude-usage.json')
    const r = runWrapper(JSON.stringify(fixture()), { snapPath })
    assert.equal(r.code, 0)
    const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
    assert.deepEqual(Object.keys(snap).sort(), ['captured_at', 'rate_limits'])
    assert.deepEqual(snap.rate_limits, {
      five_hour: { used_percentage: 42.4, resets_at: 1760620000 },
      seven_day: { used_percentage: 61, resets_at: 1760900000 },
    })
    assert.ok(Math.abs(Date.parse(snap.captured_at) - Date.now()) < 60 * 1000)
    const raw = readFileSync(snapPath, 'utf8')
    for (const leak of ['sess-123', 'transcript', '/tmp/u/proj', 'Opus', 'secret prompt', 'drop me']) {
      assert.equal(raw.includes(leak), false, `snapshot leaked ${leak}`)
    }
    // private file, no tmp leftovers
    assert.equal(statSync(snapPath).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(join(d, 'cache')), ['claude-usage.json'])
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('AC1(b): stdout is byte-identical to the inner command run directly (ASCII, UTF-8 multi-byte, no trailing newline)', () => {
  const d = tmp()
  try {
    const inputs = [
      Buffer.from(JSON.stringify(fixture()) + '\n'),
      Buffer.from(JSON.stringify(fixture({ cwd: '/tmp/u/Café ☕ 日本語 🐾' }))),     // multi-byte, no newline
      Buffer.from('plain text, not JSON, no newline'),
      Buffer.from([0xe2, 0x9c, 0x93, 0x0a, 0xf0, 0x9f, 0x90, 0xbe]),                      // raw UTF-8 bytes
    ]
    for (const input of inputs) {
      const r = runWrapper(input, { snapPath: join(d, 's.json') })
      assert.equal(r.code, 0)
      assert.ok(Buffer.compare(r.stdout, runFakeDirect(input)) === 0, `stdout differs for ${input.toString('hex').slice(0, 40)}`)
      assert.ok(r.stdout.subarray(4, 4 + input.length).equals(input))
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('AC1(c): no rate_limits ⇒ the pre-existing snapshot is untouched (content + mtime)', () => {
  const d = tmp()
  try {
    const snapPath = join(d, 'claude-usage.json')
    const prior = '{"rate_limits":{"five_hour":{"used_percentage":1,"resets_at":2}},"captured_at":"2026-01-01T00:00:00.000Z"}\n'
    writeFileSync(snapPath, prior)
    const old = new Date('2026-01-01T00:00:00Z')
    utimesSync(snapPath, old, old)
    const before = statSync(snapPath).mtimeMs
    for (const input of [{ cwd: '/x', model: {} }, { rate_limits: {} }, { rate_limits: null }, { rate_limits: { five_hour: { used_percentage: 5 } } }]) {
      const r = runWrapper(JSON.stringify(input), { snapPath })
      assert.equal(r.code, 0)
    }
    assert.equal(readFileSync(snapPath, 'utf8'), prior)
    assert.equal(statSync(snapPath).mtimeMs, before)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('AC1(d): an unwritable snapshot location (a FILE where the dir should be) ⇒ identical stdout, exit 0, silent stderr', () => {
  const d = tmp()
  try {
    writeFileSync(join(d, 'blocker'), 'i am a file')
    const snapPath = join(d, 'blocker', 'sub', 'claude-usage.json')
    const input = Buffer.from(JSON.stringify(fixture()))
    const r = runWrapper(input, { snapPath })
    assert.equal(r.code, 0)
    assert.ok(Buffer.compare(r.stdout, runFakeDirect(input)) === 0)
    assert.equal(r.stderr, '')                                    // status-line stderr stays quiet
    // with debug on, the failure is explained on stderr — still never on stdout
    const dbg = runWrapper(input, { snapPath, env: { WOLFPACK_STATUSLINE_DEBUG: '1' } })
    assert.equal(dbg.code, 0)
    assert.ok(Buffer.compare(dbg.stdout, runFakeDirect(input)) === 0)
    assert.match(dbg.stderr, /snapshot write failed/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('AC1(e): non-JSON stdin passes through and writes nothing', () => {
  const d = tmp()
  try {
    const snapPath = join(d, 'claude-usage.json')
    const input = Buffer.from('{"rate_limits": broken')
    const r = runWrapper(input, { snapPath })
    assert.equal(r.code, 0)
    assert.ok(Buffer.compare(r.stdout, runFakeDirect(input)) === 0)
    assert.equal(existsSync(snapPath), false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('AC1(e): a window with used_percentage but no resets_at is omitted; if it was the only window nothing is written', () => {
  const d = tmp()
  try {
    const snapPath = join(d, 'claude-usage.json')
    runWrapper(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 33 } } }), { snapPath })
    assert.equal(existsSync(snapPath), false)
    runWrapper(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 33, resets_at: 1760620000 }, seven_day: { used_percentage: 70 } } }), { snapPath })
    const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
    assert.deepEqual(snap.rate_limits, { five_hour: { used_percentage: 33, resets_at: 1760620000 } })
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('AC1(f): the inner exit code propagates; a missing inner prints ONE visible line', () => {
  const d = tmp()
  try {
    const snapPath = join(d, 's.json')
    const r = runWrapper('{}', { snapPath, args: ['--', NODE, '-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(3))'] })
    assert.equal(r.code, 3)
    const missing = runWrapper(JSON.stringify(fixture()), { snapPath, args: ['--', join(d, 'no-such-binary')] })
    assert.equal(missing.code, 0)
    assert.match(missing.stdout.toString(), /^wolfpack-statusline: inner status command unavailable \(/)
    assert.equal(missing.stdout.toString().trim().split('\n').length, 1)
    // the snapshot is still captured even when the inner is unavailable
    assert.ok(existsSync(snapPath))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('AC1: WOLFPACK_STATUSLINE_INNER runs via /bin/sh -c', () => {
  const d = tmp()
  try {
    const r = runWrapper('abc', { args: [], snapPath: join(d, 's.json'), env: { WOLFPACK_STATUSLINE_INNER: 'printf "[%s]" "$(cat)"' } })
    assert.equal(r.code, 0)
    assert.equal(r.stdout.toString(), '[abc]')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('AC1: a half-open stdin (no EOF) does not hang the status line — the idle timer finishes the read', async () => {
  const d = tmp()
  try {
    const child = spawn(NODE, [WRAPPER, '--', ...FAKE], {
      env: { ...process.env, WOLFPACK_USAGE_SNAPSHOT: join(d, 's.json') }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = []
    child.stdout.on('data', c => out.push(c))
    const started = Date.now()
    child.stdin.write(JSON.stringify(fixture()))          // NOTE: never end()
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('wrapper hung on half-open stdin')) }, 8000)
      child.on('close', (c) => { clearTimeout(t); resolve(c) })
    })
    assert.equal(code, 0)
    assert.ok(Date.now() - started < 8000)
    assert.match(Buffer.concat(out).toString(), /^HUD\[\{/)
    assert.ok(existsSync(join(d, 's.json')))
    child.stdin.destroy()
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('extractSnapshot: whitelists window fields, drops invalid windows, null when nothing valid', () => {
  const iso = '2026-10-16T00:00:00.000Z'
  assert.deepEqual(extractSnapshot(fixture(), iso), {
    rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 1760620000 }, seven_day: { used_percentage: 61, resets_at: 1760900000 } },
    captured_at: iso,
  })
  assert.equal(extractSnapshot(null, iso), null)
  assert.equal(extractSnapshot('str', iso), null)
  assert.equal(extractSnapshot({ rate_limits: 'x' }, iso), null)
  assert.equal(extractSnapshot({ rate_limits: { five_hour: { used_percentage: '4', resets_at: 1 } } }, iso), null)
  assert.equal(extractSnapshot({ rate_limits: { five_hour: { used_percentage: 4, resets_at: 0 } } }, iso), null)
  assert.deepEqual(extractSnapshot({ rate_limits: { seven_day: { used_percentage: 4, resets_at: 9 }, other: { used_percentage: 1, resets_at: 1 } } }, iso).rate_limits,
    { seven_day: { used_percentage: 4, resets_at: 9 } })
})

test('writeSnapshot: returns false (never throws) on non-JSON / no windows / fs failure; true + atomic write on success', () => {
  const d = tmp()
  try {
    const p = join(d, 'deep', 'x', 'claude-usage.json')
    assert.equal(writeSnapshot(Buffer.from('nope'), p, 'now'), false)
    assert.equal(writeSnapshot(Buffer.from('{}'), p, 'now'), false)
    assert.equal(writeSnapshot(Buffer.from(JSON.stringify(fixture())), p, 'T'), true)
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).captured_at, 'T')
    assert.equal(statSync(dirname(p)).mode & 0o777, 0o700)
    writeFileSync(join(d, 'f'), '')
    assert.equal(writeSnapshot(Buffer.from(JSON.stringify(fixture())), join(d, 'f', 'y.json'), 'T'), false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ─── resolveInner ───
const dirent = (name, dir = true) => ({ name, isDirectory: () => dir })
function probe(tree) {
  return {
    readdirSync: (p) => { if (!(p in tree.dirs)) throw new Error('ENOENT'); return tree.dirs[p] },
    existsSync: (p) => tree.files.includes(p),
  }
}

test('resolveInner: `--` argv wins, then WOLFPACK_STATUSLINE_INNER, then claude-hud discovery', () => {
  assert.deepEqual(resolveInner(['--', 'bash', '-c', 'x'], { WOLFPACK_STATUSLINE_INNER: 'ignored' }), { cmd: 'bash', args: ['-c', 'x'] })
  assert.ok(resolveInner(['--'], {}).error)
  assert.deepEqual(resolveInner([], { WOLFPACK_STATUSLINE_INNER: 'echo hi' }), { cmd: '/bin/sh', args: ['-c', 'echo hi'] })
})

test('resolveInner: picks the highest NUMERIC semver claude-hud with dist/index.js (0.11.2 > 0.9.9; skips a dir without dist)', () => {
  const base = join('/cfg', 'plugins', 'cache', 'claude-hud', 'claude-hud')
  const tree = {
    dirs: { [base]: [dirent('0.9.9'), dirent('0.11.2'), dirent('0.10.5'), dirent('0.12.0'), dirent('README.md', false)] },
    files: [join(base, '0.9.9', 'dist', 'index.js'), join(base, '0.11.2', 'dist', 'index.js'), join(base, '0.10.5', 'dist', 'index.js')],
  }
  const r = resolveInner([], { CLAUDE_CONFIG_DIR: '/cfg' }, probe(tree))
  assert.equal(r.cmd, process.execPath)
  assert.deepEqual(r.args, [join(base, '0.11.2', 'dist', 'index.js')])   // 0.12.0 has no dist → skipped
  // HOME fallback when CLAUDE_CONFIG_DIR is unset
  const hb = join('/h', '.claude', 'plugins', 'cache', 'claude-hud', 'claude-hud')
  const r2 = resolveInner([], { HOME: '/h' }, probe({ dirs: { [hb]: [dirent('1.0.0')] }, files: [join(hb, '1.0.0', 'dist', 'index.js')] }))
  assert.deepEqual(r2.args, [join(hb, '1.0.0', 'dist', 'index.js')])
  assert.match(resolveInner([], { CLAUDE_CONFIG_DIR: '/nope' }, probe({ dirs: {}, files: [] })).error, /claude-hud not found/)
  assert.match(resolveInner([], { CLAUDE_CONFIG_DIR: '/cfg' }, probe({ dirs: { [base]: [dirent('1.0.0')] }, files: [] })).error, /no claude-hud dist/)
})

// (g) opt-in parity against the REAL claude-hud (depends on transcript/config/clock ⇒ flaky in CI).
const realHud = resolveInner([], process.env)
test('AC1(g): real claude-hud parity (opt-in: WOLFPACK_TEST_REAL_HUD=1)', {
  skip: process.env.WOLFPACK_TEST_REAL_HUD !== '1' ? 'set WOLFPACK_TEST_REAL_HUD=1 to run' : (realHud.error || false),
}, () => {
  const d = tmp()
  try {
    const input = JSON.stringify(fixture({ cwd: homedir(), transcript_path: '/nonexistent.jsonl' }))
    const direct = spawnSync(realHud.cmd, realHud.args, { input }).stdout
    const wrapped = runWrapper(input, { args: [], snapPath: join(d, 's.json') }).stdout
    assert.equal(wrapped.toString(), direct.toString())
  } finally { rmSync(d, { recursive: true, force: true }) }
})
