// scripts/wolfpack-cron-resume.test.mjs — the cron resume entry + module (hunt: campaign-cron-resume).
//
// AC1-AC9, AC12, AC13 and the tick rules of plan Part A / Part C (A-11..A-14, Debrief R5-F2/F3).
// Hermetic: a temp HOME, a temp consumer repo, stub tmux / ps / claude / gate executables that log
// their argv as JSON lines, and a loopback HTTP server standing in for ntfy. Every case runs the
// REAL `bash scripts/wolfpack-cron-resume.sh …` (async, so the loopback server can answer).
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync, rmSync, statSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildNotification, composeUsage, huntSlugs, newestHeartbeat, validToken, validReportUrl, NOTIFY_KEYS } from './wolfpack-cron-resume.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACK = dirname(HERE)
const SH = join(HERE, 'wolfpack-cron-resume.sh')
const NODE = process.execPath
const TOPIC = 'TopicSecretAbcdefghij0123456789'
const MIN = 60 * 1000

// ─── stub executables ─────────────────────────────────────────────────────────
// One node program plays every stub; argv[2] names the tool. State lives in $STUB_DIR.
const STUB_JS = String.raw`
const fs = require('fs'), path = require('path')
const tool = process.argv[2], argv = process.argv.slice(3)
const dir = process.env.STUB_DIR
// The tmux version probe answers before the call log, so call-count assertions are unaffected.
if (tool === 'tmux' && argv[0] === '-V') {
  let v = 'tmux 3.4'; try { v = fs.readFileSync(path.join(dir, 'tmux-version'), 'utf8').trim() } catch {}
  process.stdout.write(v + '\n'); process.exit(0)
}
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ tool, argv }) + '\n')
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return d } }
const wr = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o, null, 2))
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const done = (out = '', rc = 0) => { if (out) process.stdout.write(out + '\n'); process.exit(rc) }
if (tool === 'tmux') {
  const t = rd('tmux.json', { sessions: {}, nextPid: 9000 })
  const cmd = argv[0]
  const target = flag('-t') || ''
  const [s, w] = target.replace(/:$/, ':').split(':')
  const sess = t.sessions[s]
  if (cmd === 'has-session') done('', sess ? 0 : 1)
  if (cmd === 'list-windows') { if (!sess) done('', 1); done(sess.windows.map(x => x.name).join('\n')) }
  const win = sess && sess.windows.find(x => x.name === w)
  if (cmd === 'list-panes') { if (!win) done('', 1); done(win.panes.map(p => p.pid + ' ' + (p.dead ? 1 : 0)).join('\n')) }
  if (cmd === 'capture-pane') { if (!win) done('', 1); done(win.screen || '') }
  if (cmd === 'kill-window') {
    if (!win) done('', 1)
    sess.windows = sess.windows.filter(x => x.name !== w)
    if (!sess.windows.length) delete t.sessions[s]
    wr('tmux.json', t); done()
  }
  if (cmd === 'new-window' || cmd === 'new-session') {
    const name = flag('-n')
    const sn = cmd === 'new-session' ? flag('-s') : s
    if (cmd === 'new-window' && !sess) done('', 1)
    t.sessions[sn] = t.sessions[sn] || { windows: [] }
    const copies = t.duplicateNext ? 2 : 1
    t.duplicateNext = false
    for (let i = 0; i < copies; i++) t.sessions[sn].windows.push({ name, panes: [{ pid: t.nextPid++, dead: false }], screen: '' })
    wr('tmux.json', t); done()
  }
  done('', 1)
}
if (tool === 'ps') {
  const procs = rd('procs.json', [])
  const fmt = argv[argv.indexOf('-o') + 1]
  if (fmt === 'pid=,ppid=,comm=') done(procs.map(p => p.pid + ' ' + p.ppid + ' ' + p.comm).join('\n'))
  if (fmt === 'pid=,etimes=,args=') done(procs.map(p => p.pid + ' ' + (p.etimes ?? 10) + ' ' + (p.args || p.comm)).join('\n'))
  done('', 1)
}
if (tool === 'gate') {
  const g = rd('gate.json', { decision: 'proceed', rc: 0 })
  const until = Date.now() + (g.sleepMs || 0)
  while (Date.now() < until) { /* hold the tick (and so the lock) */ }
  done(JSON.stringify({ decision: g.decision, reset_at: g.reset_at || null, degraded: !!g.degraded }), g.rc ?? 0)
}
done('', 0)   // claude, crontab: never expected to be called
`

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'wfcron-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const stub = join(root, 'stub')
  const bin = join(root, 'bin')
  for (const d of [home, stub, bin, join(repo, '.wolfpack', 'campaigns', 'c1')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(repo, '.wolfpack', 'campaigns', 'c1', 'campaign.md'), '# c1\n\n### 1. h1\n\n### 2. h2\n')
  writeFileSync(join(stub, 'stub.cjs'), STUB_JS)
  const tools = {}
  for (const t of ['tmux', 'ps', 'claude', 'crontab']) {
    const p = join(bin, t)
    writeFileSync(p, `#!/bin/bash\nexec ${NODE} ${join(stub, 'stub.cjs')} ${t} "$@"\n`)
    chmodSync(p, 0o755)
    tools[t] = p
  }
  const gate = join(stub, 'stub-gate.cjs')
  writeFileSync(gate, `process.argv.splice(2, 0, 'gate'); require(${JSON.stringify(join(stub, 'stub.cjs'))})\n`)
  // topic file 600
  mkdirSync(join(home, '.secrets', 'wolfpack'), { recursive: true })
  const topicFile = join(home, '.secrets', 'wolfpack', 'ntfy-topic')
  writeFileSync(topicFile, TOPIC + '\n', { mode: 0o600 })
  chmodSync(topicFile, 0o600)
  // usage snapshot (statusline format), default 42% / 17%
  const snapshot = join(root, 'usage-snapshot.json')
  const h = {
    root, home, repo, stub, bin, tools, gate, topicFile, snapshot,
    log: join(home, '.cache', 'wolfpack', 'cron-resume.log'),
    config: join(home, '.config', 'wolfpack', 'cron-resume.env'),
    port: null,
  }
  h.writeSnapshot = (five = 42, seven = 17) => {
    const now = Date.now() / 1000
    const rl = { five_hour: { used_percentage: five, resets_at: now + 3600 } }
    if (seven != null) rl.seven_day = { used_percentage: seven, resets_at: now + 3 * 86400 }
    writeFileSync(snapshot, JSON.stringify({ captured_at: new Date(Date.now() - 30000).toISOString(), rate_limits: rl }))
  }
  h.writeSnapshot()
  h.writeConfig = (extra = {}, omit = []) => {
    const kv = {
      WOLFPACK_HOME: PACK,
      WOLFPACK_CRON_NODE: NODE,
      WOLFPACK_CRON_TMUX: tools.tmux,
      WOLFPACK_CRON_CLAUDE: tools.claude,
      WOLFPACK_CRON_PS: tools.ps,
      WOLFPACK_CRON_GATE: gate,
      WOLFPACK_NTFY_TOPIC_FILE: topicFile,
      WOLFPACK_USAGE_SNAPSHOT: snapshot,
      ...extra,
    }
    for (const k of omit) delete kv[k]
    mkdirSync(dirname(h.config), { recursive: true })
    writeFileSync(h.config, Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  }
  h.writeConfig()
  h.env = (extra = {}) => {
    const env = {
      HOME: home, PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: stub, LANG: 'C.UTF-8',
      WOLFPACK_NTFY_SERVER: `http://127.0.0.1:${h.port}`,
    }
    for (const [k, v] of Object.entries(extra)) { if (v === null) delete env[k]; else env[k] = String(v) }
    return env
  }
  h.run = (args, { env = {}, rawEnv = null } = {}) => new Promise((resolve) => {
    const p = spawn('bash', [SH, '--repo', repo, ...args], { env: rawEnv || h.env(env), cwd: root })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('close', (code) => resolve({ code, out, err }))
  })
  h.calls = (tool) => {
    const f = join(stub, 'calls.jsonl')
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => !tool || c.tool === tool)
  }
  h.clearCalls = () => rmSync(join(stub, 'calls.jsonl'), { force: true })
  h.logText = () => existsSync(h.log) ? readFileSync(h.log, 'utf8') : ''
  h.statePath = (slug = 'c1') => join(repo, '.wolfpack', 'campaigns', slug, 'cron.json')
  h.state = (slug = 'c1') => JSON.parse(readFileSync(h.statePath(slug), 'utf8'))
  h.setState = (patch, slug = 'c1') => {
    const base = existsSync(h.statePath(slug)) ? h.state(slug) : {}
    writeFileSync(h.statePath(slug), JSON.stringify({ ...base, ...patch }, null, 2))
  }
  h.tmux = (t) => writeFileSync(join(stub, 'tmux.json'), JSON.stringify({ nextPid: 9000, ...t }))
  h.tmuxState = () => JSON.parse(readFileSync(join(stub, 'tmux.json'), 'utf8'))
  h.procs = (rows) => writeFileSync(join(stub, 'procs.json'), JSON.stringify(rows))
  h.gate = (g) => writeFileSync(join(stub, 'gate.json'), JSON.stringify(g))
  h.heartbeat = (layout, hunt, mtimeMs) => {
    const base = layout === 'main' ? repo : join(repo, layout, 'worktrees', hunt)
    const p = join(base, '.wolfpack', 'heartbeats', `${hunt}.json`)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, '{}')
    // Real heartbeat files carry nanosecond mtimes: keep a sub-millisecond fraction, as an agent's
    // write would (a whole-millisecond mtime would hide precision bugs in the progress check).
    const t = (Math.floor(mtimeMs) + 0.4321) / 1000
    utimesSync(p, t, t)
    return p
  }
  h.tmux({ sessions: {} })
  h.procs([])
  h.gate({ decision: 'proceed', rc: 0 })
  return h
}

// Loopback ntfy: records every POST.
function ntfyServer() {
  const posts = []
  let status = 200
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      posts.push({ url: req.url, headers: req.headers, body })
      res.statusCode = status
      res.end('ok')
    })
  })
  return {
    posts,
    setStatus: (s) => { status = s },
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    stop: () => new Promise(r => server.close(r)),
  }
}

const relaunches = (h) => h.calls('tmux').filter(c => c.argv[0] === 'new-window' || c.argv[0] === 'new-session')
const kills = (h) => h.calls('tmux').filter(c => c.argv[0] === 'kill-window')
const gateCalls = (h) => h.calls('gate')
const lastTick = (h) => h.state().last_tick || ''
const runnerWindow = (panes, screen = '') => ({ name: 'runner', panes, screen })
const OLD = () => Date.now() - 3 * 60 * MIN   // stale heartbeat mtime

let srv
let H   // per-test harness
const fresh = async () => { H = makeHarness(); H.port = srv.port; srv.posts.length = 0; srv.setStatus(200) }
before(async () => { const s = ntfyServer(); s.port = await s.start(); srv = s })
after(async () => { await srv.stop() })

const arm = async () => { const r = await H.run(['arm', 'c1']); assert.equal(r.code, 0, r.err) }
const tick = async (env = {}) => { const r = await H.run(['tick'], { env }); return r }

// ─── AC1, AC2 ─────────────────────────────────────────────────────────────────
describe('not armed / flock', () => {
  test('AC1: not armed is a no-op (no state, no tmux/claude/gate/notifier)', async () => {
    await fresh()
    const r = await tick()
    assert.equal(r.code, 0, r.err)
    assert.equal(existsSync(H.statePath()), false)
    assert.deepEqual(H.calls(), [])
    assert.equal(srv.posts.length, 0)
    assert.match(H.logText(), / - not armed/)
  })

  test('AC1: no campaigns dir at all → not armed, exit 0, no lock file', async () => {
    await fresh()
    rmSync(join(H.repo, '.wolfpack'), { recursive: true })
    const r = await tick()
    assert.equal(r.code, 0)
    assert.match(H.logText(), /not armed/)
    assert.equal(existsSync(join(H.repo, '.wolfpack')), false)
  })

  test('AC1: a disarmed campaign is not armed', async () => {
    await fresh()
    await arm()
    assert.equal((await H.run(['disarm'])).code, 0)
    H.clearCalls()
    assert.equal((await tick()).code, 0)
    assert.deepEqual(H.calls(), [])
  })

  test('AC2: two concurrent ticks → exactly one relaunch; the other logs tick already running', async () => {
    await fresh()
    await arm()
    H.gate({ decision: 'proceed', rc: 0, sleepMs: 1500 })
    const [a, b] = await Promise.all([tick(), tick()])
    assert.equal(a.code, 0); assert.equal(b.code, 0)
    assert.equal(relaunches(H).length, 1)
    assert.equal(gateCalls(H).length, 1)
    assert.match(H.logText(), /tick already running/)
  })
})

// ─── AC3 + K6: alive / busy pane ─────────────────────────────────────────────
describe('liveness', () => {
  for (const layout of ['.claude', '.agents', 'main']) {
    test(`AC3: live claude pane + fresh heartbeat (${layout}) → alive, nothing touched`, async () => {
      await fresh()
      await arm()
      H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 100, dead: false }])] } } })
      H.procs([{ pid: 100, ppid: 1, comm: 'claude', args: 'claude' }])
      H.heartbeat(layout, 'h2', Date.now())
      H.clearCalls()
      const r = await tick()
      assert.equal(r.code, 0, r.err)
      assert.equal(kills(H).length, 0); assert.equal(relaunches(H).length, 0)
      assert.equal(gateCalls(H).length, 0)
      assert.match(lastTick(H), / alive$/)
    })
  }

  test('AC3: busy pane (bash → claude → bash) + fresh → alive; stale → stalled, no kill', async () => {
    await fresh()
    await arm()
    H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 100, dead: false }])] } } })
    H.procs([{ pid: 100, ppid: 1, comm: 'bash' }, { pid: 101, ppid: 100, comm: 'claude', args: 'claude --permission-mode auto /run-campaign-local c1 --chain --unattended' }, { pid: 102, ppid: 101, comm: 'bash' }])
    const hb = H.heartbeat('.claude', 'h1', Date.now())
    H.clearCalls()
    await tick()
    assert.match(lastTick(H), / alive$/)
    assert.equal(gateCalls(H).length, 0)
    utimesSync(hb, OLD() / 1000, OLD() / 1000)
    await tick()
    assert.match(lastTick(H), / stalled \(1\/4\)$/)
    assert.equal(kills(H).length, 0); assert.equal(relaunches(H).length, 0); assert.equal(gateCalls(H).length, 0)
  })

  test('AC3: manually started runner (login shell → plain claude) + stale → stalled, no kill', async () => {
    await fresh()
    await arm()
    H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 200, dead: false }])] } } })
    H.procs([{ pid: 200, ppid: 1, comm: 'bash', args: '-bash' }, { pid: 201, ppid: 200, comm: 'claude', args: 'claude' }])
    H.heartbeat('.agents', 'h1', OLD())
    H.clearCalls()
    await tick()
    assert.match(lastTick(H), /stalled \(1\/4\)/)
    assert.equal(kills(H).length, 0)
  })

  test('AC3: only the shell left in the pane + stale → relaunch', async () => {
    await fresh()
    await arm()
    H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 200, dead: false }])] } } })
    H.procs([{ pid: 200, ppid: 1, comm: 'bash' }])
    H.heartbeat('.claude', 'h1', OLD())
    H.clearCalls()
    await tick()
    assert.equal(kills(H).length, 1)
    assert.equal(relaunches(H).length, 1)
    assert.match(lastTick(H), /relaunched/)
  })

  test('K6: fresh heartbeat, no paw:runner window → alive, gate not called, no relaunch', async () => {
    await fresh()
    await arm()
    H.heartbeat('.claude', 'h1', Date.now())
    H.clearCalls()
    await tick()
    assert.match(lastTick(H), /alive \(fresh heartbeats, no claude in paw:runner\)/)
    assert.equal(gateCalls(H).length, 0); assert.equal(relaunches(H).length, 0)
  })

  test('K6/A-13: an outside runner protects the campaign; c10 does not match c1', async () => {
    await fresh()
    await arm()
    H.heartbeat('.claude', 'h1', OLD())
    H.procs([{ pid: 500, ppid: 1, comm: 'claude', args: 'claude /run-campaign-local c1 --chain', etimes: 60 }])
    H.clearCalls()
    await tick()
    assert.match(lastTick(H), /stalled \(1\/4\) outside pid 500/)
    assert.equal(relaunches(H).length, 0); assert.equal(gateCalls(H).length, 0)

    // a dead paw:runner window whose last screen shows the limit: still no relaunch (step 4d)
    H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 300, dead: true }], 'x\n5-hour limit reached ∙ resets 3am')] } } })
    await tick()
    assert.match(lastTick(H), /runner outside paw:runner at the limit \(pid 500\)/)
    assert.equal(relaunches(H).length, 0)

    // args naming c10 do not match c1 → relaunch
    H.tmux({ sessions: {} })
    H.procs([{ pid: 501, ppid: 1, comm: 'claude', args: 'claude /run-campaign-local c10 --chain', etimes: 60 }])
    await tick()
    assert.equal(relaunches(H).length, 1)
  })

  test('A-13: note-exit + an outside runner started after it (no heartbeat yet) → no relaunch', async () => {
    await fresh()
    await arm()
    assert.equal((await H.run(['note-exit', '--campaign', 'c1', '--verdict', 'error'])).code, 0)
    H.setState({ session_ended_at: new Date(Date.now() - 10 * MIN).toISOString() })
    H.heartbeat('.claude', 'h1', OLD())
    H.procs([{ pid: 600, ppid: 1, comm: 'claude', args: 'claude /run-campaign-local c1 --chain', etimes: 120 }])
    H.clearCalls()
    await tick()
    assert.match(lastTick(H), /outside pid 600/)
    assert.equal(relaunches(H).length, 0); assert.equal(gateCalls(H).length, 0)
  })

  test('A-11/A-13: ended + an idle outside claude that predates the end → runner ended, relaunch; then again', async () => {
    await fresh()
    await arm()
    H.setState({ session_ended_at: new Date(Date.now() - 10 * MIN).toISOString(), last_verdict: 'WAVE_PAUSED_QUOTA' })
    H.heartbeat('.claude', 'h1', OLD())
    H.procs([{ pid: 700, ppid: 1, comm: 'claude', args: 'claude /run-campaign-local c1 --chain', etimes: 20 * 60 }])
    H.clearCalls()
    await tick()
    assert.match(H.logText(), /c1 runner ended \(WAVE_PAUSED_QUOTA\)/)
    assert.equal(gateCalls(H).length, 1)
    assert.equal(relaunches(H).length, 1)
    assert.equal(H.state().stalled_ticks, 0)
    // the same old process (now older than last_relaunch_at), the new pane gone → relaunch again
    H.tmux({ sessions: {} })
    H.clearCalls()
    await tick({ WOLFPACK_CRON_STALE_MINUTES: 0 })
    assert.equal(relaunches(H).length, 1)
    assert.doesNotMatch(lastTick(H), /stalled/)
  })
})

// ─── AC5 / A-11: quota-paused resume ─────────────────────────────────────────
describe('quota pause and ended runs', () => {
  test('AC5/A-11: note-pause → deferred until reset; then gate defer; then gate proceed relaunches', async () => {
    await fresh()
    await arm()
    H.setState({ last_relaunch_at: new Date(Date.now() - 60 * MIN).toISOString(), relaunch_judged: false })
    const resetAt = new Date(Date.now() + 1500).toISOString()
    assert.equal((await H.run(['note-pause', '--campaign', 'c1', '--reset-at', resetAt])).code, 0)
    H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 300, dead: false }], 'WAVE_PAUSED_QUOTA reset_at=2026-10-22T03:00:00Z\n> ')] } } })
    H.procs([{ pid: 300, ppid: 1, comm: 'bash' }, { pid: 301, ppid: 300, comm: 'claude', args: 'claude' }])
    H.clearCalls()
    await tick()
    assert.match(lastTick(H), /deferred until/)
    assert.equal(gateCalls(H).length, 0)
    await new Promise(r => setTimeout(r, 1700))
    H.gate({ decision: 'defer', rc: 10, reset_at: '2026-10-22T05:00:00Z' })
    await tick()
    assert.match(lastTick(H), /defer reset_at=2026-10-22T05:00:00Z/)
    assert.equal(H.state().stalled_ticks, 0)
    assert.equal(kills(H).length, 0)
    H.gate({ decision: 'proceed', rc: 0 })
    await tick()
    assert.equal(kills(H).length, 1)
    // killing the session's only window ends the session, so has-session fails → new-session
    assert.equal(relaunches(H).length, 1)
    assert.equal(H.calls('tmux').filter(c => c.argv[0] === 'has-session').length, 1)
    assert.ok(H.calls('tmux').findIndex(c => c.argv[0] === 'kill-window') < H.calls('tmux').findIndex(c => c.argv[0] === 'has-session'))
    assert.equal(H.state().session_ended_at, null)
  })

  test('note-exit alone behaves the same; a heartbeat newer than the end is not ended', async () => {
    await fresh()
    await arm()
    H.setState({ last_relaunch_at: new Date(Date.now() - 60 * MIN).toISOString() })
    assert.equal((await H.run(['note-exit', '--campaign', 'c1', '--verdict', 'WAVE_PAUSED_BUDGET'])).code, 0)
    H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 300, dead: false }], '> ')] } } })
    H.procs([{ pid: 300, ppid: 1, comm: 'bash' }, { pid: 301, ppid: 300, comm: 'claude' }])
    H.clearCalls()
    await tick()
    assert.match(H.logText(), /runner ended \(WAVE_PAUSED_BUDGET\)/)
    assert.equal(relaunches(H).length, 1)

    // fresh run: an end, then a heartbeat after it → normal classification (fresh → alive)
    await fresh()
    await arm()
    assert.equal((await H.run(['note-exit', '--campaign', 'c1', '--verdict', 'error'])).code, 0)
    H.heartbeat('.claude', 'h1', Date.now() + 1000)
    H.clearCalls()
    await tick()
    assert.doesNotMatch(H.logText(), /runner ended/)
    assert.match(lastTick(H), /alive/)
  })

  test('A-11: status shows session_ended_at and last_verdict', async () => {
    await fresh()
    await arm()
    await H.run(['note-exit', '--campaign', 'c1', '--verdict', 'WAVE_PAUSED_BUDGET'])
    const r = await H.run(['status'])
    assert.equal(r.code, 0)
    assert.match(r.out, /session_ended_at: \d{4}-\d\d-\d\dT[^ ]+Z\s+last_verdict: WAVE_PAUSED_BUDGET/)
  })

  test('note-* on an unarmed campaign is a logged no-op (exit 0)', async () => {
    await fresh()
    const r = await H.run(['note-exit', '--campaign', 'c1', '--verdict', 'error'])
    assert.equal(r.code, 0)
    assert.match(r.out, /not armed: note-exit skipped/)
    assert.equal(existsSync(H.statePath()), false)
  })
})

// ─── AC4, AC5: gate + relaunch argv ──────────────────────────────────────────
describe('gate and relaunch', () => {
  test('AC4: gate defer (exit 10, degraded) → defer logged with reset_at + DEGRADED, no relaunch', async () => {
    await fresh()
    await arm()
    H.gate({ decision: 'defer', rc: 10, reset_at: '2026-10-22T05:00:00.000Z', degraded: true })
    const r = await tick()
    assert.equal(r.code, 0)
    assert.match(H.logText(), /c1 defer reset_at=2026-10-22T05:00:00\.000Z DEGRADED/)
    assert.equal(relaunches(H).length, 0)
  })

  test('gate unavailable → ERROR, exit 1, no relaunch, no count', async () => {
    await fresh()
    await arm()
    H.gate({ decision: 'oops', rc: 3 })
    const r = await tick()
    assert.equal(r.code, 1)
    assert.match(H.logText(), /ERROR gate unavailable \(\S+stub-gate\.cjs, exit 3\)/)
    assert.equal(relaunches(H).length, 0)
    assert.equal(H.state().consecutive_failed_relaunches, 0)
  })

  test('a missing gate file fails loud naming the path; tmux older than 3.2 fails loud naming the version', async () => {
    await fresh()
    await arm()
    H.writeConfig({ WOLFPACK_CRON_GATE: join(H.stub, 'no-such-gate.mjs') })
    let r = await tick()
    assert.equal(r.code, 4)
    assert.match(r.err, /WOLFPACK_CRON_GATE=\S+no-such-gate\.mjs is not a file/)
    H.writeConfig()
    writeFileSync(join(H.stub, 'tmux-version'), 'tmux 3.1c\n')
    r = await tick()
    assert.equal(r.code, 4)
    assert.match(r.err, /is not tmux 3\.2 or later \(got 'tmux 3\.1c'\)/)
    assert.equal(relaunches(H).length, 0)
    for (const v of ['tmux next-3.6', 'tmux master', 'tmux 3.2a', 'tmux 3.10']) {
      writeFileSync(join(H.stub, 'tmux-version'), v + '\n')
      r = await tick()
      assert.doesNotMatch(r.err, /tmux 3\.2 or later/, v)
    }
  })

  test('a bad gate path blocks only tick: event, disarm and status still work', async () => {
    await fresh()
    await arm()
    H.writeConfig({ WOLFPACK_CRON_GATE: join(H.stub, 'no-such-gate.mjs') })
    for (const args of [['status'], ['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'], ['disarm']]) {
      const r = await H.run(args)
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`)
      assert.doesNotMatch(r.err, /WOLFPACK_CRON_GATE/)
    }
  })

  test('AC5: dead runner window → kill-window then new-window with the exact argv (no -p)', async () => {
    await fresh()
    await arm()
    H.tmux({ sessions: { paw: { windows: [{ name: 'shell', panes: [{ pid: 50 }] }, runnerWindow([{ pid: 300, dead: true }])] } } })
    H.clearCalls()
    const r = await tick()
    assert.equal(r.code, 0, r.err)
    const t = H.calls('tmux').map(c => c.argv)
    const ki = t.findIndex(a => a[0] === 'kill-window')
    const ni = t.findIndex(a => a[0] === 'new-window')
    assert.ok(ki >= 0 && ni > ki, JSON.stringify(t))
    assert.deepEqual(t[ki], ['kill-window', '-t', 'paw:runner'])
    const nw = t[ni]
    assert.deepEqual(nw.slice(0, 8), ['new-window', '-d', '-t', 'paw:', '-n', 'runner', '-c', H.repo])
    assert.ok(nw.includes(`WOLFPACK_HOME=${PACK}`))
    assert.ok(nw.some(a => a.startsWith('PATH=')))
    const dd = nw.indexOf('--')
    assert.deepEqual(nw.slice(dd + 1), [H.tools.claude, '--permission-mode', 'auto', '/run-campaign-local c1 --chain --unattended'])
    assert.ok(!nw.includes('-p') && !nw.includes('--print'), 'interactive claude, never -p')
    assert.deepEqual(H.tmuxState().sessions.paw.windows.map(w => w.name).filter(n => n === 'runner'), ['runner'])
    const st = H.state()
    assert.equal(st.relaunch_judged, false)
    assert.ok(st.last_relaunch_at)
    assert.equal(H.calls('claude').length, 0, 'claude is started by tmux, never by the tick')
  })

  test('AC5: no paw session → new-session -d -s paw -n runner …', async () => {
    await fresh()
    await arm()
    H.clearCalls()
    await tick()
    const ns = H.calls('tmux').find(c => c.argv[0] === 'new-session')
    assert.ok(ns)
    assert.deepEqual(ns.argv.slice(0, 6), ['new-session', '-d', '-s', 'paw', '-n', 'runner'])
    assert.equal(ns.argv[ns.argv.length - 1], '/run-campaign-local c1 --chain --unattended')
  })

  test('AC5/A-11: stale + live claude pane: limit evidence on the last line → relaunch; none → stalled; far above → stalled', async () => {
    const cases = [
      ['x\ny\n5-hour limit reached ∙ resets 3am', true],
      ['x\nworking on h1…', false],
      [['you hit your usage limit', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join('\n'), false],
    ]
    for (const [screen, relaunch] of cases) {
      await fresh()
      await arm()
      H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 300, dead: false }], screen)] } } })
      H.procs([{ pid: 300, ppid: 1, comm: 'bash' }, { pid: 301, ppid: 300, comm: 'claude' }])
      H.heartbeat('.claude', 'h1', OLD())
      H.clearCalls()
      await tick()
      assert.equal(relaunches(H).length, relaunch ? 1 : 0, screen.slice(0, 40))
      if (!relaunch) assert.match(lastTick(H), /stalled \(1\/4\)/)
      assert.doesNotMatch(H.logText(), /limit reached|usage limit|working on/, 'pane text is never logged')
    }
  })

  test('R5-F3: two runner windows after new-window → count +1 once, judged; next tick does not count it again', async () => {
    await fresh()
    await arm()
    const t = { sessions: {}, nextPid: 9000, duplicateNext: true }
    H.tmux(t)
    let r = await tick()
    assert.equal(r.code, 1)
    let st = H.state()
    assert.equal(st.consecutive_failed_relaunches, 1)
    assert.equal(st.relaunch_judged, true)
    assert.match(H.logText(), /relaunch left 2 paw:runner window\(s\)/)
    r = await tick({ WOLFPACK_CRON_STALE_MINUTES: 0 })
    st = H.state()
    assert.equal(st.consecutive_failed_relaunches, 1)
    assert.equal(st.relaunch_judged, false)
    assert.match(st.last_tick, /relaunched/)
  })
})

// ─── AC6 / A-12: crash loop + stalled counting ───────────────────────────────
describe('crash loop', () => {
  test('AC6: 4 ticks with no progress → ticks 1-3 relaunch, tick 4 disarms crash_loop with one disarm POST', async () => {
    await fresh()
    await arm()
    const env = { WOLFPACK_CRON_STALE_MINUTES: 0 }
    for (let i = 1; i <= 3; i++) {
      H.clearCalls()
      await tick(env)
      assert.equal(relaunches(H).length, 1, `tick ${i}`)
    }
    H.clearCalls()
    await tick(env)
    assert.equal(relaunches(H).length, 0)
    const st = H.state()
    assert.equal(st.armed, false)
    assert.equal(st.disarmed_reason, 'crash_loop')
    assert.equal(srv.posts.length, 1)
    assert.match(srv.posts[0].body, /^event: disarm$/m)
    assert.match(srv.posts[0].body, /^reason: crash_loop$/m)
    H.clearCalls()
    await tick(env)
    assert.deepEqual(H.calls(), [])
    assert.match(H.logText().trim().split('\n').pop(), / - not armed/)
  })

  test('AC6 variant: a heartbeat after tick 2 resets the counter; still armed after tick 4', async () => {
    await fresh()
    await arm()
    const env = { WOLFPACK_CRON_STALE_MINUTES: 0 }
    await tick(env); await tick(env)
    assert.equal(H.state().consecutive_failed_relaunches, 1)
    H.heartbeat('.claude', 'h1', Date.now())
    await tick(env)
    assert.equal(H.state().consecutive_failed_relaunches, 0)
    await tick(env)
    const st = H.state()
    assert.equal(st.armed, true)
    assert.ok(st.consecutive_failed_relaunches < 3)
    assert.equal(srv.posts.length, 0)
  })

  const stalledPane = () => {
    H.tmux({ sessions: { paw: { windows: [runnerWindow([{ pid: 300, dead: false }])] } } })
    H.procs([{ pid: 300, ppid: 1, comm: 'bash' }, { pid: 301, ppid: 300, comm: 'claude' }])
  }
  const seedRelaunch = (extra = {}) => H.setState({
    last_relaunch_at: new Date(Date.now() - 2 * 60 * MIN).toISOString(), relaunch_judged: false, ...extra,
  })

  test('A-12: 4 stalled ticks → one failure + one stalled POST; 8 more → no count, no POST; progress re-arms the page', async () => {
    await fresh()
    await arm()
    seedRelaunch()
    stalledPane()
    for (let i = 0; i < 4; i++) await tick()
    let st = H.state()
    assert.equal(st.consecutive_failed_relaunches, 1)
    assert.equal(st.relaunch_judged, true)
    assert.equal(srv.posts.length, 1)
    assert.match(srv.posts[0].body, /^event: stalled$/m)
    for (let i = 0; i < 8; i++) await tick()
    st = H.state()
    assert.equal(st.consecutive_failed_relaunches, 1)
    assert.equal(st.armed, true)
    assert.equal(srv.posts.length, 1)
    assert.match(H.logText(), /already reported/)
    assert.equal(relaunches(H).length, 0)
    H.heartbeat('.claude', 'h1', Date.now() - 60 * MIN)   // newer than the relaunch, still stale
    for (let i = 0; i < 4; i++) await tick()
    st = H.state()
    assert.equal(st.consecutive_failed_relaunches, 0)
    assert.equal(srv.posts.length, 2, H.logText() + JSON.stringify(H.state()))
  })

  test('A-12/D6: one heartbeat counts as progress ONCE (stalled ticks accumulate after it)', async () => {
    await fresh()
    await arm()
    seedRelaunch({ consecutive_failed_relaunches: 1 })
    stalledPane()
    H.heartbeat('.claude', 'h1', Date.now() - 60 * MIN)   // after the relaunch, stale now
    await tick()
    assert.equal(H.state().consecutive_failed_relaunches, 0, 'the first tick sees the heartbeat as progress')
    assert.equal(H.state().stalled_ticks, 1)
    await tick()
    await tick()
    assert.equal(H.state().stalled_ticks, 3, `the same heartbeat must not reset the stall count again: ${H.logText()}`)
  })

  test('A-12: stalled then dead → the relaunch is not counted twice', async () => {
    await fresh()
    await arm()
    seedRelaunch()
    stalledPane()
    for (let i = 0; i < 4; i++) await tick()
    assert.equal(H.state().consecutive_failed_relaunches, 1)
    H.tmux({ sessions: {} })
    H.clearCalls()
    await tick()
    assert.equal(relaunches(H).length, 1)
    assert.equal(H.state().consecutive_failed_relaunches, 1)
  })

  test('AC6/A-12: counter at 2, unjudged, 4 stalled ticks → disarm crash_loop (one disarm POST, no stalled POST)', async () => {
    await fresh()
    await arm()
    seedRelaunch({ consecutive_failed_relaunches: 2 })
    stalledPane()
    H.clearCalls()
    for (let i = 0; i < 4; i++) await tick()
    const st = H.state()
    assert.equal(st.armed, false)
    assert.equal(st.disarmed_reason, 'crash_loop')
    assert.equal(srv.posts.length, 1)
    assert.match(srv.posts[0].body, /^event: disarm$/m)
    assert.equal(relaunches(H).length, 0)
  })

  test('A-12: counter at 2 but already judged + 4 stalled ticks → stays 2, armed, one stalled POST', async () => {
    await fresh()
    await arm()
    seedRelaunch({ consecutive_failed_relaunches: 2, relaunch_judged: true })
    stalledPane()
    for (let i = 0; i < 4; i++) await tick()
    const st = H.state()
    assert.equal(st.consecutive_failed_relaunches, 2)
    assert.equal(st.armed, true)
    assert.equal(srv.posts.length, 1)
    assert.match(srv.posts[0].body, /^event: stalled$/m)
  })

  test('A-12: note-pause is progress (counter 0, judged)', async () => {
    await fresh()
    await arm()
    seedRelaunch({ consecutive_failed_relaunches: 1 })
    await H.run(['note-pause', '--campaign', 'c1', '--reset-at', new Date(Date.now() - MIN).toISOString()])
    await tick()
    const st = H.state()
    assert.equal(st.consecutive_failed_relaunches, 0)
    // judged by progress; the relaunch this tick then made is the new unjudged one
    assert.match(H.logText(), /runner ended \(WAVE_PAUSED_QUOTA\)/)
  })
})

// ─── AC2/AC13: the state lock ────────────────────────────────────────────────
describe('state lock', () => {
  test('a concurrent event waits for the tick; both writes survive', async () => {
    await fresh()
    await arm()
    H.gate({ decision: 'proceed', rc: 0, sleepMs: 1500 })
    const t = tick()
    await new Promise(r => setTimeout(r, 400))
    const e = H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'parked:open_critical', '--reason', 'open_critical'])
    const [tr, er] = await Promise.all([t, e])
    assert.equal(tr.code, 0); assert.equal(er.code, 0)
    const st = H.state()
    assert.equal(st.notified_parks.h1, 'parked:open_critical')
    assert.match(st.last_tick, /relaunched/)
  })

  test('an event that cannot get the lock in time exits 0 with WARNING state lock busy', async () => {
    await fresh()
    await arm()
    H.gate({ decision: 'proceed', rc: 0, sleepMs: 3500 })
    const t = tick()
    await new Promise(r => setTimeout(r, 400))
    const er = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'parked:x'], { env: { WOLFPACK_CRON_LOCK_WAIT: 1 } })
    assert.equal(er.code, 0)
    assert.match(er.err, /WARNING state lock busy: event dropped/)
    assert.match(er.out, /^dropped: state lock busy$/m, 'stdout names the drop so the runner logs a warning')
    assert.match(H.logText(), /WARNING state lock busy: event dropped/)
    await t
    const ar = await (async () => { const tt = tick({ WOLFPACK_CRON_STALE_MINUTES: 0 }); await new Promise(r => setTimeout(r, 400)); const a = await H.run(['disarm'], { env: { WOLFPACK_CRON_LOCK_WAIT: 1 } }); await tt; return a })()
    assert.equal(ar.code, 1, 'disarm reports a busy lock as a failure')
  })
})

// ─── entry contract / AC7 / AC8 / AC9 ────────────────────────────────────────
describe('entry and subcommands', () => {
  test('event config failure: no NODE → exit 4; no TMUX/CLAUDE → event still runs', async () => {
    await fresh()
    await arm()
    H.writeConfig({}, ['WOLFPACK_CRON_NODE'])
    let r = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'])
    assert.equal(r.code, 4)
    assert.match(r.err, /WOLFPACK_CRON_NODE not set/)
    H.writeConfig({}, ['WOLFPACK_CRON_TMUX', 'WOLFPACK_CRON_CLAUDE'])
    r = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'])
    assert.equal(r.code, 0, r.err)
    assert.equal(srv.posts.length, 1)
  })

  test('AC7: arm / second arm / status / disarm / missing campaign', async () => {
    await fresh()
    mkdirSync(join(H.repo, '.wolfpack', 'campaigns', 'c2'), { recursive: true })
    writeFileSync(join(H.repo, '.wolfpack', 'campaigns', 'c2', 'campaign.md'), '### 1. x\n')
    let r = await H.run(['arm', 'c1'])
    assert.equal(r.code, 0)
    assert.match(r.out, /armed c1: the cron resumes it in tmux paw:runner/)
    const st = H.state()
    assert.equal(st.armed, true)
    assert.equal(st.consecutive_failed_relaunches, 0)
    assert.equal(statSync(H.statePath()).mode & 0o777, 0o600)
    r = await H.run(['arm', 'c2'])
    assert.equal(r.code, 3)
    assert.match(r.out, /refused: c1 is already armed/)
    r = await H.run(['status'])
    assert.match(r.out, /armed: c1/)
    assert.match(r.out, /consecutive_failed_relaunches: 0 {2}stalled_ticks: 0/)
    r = await H.run(['disarm'])
    assert.equal(r.code, 0)
    assert.equal(H.state().armed, false)
    assert.equal(H.state().disarmed_reason, 'manual')
    r = await H.run(['arm', 'nope'])
    assert.equal(r.code, 2)
    r = await H.run(['arm', 'Bad_Slug'])
    assert.equal(r.code, 2)
    r = await H.run(['arm', 'c2'])
    assert.equal(r.code, 0, 'c1 disarmed, so c2 may arm')
  })

  test('AC8: env -i cron environment resolves from the settings file; missing CLAUDE → exit 4 naming it', async () => {
    await fresh()
    const raw = { HOME: H.home, PATH: '/usr/bin:/bin' }
    let r = await H.run(['tick'], { rawEnv: raw })
    assert.equal(r.code, 0, r.err)
    assert.match(H.logText(), /not armed/)
    H.writeConfig({}, ['WOLFPACK_CRON_CLAUDE'])
    r = await H.run(['tick'], { rawEnv: raw })
    assert.equal(r.code, 4)
    assert.match(r.err, /WOLFPACK_CRON_CLAUDE not set in .*cron-resume\.env — cron cannot find claude/)
    assert.match(H.logText(), /config_error WOLFPACK_CRON_CLAUDE not set/)
    H.writeConfig({ WOLFPACK_CRON_CLAUDE: 'claude' })
    r = await H.run(['tick'], { rawEnv: raw })
    assert.equal(r.code, 4)
    assert.match(r.err, /not an absolute path/)
    H.writeConfig({ WOLFPACK_CRON_CLAUDE: join(H.root, 'nope') })
    r = await H.run(['tick'], { rawEnv: raw })
    assert.equal(r.code, 4)
    assert.match(r.err, /not executable/)
  })

  test('AC8: a fresh HOME gets ~/.cache/wolfpack (700) on arm, and the log line', async () => {
    await fresh()
    assert.equal(existsSync(join(H.home, '.cache')), false)
    const r = await H.run(['arm', 'c1'], { rawEnv: { HOME: H.home, PATH: '/usr/bin:/bin' } })
    assert.equal(r.code, 0, r.err)
    assert.equal(statSync(join(H.home, '.cache', 'wolfpack')).mode & 0o777, 0o700)
    assert.match(H.logText(), / c1 armed/)
  })

  test('the settings file is parsed, never sourced', async () => {
    await fresh()
    const marker = join(H.root, 'sourced')
    writeFileSync(H.config, readFileSync(H.config, 'utf8') + `touch ${marker}\nWOLFPACK_X=$(touch ${marker})\n`)
    const r = await H.run(['status'])
    assert.equal(r.code, 0)
    assert.equal(existsSync(marker), false)
    assert.match(r.err, /is not a WOLFPACK_KEY=VALUE line — ignored/)
  })

  test('AC9: --print-crontab prints one line, never calls crontab, writes nothing', async () => {
    await fresh()
    const r = await H.run(['--print-crontab'])
    assert.equal(r.code, 0)
    const lines = r.out.trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^\*\/15 \* \* \* \* \/bin\/bash \/\S+\/scripts\/wolfpack-cron-resume\.sh --repo \/\S+ tick >> \/\S+\/\.cache\/wolfpack\/\S+ 2>&1$/)
    assert.ok(lines[0].includes(`--repo ${H.repo} `))
  })

  test('--print-crontab quotes a path with a space so cron does not split it', async () => {
    await fresh()
    const spaced = join(H.root, 'my repo')
    mkdirSync(spaced, { recursive: true })
    const r = await new Promise((resolve) => {
      const p = spawn('bash', [SH, '--repo', spaced, '--print-crontab'], { env: H.env() })
      let out = '', err = ''
      p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
      p.on('close', code => resolve({ code, out, err }))
    })
    assert.equal(r.code, 0, r.err)
    assert.ok(r.out.includes(`--repo ${spaced.replace(/ /g, '\\ ')} tick`), r.out)
    const pct = join(H.root, '50%off')
    mkdirSync(pct, { recursive: true })
    const bad = await new Promise((resolve) => {
      const p = spawn('bash', [SH, '--repo', pct, '--print-crontab'], { env: H.env() })
      let out = '', err = ''
      p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
      p.on('close', code => resolve({ code, out, err }))
    })
    assert.equal(bad.code, 2)
    assert.equal(bad.out, '')
    assert.match(bad.err, /cannot write a cron line for .*50%off/)
    assert.equal(H.calls('crontab').length, 0)
    assert.equal(existsSync(H.statePath()), false)
    assert.equal(existsSync(join(H.home, '.cache')), false)
  })

  test('usage errors exit 2', async () => {
    await fresh()
    for (const args of [['bogus'], ['tick', 'extra'], ['event', 'park', '--campaign', 'c1'], ['note-pause', '--campaign', 'c1', '--reset-at', 'nope']]) {
      const r = await H.run(args)
      assert.equal(r.code, 2, args.join(' '))
    }
    const r = await new Promise((resolve) => {
      const p = spawn('bash', [SH, '--repo', 'relative/x', 'status'], { env: H.env() })
      p.on('close', (code) => resolve(code))
    })
    assert.equal(r, 2)
  })
})

// ─── AC12 / AC13 / A-14: notifications ───────────────────────────────────────
describe('notifications', () => {
  test('AC12: payload allowlist — no parked.md content, title event+campaign only, topic never logged', async () => {
    await fresh()
    await arm()
    const pd = join(H.repo, '.wolfpack', 'plans', 'h1')
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, 'parked.md'), 'Client: Jane Smithers, jane@example.com\n')
    const r = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'parked:open_critical', '--reason', 'open_critical'])
    assert.equal(r.code, 0)
    assert.equal(srv.posts.length, 1)
    const p = srv.posts[0]
    assert.equal(p.url, `/${TOPIC}`)
    const keys = p.body.split('\n').map(l => l.split(':')[0])
    assert.deepEqual(keys, ['event', 'campaign', 'hunt', 'status', 'reason', 'usage', 'at'])
    assert.doesNotMatch(p.body, /Smithers|@example\.com/)
    assert.equal(p.headers.title, 'Wolfpack: park - c1')
    assert.equal(p.headers.tags, 'warning')
    assert.equal(p.headers.priority, '3')
    assert.ok(!H.logText().includes(TOPIC))
    assert.ok(!r.out.includes(TOPIC) && !r.err.includes(TOPIC))
  })

  test('A-14: usage figures 42% / 17%; no seven_day → 7d n/a', async () => {
    await fresh()
    await arm()
    await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'])
    assert.match(srv.posts[0].body, /^usage: 5h 42% · 7d 17%$/m)
    assert.doesNotMatch(H.logText(), /usage unavailable/)
    H.writeSnapshot(42, null)
    await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h2', '--status', 'needs_spec'])
    assert.match(srv.posts[1].body, /^usage: 5h 42% · 7d n\/a$/m)
  })

  test('AC13/A-14: usage unavailable (missing snapshot / currentUsage throws) still sends, with a WARNING', async () => {
    await fresh()
    await arm()
    rmSync(H.snapshot)
    let r = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'])
    assert.equal(r.code, 0)
    assert.equal(srv.posts.length, 1)
    assert.match(srv.posts[0].body, /^usage: unavailable$/m)
    assert.match(H.logText(), /WARNING notify park: usage unavailable/)
    r = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h2', '--status', 'needs_spec'], { env: { WOLFPACK_WINDOW_HOURS: 'abc' } })
    assert.equal(r.code, 0)
    assert.equal(srv.posts.length, 2, H.logText() + JSON.stringify(H.state()))
    assert.match(srv.posts[1].body, /^usage: unavailable$/m)
    r = await H.run(['notify-test'], { env: { WOLFPACK_WINDOW_HOURS: 'abc' } })
    assert.equal(r.code, 0)
    assert.match(r.out, /^sent$/m)
  })

  test('ping: pages with a reason code, armed or not', async () => {
    await fresh()
    const r = await H.run(['ping', '--reason', 'step-d-ready', '--campaign', 'c1'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^sent$/m)
    assert.equal(srv.posts.length, 1)
    assert.equal(srv.posts[0].headers.title, 'Wolfpack: ping - c1')
    assert.match(srv.posts[0].body, /^event: ping$/m)
    assert.match(srv.posts[0].body, /^reason: step-d-ready$/m)
    assert.match(H.logText(), /ping step-d-ready sent/)
  })

  test('ping: free text is refused, never sent', async () => {
    await fresh()
    for (const args of [['ping'], ['ping', '--reason', 'Call Jane Smithers'], ['ping', '--reason', 'ok', '--hunt', 'Bad Hunt'], ['ping', 'extra', '--reason', 'ok']]) {
      const r = await H.run(args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`)
    }
    assert.equal(srv.posts.length, 0)
    assert.doesNotMatch(H.logText(), /Smithers/)
  })

  test('A-14: a non-token status is dropped with a WARNING naming only the key', async () => {
    await fresh()
    await arm()
    await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'parked: Jane Smithers'])
    assert.equal(srv.posts.length, 1)
    assert.doesNotMatch(srv.posts[0].body, /^status:/m)
    assert.doesNotMatch(srv.posts[0].body, /Smithers/)
    assert.match(H.logText(), /WARNING notify: dropped status \(not a token\)/)
    assert.doesNotMatch(H.logText(), /Smithers/)
  })

  test('a failed park page is not deduped: the next event park for that hunt retries it', async () => {
    await fresh()
    await arm()
    srv.setStatus(500)
    const park = () => H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'])
    let r = await park()
    assert.equal(r.code, 0)
    assert.match(r.out, /park notification FAILED: http_500/)
    assert.equal(H.state().notified_parks.h1, undefined)
    srv.setStatus(200)
    r = await park()
    assert.match(r.out, /ok: park notified/)
    assert.equal(H.state().notified_parks.h1, 'needs_spec')
    r = await park()
    assert.match(r.out, /already notified/)
  })

  test('AC13: failed sends (500, no topic file, 644 topic file, bad server) exit 0 and surface in status', async () => {
    const cases = [
      ['http_500', () => srv.setStatus(500)],
      ['no_topic_file', () => rmSync(H.topicFile)],
      ['unsafe_topic_file', () => chmodSync(H.topicFile, 0o644)],
      ['unsafe_topic_file', () => writeFileSync(H.topicFile, 'short\n', { mode: 0o600 })],
      ['bad_server', () => {}, { WOLFPACK_NTFY_SERVER: 'http://example.com' }],
    ]
    for (const [code, setup, env] of cases) {
      await fresh()
      await arm()
      setup()
      const r = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'], { env: env || {} })
      assert.equal(r.code, 0, code)
      assert.match(H.logText(), new RegExp(`WARNING notify park failed: ${code}`))
      const s = await H.run(['status'])
      assert.match(s.out, new RegExp(`last notify failure: park \\S+ ${code}`))
    }
  })

  test('notify-unarmed: not armed → park and waiting-on-you still page, no state written, nothing disarmed', async () => {
    await fresh()
    let r = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'])
    assert.equal(r.code, 0)
    assert.equal(srv.posts.length, 1, 'not armed: the park still pages')
    assert.match(srv.posts[0].body, /^hunt: h1$/m)
    assert.match(r.out, /park notified \(not armed\)/)
    r = await H.run(['event', 'waiting-on-you', '--campaign', 'c1', '--status', 'campaign_awaiting_human'])
    assert.equal(r.code, 0)
    assert.equal(srv.posts.length, 2)
    assert.equal(existsSync(H.statePath()), false, 'no cron.json is created for an unarmed campaign')
    assert.match(H.logText(), /event park \(not armed\) sent/)
  })

  test('A-13/R5-F2: park dedupe per episode (armed)', async () => {
    await fresh()
    await arm()
    const park = () => H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'needs_spec'])
    await park(); await park()
    assert.equal(srv.posts.length, 1)
    assert.match(H.logText(), /INFO event park h1: already notified \(needs_spec\)/)
    H.heartbeat('.claude', 'h1', Date.now())
    await tick()   // progress clears the episode
    await park()
    assert.equal(srv.posts.length, 2, H.logText() + JSON.stringify(H.state()))
    // a different status for the same hunt is a new park
    await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'parked:open_critical'])
    assert.equal(srv.posts.length, 3)
  })

  test('AC11 support: ready-for-release / waiting-on-you notify then disarm', async () => {
    await fresh()
    await arm()
    let r = await H.run(['event', 'ready-for-release', '--campaign', 'c1'])
    assert.equal(r.code, 0)
    assert.equal(srv.posts.length, 1)
    assert.equal(srv.posts[0].headers.tags, 'white_check_mark')
    assert.equal(H.state().armed, false)
    assert.equal(H.state().disarmed_reason, 'completed')
    await H.run(['arm', 'c1'])
    r = await H.run(['event', 'waiting-on-you', '--campaign', 'c1', '--status', 'wave_paused_budget'])
    assert.equal(r.code, 0)
    assert.equal(H.state().disarmed_reason, 'waiting_on_human')
    assert.equal(H.state().session_ended_at, H.state().disarmed_at, 'a finish event ends the session, so a re-arm relaunches at once')
    const ended = H.state().session_ended_at
    await H.run(['arm', 'c1'])
    assert.equal(H.state().session_ended_at, ended, 're-arming keeps the finished run\'s end')
    assert.equal(H.state().armed, true)
    assert.match(srv.posts[1].body, /^status: wave_paused_budget$/m)
  })
})

// ─── wave-auto-smoke AC35: report_url ─────────────────────────────────────────
describe('report_url (wave-auto-smoke AC35)', () => {
  const URL_OK = 'http://100.123.158.39:8766/c1/'

  test('NOTIFY_KEYS = the T2 set + report_url (last), nothing else', () => {
    assert.deepEqual(NOTIFY_KEYS, ['event', 'campaign', 'hunt', 'status', 'reason', 'usage', 'at', 'report_url'])
  })

  test('validReportUrl: meshnet http URL with a port and a plain path only', () => {
    for (const u of [URL_OK, 'http://100.64.0.1:1', 'http://100.127.255.255:65535/a/b-c_d.e~f/', 'http://100.100.1.2:80']) {
      assert.ok(validReportUrl(u), u)
      assert.ok(validToken('report_url', u), u)
    }
    const bad = [
      'https://100.123.158.39:8766/c1/',            // not http
      'http://100.123.158.39/c1/',                  // no port
      'http://100.123.158.39:8766/c1/?token=abc',   // query
      'http://100.123.158.39:8766/c1/#x',           // fragment
      'http://127.0.0.1:8766/c1/',                  // loopback
      'http://0.0.0.0:8766/c1/',                    // unspecified
      'http://10.0.0.5:8766/c1/',                   // private, not meshnet
      'http://100.63.255.255:8766/',                // just below 100.64.0.0/10
      'http://100.128.0.0:8766/',                   // just above
      'http://100.123.158.300:8766/',               // octet > 255
      'http://100.123.158.39:0/',                   // port 0
      'http://100.123.158.39:65536/',               // port > 65535
      'http://dev.example.dev:8766/',               // a hostname
      'http://100.123.158.39:8766/c1/<b>',          // a character outside the path set
      'http://100.123.158.39:8766/c 1/',
      'http://100.123.158.39:8766\nextra',
      '',
    ]
    for (const u of bad) {
      assert.equal(validReportUrl(u), false, u)
      assert.equal(validToken('report_url', u), false, u)
    }
    assert.equal(validToken('report_url', 42), false)
  })

  test('WOLFPACK_REPORT_HOST pins the host', () => {
    assert.ok(validReportUrl(URL_OK, { WOLFPACK_REPORT_HOST: '100.123.158.39' }))
    assert.equal(validReportUrl(URL_OK, { WOLFPACK_REPORT_HOST: '100.123.158.40' }), false)
    assert.ok(validToken('report_url', URL_OK, { env: { WOLFPACK_REPORT_HOST: '100.123.158.39' } }))
    assert.equal(validToken('report_url', URL_OK, { env: { WOLFPACK_REPORT_HOST: '100.64.0.9' } }), false)
  })

  test('buildNotification: a bad report_url is dropped with a WARNING naming only the key', () => {
    const warns = []
    const n = buildNotification({ event: 'park', campaign: 'c1', report_url: 'http://100.123.158.39:8766/c1/?token=s3cret' },
      { warn: (m) => warns.push(m) })
    assert.ok(!('report_url' in n.fields))
    assert.deepEqual(n.dropped, ['report_url'])
    assert.deepEqual(warns, ['WARNING notify: dropped report_url (not a token)'])
    assert.ok(!n.body.includes('s3cret'))
    const ok = buildNotification({ event: 'park', campaign: 'c1', report_url: URL_OK })
    assert.match(ok.body, /^report_url: http:\/\/100\.123\.158\.39:8766\/c1\/$/m)
    assert.equal(ok.body.split('\n').pop(), `report_url: ${URL_OK}`, 'report_url is the last line')
    const pinned = buildNotification({ event: 'park', campaign: 'c1', report_url: URL_OK }, { env: { WOLFPACK_REPORT_HOST: '100.64.0.1' } })
    assert.deepEqual(pinned.dropped, ['report_url'])
  })

  test('event park --report-url sends it; the parked.md summary never reaches the payload', async () => {
    await fresh()
    await arm()
    const pd = join(H.repo, '.wolfpack', 'plans', 'h1')
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, 'parked.md'), '## Need\nThe post-merge stage blocked h1: Jane Smithers saw a 500 at /clients/42\n')
    const r = await H.run(['event', 'park', '--campaign', 'c1', '--hunt', 'h1', '--status', 'parked:reverted_from_campaign',
      '--report-url', URL_OK])
    assert.equal(r.code, 0, r.err)
    assert.equal(srv.posts.length, 1)
    const keys = srv.posts[0].body.split('\n').map(l => l.split(':')[0])
    assert.deepEqual(keys, ['event', 'campaign', 'hunt', 'status', 'usage', 'at', 'report_url'])
    assert.match(srv.posts[0].body, new RegExp(`^report_url: ${URL_OK.replace(/[.]/g, '\\.')}$`, 'm'))
    assert.doesNotMatch(srv.posts[0].body, /Smithers|blocked|clients\/42/)
  })

  test('event ready-for-release --report-url with a query string: dropped, WARNING, still sends', async () => {
    await fresh()
    await arm()
    const r = await H.run(['event', 'ready-for-release', '--campaign', 'c1', '--report-url', 'http://100.123.158.39:8766/c1/?code=x'])
    assert.equal(r.code, 0, r.err)
    assert.equal(srv.posts.length, 1)
    assert.doesNotMatch(srv.posts[0].body, /report_url|code=x/)
    assert.match(H.logText(), /WARNING notify: dropped report_url \(not a token\)/)
    assert.doesNotMatch(H.logText(), /code=x/)
    assert.equal(H.state().disarmed_reason, 'completed')
  })

  test('event waiting-on-you --report-url (a stage park) sends it', async () => {
    await fresh()
    await arm()
    const r = await H.run(['event', 'waiting-on-you', '--campaign', 'c1', '--status', 'parked:smoke_agent_failed', '--report-url', URL_OK])
    assert.equal(r.code, 0, r.err)
    assert.match(srv.posts[0].body, /^status: parked:smoke_agent_failed$/m)
    assert.match(srv.posts[0].body, /^report_url: /m)
  })
})

// ─── pure functions ──────────────────────────────────────────────────────────
describe('pure helpers', () => {
  test('buildNotification keeps only allowlisted tokens', () => {
    const warns = []
    const n = buildNotification({
      event: 'park', campaign: 'c1', hunt: 'h1', status: 'parked:x', reason: 'x', usage: '5h 1% · 7d 2%',
      at: '2026-10-22T00:00:00.000Z', report_url: 'http://100.123.158.39:8766/c1/', extra: 'leak', note: 'Jane',
    }, { warn: (m) => warns.push(m) })
    assert.deepEqual(Object.keys(n.fields), NOTIFY_KEYS)
    assert.ok(!n.body.includes('leak') && !n.body.includes('Jane'))
    assert.equal(n.title, 'Wolfpack: park - c1')
    assert.deepEqual(warns, [])
    const n2 = buildNotification({ event: 'park', campaign: 'C1 Bad', usage: '5h 101% · 7d 2%' }, { warn: (m) => warns.push(m) })
    assert.deepEqual(n2.dropped.sort(), ['campaign', 'usage'])
    assert.ok(warns.every(w => !w.includes('C1 Bad')))
  })

  test('composeUsage validates before composing', () => {
    assert.equal(composeUsage({ five_hour_pct: 42.4, seven_day_pct: 17 }).usage, '5h 42% · 7d 17%')
    assert.equal(composeUsage({ five_hour_pct: 42, seven_day_pct: null, degraded: true }).usage, '5h 42% · 7d n/a DEGRADED')
    assert.equal(composeUsage({ five_hour_pct: null }).usage, 'unavailable')
    assert.equal(composeUsage({ five_hour_pct: 400 }).usage, 'unavailable')
    assert.equal(composeUsage({ five_hour_pct: 4, seven_day_pct: 'x' }).usage, 'unavailable')
    assert.ok(validToken('usage', '5h 42% · 7d 17% DEGRADED'))
    assert.ok(!validToken('usage', '5h 42% · 7d 17% Jane'))
  })

  test('huntSlugs reads ### N. <slug> headings only', () => {
    assert.deepEqual(huntSlugs('### 1. h1\n### 2. `h-2`\n## 3. no\n### x. no\n### 4. h1\n'), ['h1', 'h-2'])
  })

  test('newestHeartbeat: whole-ms newest across all three layouts, null when none (Tracker R1 / D6)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wp-hb-'))
    try {
      assert.equal(newestHeartbeat(repo, ['a', 'b']), null)
      const paths = [
        join(repo, '.wolfpack', 'heartbeats', 'a.json'),
        join(repo, '.claude', 'worktrees', 'b', '.wolfpack', 'heartbeats', 'b.json'),
        join(repo, '.agents', 'worktrees', 'a', '.wolfpack', 'heartbeats', 'a.json'),
      ]
      const base = Date.now() - 10 * MIN
      // sub-millisecond fractions, as a real agent write carries (seconds for utimesSync)
      const secs = [base / 1000 + 0.0004321, base / 1000 + 60.1234567, base / 1000 + 30.9999]
      paths.forEach((p, i) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, '{}'); utimesSync(p, secs[i], secs[i]) })
      const got = newestHeartbeat(repo, ['a', 'b'])
      assert.ok(Number.isInteger(got), `whole ms, got ${got}`)
      assert.equal(got, Math.floor(statSync(paths[1]).mtimeMs))
      // the stored form round-trips: the same heartbeat is never newer than what a tick saw
      assert.ok(!(got > Date.parse(new Date(got).toISOString())))
      // only the hunts asked for are scanned
      assert.equal(newestHeartbeat(repo, ['a']), Math.floor(statSync(paths[2]).mtimeMs))
      assert.equal(newestHeartbeat(repo, ['zz']), null)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
