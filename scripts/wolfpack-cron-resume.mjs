#!/usr/bin/env node
// scripts/wolfpack-cron-resume.mjs — the logic behind scripts/wolfpack-cron-resume.sh.
//
// Run it through the .sh entry, never directly: the entry reads the settings file, resolves
// the tools (absolute paths, AC8), creates the log directory and holds the repo's state lock
// while this module runs. This module reads ONLY the resolved WOLFPACK_CRON_* / WOLFPACK_NTFY_*
// environment the entry exports. See docs/cron-resume.md.
//
// State: <repo>/.wolfpack/campaigns/<slug>/cron.json (gitignored runtime state). Written
// atomically (tmp + rename), always under the state lock.
//
// Never logs: the ntfy topic, the topic URL, captured pane text, or any file content.
// Notifications carry allowlisted tokens only (no free text) — see buildNotification.

import {
  readFileSync, writeFileSync, renameSync, existsSync, statSync, lstatSync, readdirSync, appendFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

// ─── tokens (A-14) ────────────────────────────────────────────────────────────
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/
export const CODE_RE = /^[a-z0-9_:.-]{1,64}$/
export const CAMPAIGN_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/   // reaches tmux argv: stricter
export const VERDICT_RE = /^[A-Za-z0-9_:.-]{1,64}$/
export const USAGE_RE = /^(5h ([0-9]{1,3})% · 7d (([0-9]{1,3})%|n\/a)( DEGRADED)?|unavailable)$/
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
export const TOPIC_RE = /^[A-Za-z0-9_-]{24,64}$/
export const NOTIFY_KEYS = ['event', 'campaign', 'hunt', 'status', 'reason', 'usage', 'at', 'report_url']
// report_url (post-merge stage release report, AC35): a plain http URL on the meshnet
// (100.64.0.0/10), explicit port, a path of [A-Za-z0-9._~/-] only, no query or fragment.
export const REPORT_URL_RE = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})(\/[A-Za-z0-9._~\/-]*)?$/
const WARNING_EVENTS = new Set(['park', 'disarm', 'waiting-on-you', 'stalled'])

export class ConfigError extends Error {}
export class UsageError extends Error {}

// ─── context ─────────────────────────────────────────────────────────────────
const intSetting = (env, key, def, min) => {
  const raw = env[key]
  if (raw === undefined || raw === '') return def
  if (!/^[0-9]+$/.test(String(raw)) || Number(raw) < min) {
    throw new ConfigError(`${key}=${raw} is not a whole number >= ${min}`)
  }
  return Number(raw)
}
const reSetting = (env, key, def, flags) => {
  const raw = env[key] || def
  try { return new RegExp(raw, flags) } catch (e) { throw new ConfigError(`${key} is not a valid regular expression (${e.message})`) }
}

export function loadContext(env = process.env) {
  const repo = env.WOLFPACK_CRON_REPO
  if (!repo || !repo.startsWith('/')) throw new ConfigError('WOLFPACK_CRON_REPO is not set — run this through wolfpack-cron-resume.sh')
  const home = env.HOME || ''
  const ctx = {
    env,
    repo,
    campaignsDir: join(repo, '.wolfpack', 'campaigns'),
    packHome: env.WOLFPACK_HOME || '',
    config: env.WOLFPACK_CRON_CONFIG || '',
    log: env.WOLFPACK_CRON_LOG || join(home, '.cache', 'wolfpack', 'cron-resume.log'),
    node: env.WOLFPACK_CRON_NODE || process.execPath,
    tmux: env.WOLFPACK_CRON_TMUX || '',
    claude: env.WOLFPACK_CRON_CLAUDE || '',
    ps: env.WOLFPACK_CRON_PS || '/bin/ps',
    gate: env.WOLFPACK_CRON_GATE || join(env.WOLFPACK_HOME || '', 'scripts', 'wolfpack-window-gate.mjs'),
    session: env.WOLFPACK_CRON_TMUX_SESSION || 'paw',
    window: env.WOLFPACK_CRON_TMUX_WINDOW || 'runner',
    staleMs: intSetting(env, 'WOLFPACK_CRON_STALE_MINUTES', 45, 0) * 60 * 1000,
    stallTicks: intSetting(env, 'WOLFPACK_CRON_STALL_TICKS', 4, 1),
    permissionMode: env.WOLFPACK_CRON_PERMISSION_MODE || 'auto',
    limitRe: reSetting(env, 'WOLFPACK_CRON_LIMIT_RE', '(usage limit|limit reached|resets [0-9])', 'i'),
    limitLines: intSetting(env, 'WOLFPACK_CRON_LIMIT_LINES', 12, 1),
    procRe: reSetting(env, 'WOLFPACK_CRON_PROC_RE', '^(claude|node)$', ''),
    sessionPath: env.WOLFPACK_CRON_SESSION_PATH || `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    ntfyServer: env.WOLFPACK_NTFY_SERVER || 'https://ntfy.sh',
    topicFile: env.WOLFPACK_NTFY_TOPIC_FILE || join(home, '.secrets', 'wolfpack', 'ntfy-topic'),
    now: () => Date.now(),
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
  }
  if (!/^[A-Za-z]+$/.test(ctx.permissionMode)) throw new ConfigError(`WOLFPACK_CRON_PERMISSION_MODE=${ctx.permissionMode} is not a permission mode name`)
  if (!/^[A-Za-z0-9_-]+$/.test(ctx.session) || !/^[A-Za-z0-9_-]+$/.test(ctx.window)) {
    throw new ConfigError('WOLFPACK_CRON_TMUX_SESSION / WOLFPACK_CRON_TMUX_WINDOW must be plain names ([A-Za-z0-9_-])')
  }
  return ctx
}

const iso = (ms) => new Date(ms).toISOString()
const ms = (v) => { if (v == null) return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null }
const maxMs = (...vals) => { const xs = vals.filter(v => v != null); return xs.length ? Math.max(...xs) : null }

// One structured log line: `<iso> <campaign|-> <event> <detail>`. Never topic, never pane text.
export function logLine(ctx, campaign, event, detail = '') {
  const line = `${iso(ctx.now())} ${campaign || '-'} ${event}${detail ? ` ${detail}` : ''}\n`
  try { appendFileSync(ctx.log, line) } catch (e) { ctx.err(`WARNING: cannot write ${ctx.log} (${e.code || e.message}): ${line.trim()}`) }
}

// ─── state ────────────────────────────────────────────────────────────────────
export function defaultState() {
  return {
    armed: false, armed_at: null, disarmed_reason: null, disarmed_at: null,
    consecutive_failed_relaunches: 0, stalled_ticks: 0,
    last_relaunch_at: null, relaunch_judged: true, last_heartbeat_seen: null,
    defer_until: null, last_pause_at: null, session_ended_at: null, last_verdict: null,
    notified_parks: {}, stall_notified_for: null, last_tick: null, last_notify_failure: null,
  }
}
export function freshArmedState(nowMs) {
  return { ...defaultState(), armed: true, armed_at: iso(nowMs) }
}

const statePath = (ctx, slug) => join(ctx.campaignsDir, slug, 'cron.json')

export function readState(ctx, slug) {
  const p = statePath(ctx, slug)
  if (!existsSync(p)) return null
  let parsed
  try { parsed = JSON.parse(readFileSync(p, 'utf8')) } catch (e) {
    throw new Error(`${p} is not valid JSON (${e.message}) — fix or delete it; nothing was changed`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${p} is not a JSON object — fix or delete it`)
  const st = { ...defaultState(), ...parsed }
  if (!st.notified_parks || typeof st.notified_parks !== 'object') st.notified_parks = {}
  return st
}

export function writeState(ctx, slug, st) {
  const p = statePath(ctx, slug)
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, p)
}

// Every campaign with a cron.json, armed or not.
export function listStates(ctx) {
  if (!existsSync(ctx.campaignsDir)) return []
  const out = []
  for (const name of readdirSync(ctx.campaignsDir).sort()) {
    if (name.startsWith('.')) continue
    if (!existsSync(statePath(ctx, name))) continue
    out.push({ slug: name, state: readState(ctx, name) })
  }
  return out
}
export const armedCampaigns = (ctx) => listStates(ctx).filter(x => x.state.armed === true)

// ─── campaign heartbeats ─────────────────────────────────────────────────────
// Hunt slugs from campaign.md `### N. <slug>` headings (a liveness signal only).
export function huntSlugs(campaignMd) {
  const out = []
  for (const line of String(campaignMd).split('\n')) {
    const m = line.match(/^###\s+\d+\.\s+`?([a-z0-9][a-z0-9._-]*)`?\s*$/)
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

// Newest heartbeat mtime (ms) across the three layouts wolfpack-watch.sh scans, or null.
// Whole milliseconds: mtimeMs carries a sub-millisecond fraction, but the tick stores what it
// saw as an ISO string (last_heartbeat_seen, whole ms). Comparing the raw float against that
// stored value would make the same heartbeat "new" on every tick (A-12/D6: progress once).
export function newestHeartbeat(repo, hunts) {
  let newest = null
  for (const h of hunts) {
    for (const p of [
      join(repo, '.wolfpack', 'heartbeats', `${h}.json`),
      join(repo, '.claude', 'worktrees', h, '.wolfpack', 'heartbeats', `${h}.json`),
      join(repo, '.agents', 'worktrees', h, '.wolfpack', 'heartbeats', `${h}.json`),
    ]) {
      try {
        const t = Math.floor(statSync(p).mtimeMs)
        if (newest == null || t > newest) newest = t
      } catch { /* absent layout */ }
    }
  }
  return newest
}

// ─── processes ───────────────────────────────────────────────────────────────
function run(cmd, args, { timeout = 30000, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null }
}

const tmux = (ctx, ...a) => run(ctx.tmux, a, { timeout: 20000 })

// Window names of the session, or null when the session does not exist.
function windowNames(ctx) {
  const r = tmux(ctx, 'list-windows', '-t', ctx.session, '-F', '#{window_name}')
  if (r.error || r.status !== 0) return null
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

function panes(ctx) {
  const r = tmux(ctx, 'list-panes', '-t', `${ctx.session}:${ctx.window}`, '-F', '#{pane_pid} #{pane_dead}')
  if (r.error || r.status !== 0) return []
  return r.stdout.split('\n').map(l => l.trim().split(/\s+/)).filter(a => /^\d+$/.test(a[0] || ''))
    .map(a => ({ pid: Number(a[0]), dead: a[1] === '1' }))
}

// Bottom-of-screen usage-limit evidence (A-11 item 3). Matched in memory, never logged.
function limitEvidence(ctx) {
  const r = tmux(ctx, 'capture-pane', '-p', '-t', `${ctx.session}:${ctx.window}`)
  if (r.error || r.status !== 0) return false
  const lines = r.stdout.split('\n').filter(l => l.trim() !== '')
  return lines.slice(-ctx.limitLines).some(l => ctx.limitRe.test(l))
}

// One process table: pid → {ppid, comm, etimes, args}. A ps failure is fatal for the tick.
export function readProcs(ctx) {
  const a = run(ctx.ps, ['-e', '-o', 'pid=,ppid=,comm='])
  const b = run(ctx.ps, ['-e', '-o', 'pid=,etimes=,args='])
  if (a.error || a.status !== 0 || b.error || b.status !== 0) {
    throw new Error(`ps failed (${ctx.ps}: exit ${a.status ?? b.status ?? 'none'})`)
  }
  const procs = new Map()
  for (const l of a.stdout.split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/)
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3], etimes: null, args: '' })
  }
  for (const l of b.stdout.split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/)
    if (!m) continue
    const pid = Number(m[1])
    const p = procs.get(pid) || { ppid: null, comm: '', etimes: null, args: '' }
    p.etimes = Number(m[2]); p.args = m[3]
    procs.set(pid, p)
  }
  return procs
}

export function descendants(procs, roots) {
  const kids = new Map()
  for (const [pid, p] of procs) {
    if (p.ppid == null) continue
    if (!kids.has(p.ppid)) kids.set(p.ppid, [])
    kids.get(p.ppid).push(pid)
  }
  const tree = new Set()
  const stack = [...roots]
  while (stack.length) {
    const pid = stack.pop()
    if (tree.has(pid)) continue
    tree.add(pid)
    for (const k of kids.get(pid) || []) stack.push(k)
  }
  return tree
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ─── notifications (Part C) ──────────────────────────────────────────────────
const validInt = (v) => Number.isInteger(v) && v >= 0 && v <= 100

export function validReportUrl(v, env = {}) {
  const m = REPORT_URL_RE.exec(v)
  if (!m) return false
  const octets = m.slice(1, 5).map(Number)
  if (octets.some(o => o > 255)) return false
  // 100.64.0.0/10: first octet 100, second 64–127.
  if (octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) return false
  const port = Number(m[5])
  if (port < 1 || port > 65535) return false
  const pin = env && env.WOLFPACK_REPORT_HOST
  if (pin && octets.join('.') !== pin) return false
  return true
}

export function validToken(key, v, ctx = {}) {
  if (typeof v !== 'string') return false
  if (key === 'report_url') return validReportUrl(v, ctx.env || {})
  if (key === 'campaign' || key === 'hunt') return SLUG_RE.test(v)
  if (key === 'event' || key === 'status' || key === 'reason') return CODE_RE.test(v)
  if (key === 'at') return ISO_UTC_RE.test(v)
  if (key === 'usage') {
    const m = v.match(USAGE_RE)
    if (!m) return false
    if (v === 'unavailable') return true
    return validInt(Number(m[2])) && (m[3] === 'n/a' || validInt(Number(m[4])))
  }
  return false
}

// Compose `usage` from a currentUsage() decision; integers validated BEFORE composition.
export function composeUsage(d) {
  if (!d || typeof d !== 'object') return { usage: 'unavailable', why: 'no_figures' }
  const f = d.five_hour_pct
  if (typeof f !== 'number' || !Number.isFinite(f)) return { usage: 'unavailable', why: 'no_figures' }
  const fi = Math.round(f)
  if (!validInt(fi)) return { usage: 'unavailable', why: 'no_figures' }
  const s = d.seven_day_pct
  let week
  if (s == null) week = 'n/a'
  else if (typeof s === 'number' && Number.isFinite(s) && validInt(Math.round(s))) week = `${Math.round(s)}%`
  else return { usage: 'unavailable', why: 'no_figures' }
  return { usage: `5h ${fi}% · 7d ${week}${d.degraded ? ' DEGRADED' : ''}`, why: null }
}

// Pure: allowlisted fields → {title, body, tags, priority, fields, dropped}. Any value that is
// not a token is DROPPED (warn names the key only, never the value).
export function buildNotification(fields, { warn = () => {}, env = {} } = {}) {
  const kept = {}
  const dropped = []
  for (const k of NOTIFY_KEYS) {
    const v = fields[k]
    if (v == null) continue
    if (validToken(k, v, { env })) kept[k] = v
    else { dropped.push(k); warn(`WARNING notify: dropped ${k} (not a token)`) }
  }
  const event = kept.event || 'notification'
  // ASCII only: an HTTP header value cannot carry U+2014.
  const title = `Wolfpack: ${event}${kept.campaign ? ` - ${kept.campaign}` : ''}`
  const body = NOTIFY_KEYS.filter(k => k in kept).map(k => `${k}: ${kept[k]}`).join('\n')
  const tags = kept.event === 'ready-for-release' ? 'white_check_mark' : (WARNING_EVENTS.has(kept.event) ? 'warning' : 'bell')
  const priority = kept.event === 'disarm' ? '4' : '3'
  return { title, body, tags, priority, fields: kept, dropped }
}

async function readUsage(ctx, event) {
  let out
  try {
    const mod = await import(new URL('./wolfpack-usage.mjs', import.meta.url).href)
    out = composeUsage(mod.currentUsage({ env: ctx.env }))
  } catch (e) {
    out = { usage: 'unavailable', why: (e && e.constructor && e.constructor.name) || 'error' }
  }
  if (out.why) logLine(ctx, '-', 'WARNING', `notify ${CODE_RE.test(event) ? event : 'unknown'}: usage unavailable (${out.why})`)
  return out.usage
}

function topicFromFile(path) {
  let st
  try { st = lstatSync(path) } catch { return { code: 'no_topic_file' } }
  if (!st.isFile()) return { code: 'unsafe_topic_file' }
  if ((st.mode & 0o777) !== 0o600) return { code: 'unsafe_topic_file' }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { code: 'unsafe_topic_file' }
  let t
  try { t = readFileSync(path, 'utf8').trim() } catch { return { code: 'no_topic_file' } }
  if (!TOPIC_RE.test(t)) return { code: 'unsafe_topic_file' }
  return { topic: t }
}

function serverBase(server) {
  const s = String(server || '').replace(/\/+$/, '')
  if (/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(s)) return s
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(s)) return s
  return null
}

// Send one notification. NEVER throws and never blocks longer than the 10 s timeout (AC13).
// A failure is a WARNING log line plus state.last_notify_failure (when a state is given; the
// caller writes it). Returns {ok, code}.
export async function sendNotification(ctx, fields, state = null) {
  const event = CODE_RE.test(String(fields.event || '')) ? fields.event : 'unknown'
  const at = iso(ctx.now())
  const fail = (code) => {
    logLine(ctx, fields.campaign && SLUG_RE.test(fields.campaign) ? fields.campaign : '-', 'WARNING', `notify ${event} failed: ${code}`)
    if (state) state.last_notify_failure = { event, at, reason: code }
    return { ok: false, code }
  }
  try {
    const usage = await readUsage(ctx, event)
    const n = buildNotification({ ...fields, usage, at }, { warn: (m) => logLine(ctx, '-', 'WARNING', m.replace(/^WARNING /, '')), env: ctx.env || {} })
    const t = topicFromFile(ctx.topicFile)
    if (t.code) return fail(t.code)
    const base = serverBase(ctx.ntfyServer)
    if (!base) return fail('bad_server')
    let res
    try {
      res = await fetch(`${base}/${t.topic}`, {
        method: 'POST',
        body: n.body,
        headers: { Title: n.title, Tags: n.tags, Priority: n.priority },
        signal: AbortSignal.timeout(10000),
      })
    } catch (e) {
      const name = (e && (e.name || (e.cause && e.cause.name))) || ''
      return fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network')
    }
    try { await res.text() } catch { /* body drained best-effort */ }
    if (!res.ok) return fail(`http_${res.status}`)
    return { ok: true, code: null }
  } catch {
    return fail('network')
  }
}

// ─── tick (Part A) ───────────────────────────────────────────────────────────
export async function tick(ctx) {
  const armed = armedCampaigns(ctx)
  if (!armed.length) { logLine(ctx, '-', 'not armed'); return 0 }
  if (armed.length > 1) {
    logLine(ctx, '-', 'ERROR', `more than one campaign is armed (${armed.map(a => a.slug).join(', ')}) — disarm all but one`)
    return 1
  }
  const { slug } = armed[0]
  const st = armed[0].state
  const now = ctx.now()
  const S = ctx.session, W = ctx.window
  const finish = (event, detail = '', code = 0) => {
    st.last_tick = `${iso(now)} ${event}${detail ? ` ${detail}` : ''}`
    logLine(ctx, slug, event, detail)
    writeState(ctx, slug, st)
    return code
  }
  // count_failure(why) — the one crash-loop counter (A-12). Returns true when it disarmed.
  const countFailure = async (why) => {
    st.consecutive_failed_relaunches = (st.consecutive_failed_relaunches || 0) + 1
    st.relaunch_judged = true
    logLine(ctx, slug, 'failed relaunch', `(${why}) ${st.consecutive_failed_relaunches}/3`)
    if (st.consecutive_failed_relaunches >= 3) {
      st.armed = false
      st.disarmed_reason = 'crash_loop'
      st.disarmed_at = iso(now)
      logLine(ctx, slug, 'crash_loop', `(${why})`)
      await sendNotification(ctx, { event: 'disarm', campaign: slug, reason: 'crash_loop' }, st)
      return true
    }
    return false
  }

  if (!CAMPAIGN_SLUG_RE.test(slug)) return finish('ERROR', 'armed campaign slug is not ^[a-z0-9][a-z0-9-]*$ — disarm it', 1)
  const mdPath = join(ctx.campaignsDir, slug, 'campaign.md')
  if (!existsSync(mdPath)) return finish('ERROR', `campaign.md missing for the armed campaign — disarm it`, 1)
  const hunts = huntSlugs(readFileSync(mdPath, 'utf8'))
  const newest = newestHeartbeat(ctx.repo, hunts)
  const lr = ms(st.last_relaunch_at)

  // 2. progress bookkeeping (A-12). A heartbeat counts once: it must be newer than the last
  //    relaunch AND than the newest heartbeat an earlier tick already saw.
  const prevSeen = ms(st.last_heartbeat_seen)
  const newHeartbeat = newest != null && (prevSeen == null || newest > prevSeen) && (lr == null || newest > lr)
  if (newest != null && (prevSeen == null || newest > prevSeen)) st.last_heartbeat_seen = iso(newest)
  const pauseProgress = st.last_pause_at != null && lr != null && ms(st.last_pause_at) > lr
  if (newHeartbeat || pauseProgress) {
    st.consecutive_failed_relaunches = 0
    st.stalled_ticks = 0
    st.relaunch_judged = true
    st.stall_notified_for = null
    st.notified_parks = {}
  }

  // 3. runner quota pause
  const du = ms(st.defer_until)
  if (du != null && du > now) return finish('deferred', `until ${st.defer_until} (runner quota pause)`)

  // 4. liveness (A-3, A-11, K6)
  let procs
  try { procs = readProcs(ctx) } catch (e) { return finish('ERROR', e.message, 1) }
  const names = windowNames(ctx)
  const winExists = !!names && names.includes(W)
  const paneList = winExists ? panes(ctx) : []
  const tree = descendants(procs, paneList.filter(p => !p.dead).map(p => p.pid))
  const inpane = [...tree].some(pid => ctx.procRe.test((procs.get(pid) || {}).comm || ''))
  const cutoff = maxMs(ms(st.session_ended_at), lr)
  const promptRe = new RegExp(`(^|\\s)/run-campaign-local\\s+${escRe(slug)}(\\s|$)`)
  let outsidePid = null
  for (const [pid, p] of procs) {
    if (tree.has(pid) || pid === process.pid || !p.args || !promptRe.test(p.args)) continue
    const start = p.etimes == null ? null : now - p.etimes * 1000
    if (cutoff != null && (start == null || start <= cutoff)) continue
    outsidePid = pid
    break
  }
  const sea = ms(st.session_ended_at)
  const ended = sea != null && (lr == null || sea >= lr) && (newest == null || newest <= sea)
  const freshRef = maxMs(newest, lr)
  const fresh = freshRef != null && now - freshRef < ctx.staleMs
  const where = `${S}:${W}`

  if (ended && !outsidePid) {
    st.stalled_ticks = 0
    logLine(ctx, slug, 'runner ended', `(${st.last_verdict || 'unknown'})`)
  } else if (fresh) {
    st.stalled_ticks = 0
    return finish('alive', inpane ? '' : `(fresh heartbeats, no claude in ${where})`)
  } else {
    const evidence = winExists ? limitEvidence(ctx) : false
    if ((inpane || outsidePid) && !evidence) {
      st.stalled_ticks = (st.stalled_ticks || 0) + 1
      const n = st.stalled_ticks
      const tag = `stalled (${n}/${ctx.stallTicks})${!inpane && outsidePid ? ` outside pid ${outsidePid}` : ''}`
      if (n < ctx.stallTicks) return finish(tag)
      st.stalled_ticks = 0
      if (!st.relaunch_judged) {
        if (await countFailure('stalled')) return finish(tag, 'crash_loop')
      }
      if (st.armed) {
        const key = st.last_relaunch_at ?? st.armed_at
        if (st.stall_notified_for !== key) {
          await sendNotification(ctx, { event: 'stalled', campaign: slug, reason: 'stalled' }, st)
          st.stall_notified_for = key
          return finish(tag, 'reported')
        }
        return finish(`stalled (${n}/${ctx.stallTicks}, already reported)`)
      }
      return finish(tag)
    }
    if (outsidePid && evidence) {
      return finish('runner outside', `${where} at the limit (pid ${outsidePid}) — not relaunching`)
    }
    st.stalled_ticks = 0
  }

  // 5. usage gate (A-10: no --tier → the strictest start ceiling)
  const g = run(ctx.node, [ctx.gate, '--json'], { timeout: 120000, env: ctx.env })
  let gj = null
  try {
    const last = g.stdout.split('\n').map(s => s.trim()).filter(Boolean).pop()
    gj = last ? JSON.parse(last) : null
  } catch { gj = null }
  if (!g.error && g.status === 10 && gj && gj.decision === 'defer') {
    return finish('defer', `reset_at=${gj.reset_at || 'unknown'}${gj.degraded ? ' DEGRADED' : ''}`)
  }
  if (g.error || g.status !== 0 || !gj || gj.decision !== 'proceed') {
    return finish('ERROR', `gate unavailable (${ctx.gate}, exit ${g.status ?? 'none'})`, 1)
  }

  // 6. judge the previous relaunch (once)
  if (lr != null && !st.relaunch_judged) {
    if (await countFailure('relaunch')) return finish('disarmed', 'crash_loop')
  }

  // 7. relaunch (AC5)
  if (winExists) {
    const k = tmux(ctx, 'kill-window', '-t', where)
    if (k.error || k.status !== 0) logLine(ctx, slug, 'WARNING', `kill-window ${where} failed (exit ${k.status ?? 'none'})`)
  }
  const prompt = `/run-campaign-local ${slug} --chain --unattended`
  const tail = ['-c', ctx.repo, '-e', `PATH=${ctx.sessionPath}`, '-e', `WOLFPACK_HOME=${ctx.packHome}`,
    '--', ctx.claude, '--permission-mode', ctx.permissionMode, prompt]
  const has = tmux(ctx, 'has-session', '-t', S)
  const spawned = (!has.error && has.status === 0)
    ? tmux(ctx, 'new-window', '-d', '-t', `${S}:`, '-n', W, ...tail)
    : tmux(ctx, 'new-session', '-d', '-s', S, '-n', W, ...tail)
  const after = windowNames(ctx) || []
  const count = after.filter(n => n === W).length
  st.last_relaunch_at = iso(now)
  st.session_ended_at = null
  st.defer_until = null
  st.notified_parks = {}
  st.stalled_ticks = 0
  if (spawned.error || spawned.status !== 0 || count !== 1) {
    logLine(ctx, slug, 'ERROR', `relaunch left ${count} ${where} window(s) (spawn exit ${spawned.status ?? 'none'})`)
    if (await countFailure('window_count')) return finish('disarmed', 'crash_loop')
    return finish('ERROR', 'relaunch failed (window_count)', 1)
  }
  st.relaunch_judged = false
  return finish('relaunched', `${where} (${ctx.permissionMode})`)
}

// ─── human / runner subcommands ──────────────────────────────────────────────
export function arm(ctx, slug) {
  if (!slug || !CAMPAIGN_SLUG_RE.test(slug)) throw new UsageError(`arm needs a campaign slug matching ^[a-z0-9][a-z0-9-]*$ (got ${JSON.stringify(slug || '')})`)
  if (!existsSync(join(ctx.campaignsDir, slug, 'campaign.md'))) {
    throw new UsageError(`no campaign ${slug}: .wolfpack/campaigns/${slug}/campaign.md does not exist in ${ctx.repo}`)
  }
  const others = armedCampaigns(ctx).filter(a => a.slug !== slug)
  if (others.length) {
    ctx.out(`refused: ${others[0].slug} is already armed — one runner per repo; disarm it first`)
    return 3
  }
  writeState(ctx, slug, freshArmedState(ctx.now()))
  logLine(ctx, slug, 'armed')
  ctx.out(`armed ${slug}: the cron resumes it in tmux ${ctx.session}:${ctx.window} and pages on park/finish. A runner you start yourself is safe while its heartbeats are fresh; start it as claude "/run-campaign-local ${slug} --chain" (or in ${ctx.session}:${ctx.window}) so a silent long phase is never duplicated.`)
  return 0
}

export function disarm(ctx, slug, reason = 'manual') {
  if (!CODE_RE.test(reason)) throw new UsageError(`--reason must be a code matching ${CODE_RE}`)
  let target = slug
  if (!target) {
    const a = armedCampaigns(ctx)
    if (!a.length) { ctx.out('nothing armed'); return 0 }
    target = a[0].slug
  }
  if (!CAMPAIGN_SLUG_RE.test(target)) throw new UsageError(`invalid campaign slug ${JSON.stringify(target)}`)
  const st = readState(ctx, target)
  if (!st) { ctx.out(`${target} has no cron state (never armed)`); return 0 }
  st.armed = false
  st.disarmed_reason = reason
  st.disarmed_at = iso(ctx.now())
  writeState(ctx, target, st)
  logLine(ctx, target, 'disarmed', `reason=${reason}`)
  ctx.out(`disarmed ${target} (${reason})`)
  return 0
}

export function status(ctx) {
  const all = listStates(ctx)
  const armed = all.filter(x => x.state.armed)
  ctx.out(armed.length ? `armed: ${armed.map(a => a.slug).join(', ')}` : 'armed: none')
  for (const { slug, state: s } of [...armed, ...all.filter(x => !x.state.armed)]) {
    ctx.out(`campaign ${slug}: ${s.armed ? `armed since ${s.armed_at}` : `disarmed (${s.disarmed_reason || 'never armed'}${s.disarmed_at ? ` at ${s.disarmed_at}` : ''})`}`)
    ctx.out(`  consecutive_failed_relaunches: ${s.consecutive_failed_relaunches}  stalled_ticks: ${s.stalled_ticks}  relaunch_judged: ${s.relaunch_judged}`)
    ctx.out(`  last_relaunch_at: ${s.last_relaunch_at || 'none'}`)
    ctx.out(`  last tick: ${s.last_tick || 'none'}`)
    ctx.out(`  defer_until: ${s.defer_until || 'none'}`)
    ctx.out(`  session_ended_at: ${s.session_ended_at || 'none'}  last_verdict: ${s.last_verdict || 'none'}`)
    const f = s.last_notify_failure
    ctx.out(`  last notify failure: ${f ? `${f.event} ${f.at} ${f.reason}` : 'none'}`)
  }
  ctx.out(`log: ${ctx.log}`)
  return 0
}

// The runner's state notes. Not armed → a logged no-op (A-13).
function armedStateFor(ctx, campaign, what) {
  if (!campaign || !CAMPAIGN_SLUG_RE.test(campaign)) throw new UsageError(`${what} needs --campaign <slug>`)
  const st = readState(ctx, campaign)
  if (!st || st.armed !== true) {
    logLine(ctx, campaign, `not armed: ${what} skipped`)
    ctx.out(`not armed: ${what} skipped`)
    return null
  }
  return st
}

export function notePause(ctx, campaign, resetAt) {
  const t = ms(resetAt)
  if (resetAt == null || t == null) throw new UsageError('note-pause needs --reset-at <ISO time>')
  const st = armedStateFor(ctx, campaign, 'note-pause')
  if (!st) return 0
  const now = iso(ctx.now())
  st.defer_until = iso(t)
  st.last_pause_at = now
  st.session_ended_at = now
  st.last_verdict = 'WAVE_PAUSED_QUOTA'
  writeState(ctx, campaign, st)
  logLine(ctx, campaign, 'note-pause', `defer_until=${st.defer_until}`)
  ctx.out(`ok: pause recorded until ${st.defer_until}`)
  return 0
}

export function noteExit(ctx, campaign, verdict) {
  if (!verdict || !VERDICT_RE.test(verdict)) throw new UsageError('note-exit needs --verdict <token>')
  const st = armedStateFor(ctx, campaign, 'note-exit')
  if (!st) return 0
  st.session_ended_at = iso(ctx.now())
  st.last_verdict = verdict
  writeState(ctx, campaign, st)
  logLine(ctx, campaign, 'note-exit', `verdict=${verdict}`)
  ctx.out(`ok: exit recorded (${verdict})`)
  return 0
}

const EVENTS = { park: null, 'ready-for-release': 'completed', 'waiting-on-you': 'waiting_on_human' }

export async function event(ctx, type, { campaign, hunt, status: st0, reason, 'report-url': reportUrl } = {}) {
  if (!(type in EVENTS)) throw new UsageError(`event must be one of ${Object.keys(EVENTS).join(', ')}`)
  if (type === 'park' && (!hunt || st0 == null)) throw new UsageError('event park needs --hunt <h> and --status <st>')
  if (hunt != null && !SLUG_RE.test(hunt)) throw new UsageError('--hunt must be a hunt slug')
  const st = armedStateFor(ctx, campaign, `event ${type}`)
  if (!st) return 0
  if (type === 'park') {
    if (st.notified_parks[hunt] === st0) {
      logLine(ctx, campaign, 'INFO', `event park ${SLUG_RE.test(hunt) ? hunt : '(hunt)'}: already notified (${CODE_RE.test(st0) ? st0 : '(status)'})`)
      ctx.out('ok: already notified')
      return 0
    }
    const r = await sendNotification(ctx, { event: 'park', campaign, hunt, status: st0, reason, report_url: reportUrl }, st)
    // Dedupe only a page that went out: a failed send stays un-notified, so the next
    // `event park` for this hunt retries it instead of reporting "already notified".
    if (r.ok) st.notified_parks[hunt] = st0
    writeState(ctx, campaign, st)
    logLine(ctx, campaign, 'event park', r.ok ? 'sent' : `FAILED: ${r.code}`)
    ctx.out(r.ok ? 'ok: park notified' : `ok: park notification FAILED: ${r.code}`)
    return 0
  }
  const r = await sendNotification(ctx, { event: type, campaign, status: st0, reason, report_url: reportUrl }, st)
  st.armed = false
  st.disarmed_reason = EVENTS[type]
  st.disarmed_at = iso(ctx.now())
  writeState(ctx, campaign, st)
  logLine(ctx, campaign, `event ${type}`, `${r.ok ? 'sent' : `FAILED: ${r.code}`}; disarmed reason=${EVENTS[type]}`)
  ctx.out(`ok: ${type} ${r.ok ? 'notified' : `notification FAILED: ${r.code}`}; disarmed (${EVENTS[type]})`)
  return 0
}

export async function notifyTest(ctx) {
  const armed = armedCampaigns(ctx)
  const slug = armed.length === 1 ? armed[0].slug : null
  const st = slug ? armed[0].state : null
  const r = await sendNotification(ctx, { event: 'test', campaign: slug }, st)
  if (st) writeState(ctx, slug, st)
  logLine(ctx, slug || '-', 'notify-test', r.ok ? 'sent' : `FAILED: ${r.code}`)
  ctx.out(r.ok ? 'sent' : `FAILED: ${r.code}`)
  return 0
}

// A general-purpose page (a human or an agent wants Cecil's attention outside the runner's own
// events). Armed or not: it is an explicit request. The same token-only body as every other
// notification, so the reason is a code (`step-d-ready`), never free text.
export async function ping(ctx, flags) {
  const reason = flags.reason
  if (!reason || !CODE_RE.test(reason)) throw new UsageError('usage: ping --reason <code> [--campaign <s>] [--hunt <h>] (code: a-z 0-9 _ : . -, at most 64)')
  for (const k of ['campaign', 'hunt']) {
    if (flags[k] != null && !SLUG_RE.test(flags[k])) throw new UsageError(`ping: --${k} must be a slug`)
  }
  const r = await sendNotification(ctx, { event: 'ping', campaign: flags.campaign, hunt: flags.hunt, reason })
  logLine(ctx, flags.campaign || '-', `ping ${reason}`, r.ok ? 'sent' : `FAILED: ${r.code}`)
  ctx.out(r.ok ? 'sent' : `FAILED: ${r.code}`)
  return 0
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function parseFlags(argv, allowed) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (!allowed.includes(k)) throw new UsageError(`unknown flag ${a}`)
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`)
      flags[k] = argv[++i]
    } else pos.push(a)
  }
  return { pos, flags }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0]
  const rest = argv.slice(1)
  let ctx
  try { ctx = loadContext(env) } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`)
    if (env.WOLFPACK_CRON_LOG) {
      try { appendFileSync(env.WOLFPACK_CRON_LOG, `${new Date().toISOString()} - config_error ${e.message}\n`) } catch { /* stderr above */ }
    }
    return e instanceof ConfigError ? 4 : 1
  }
  try {
    switch (cmd) {
      case 'tick': if (rest.length) throw new UsageError('tick takes no arguments'); return await tick(ctx)
      case 'arm': { const { pos } = parseFlags(rest, []); if (pos.length !== 1) throw new UsageError('usage: arm <slug>'); return arm(ctx, pos[0]) }
      case 'disarm': { const { pos, flags } = parseFlags(rest, ['reason']); if (pos.length > 1) throw new UsageError('usage: disarm [<slug>] [--reason <code>]'); return disarm(ctx, pos[0], flags.reason || 'manual') }
      case 'status': if (rest.length) throw new UsageError('status takes no arguments'); return status(ctx)
      case 'note-pause': { const { pos, flags } = parseFlags(rest, ['campaign', 'reset-at']); if (pos.length) throw new UsageError('usage: note-pause --campaign <s> --reset-at <iso>'); return notePause(ctx, flags.campaign, flags['reset-at']) }
      case 'note-exit': { const { pos, flags } = parseFlags(rest, ['campaign', 'verdict']); if (pos.length) throw new UsageError('usage: note-exit --campaign <s> --verdict <token>'); return noteExit(ctx, flags.campaign, flags.verdict) }
      case 'event': {
        const { pos, flags } = parseFlags(rest, ['campaign', 'hunt', 'status', 'reason', 'report-url'])
        if (pos.length !== 1) throw new UsageError('usage: event <park|ready-for-release|waiting-on-you> --campaign <s> [--hunt <h>] [--status <st>] [--reason <code>] [--report-url <url>]')
        return await event(ctx, pos[0], flags)
      }
      case 'notify-test': if (rest.length) throw new UsageError('notify-test takes no arguments'); return await notifyTest(ctx)
      case 'ping': {
        const { pos, flags } = parseFlags(rest, ['reason', 'campaign', 'hunt'])
        if (pos.length) throw new UsageError('usage: ping --reason <code> [--campaign <s>] [--hunt <h>]')
        return await ping(ctx, flags)
      }
      default: throw new UsageError(`unknown command ${JSON.stringify(cmd || '')}`)
    }
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`ERROR: ${e.message}\n`); return 2 }
    if (e instanceof ConfigError) { logLine(ctx, '-', 'config_error', e.message); process.stderr.write(`ERROR: ${e.message}\n`); return 4 }
    logLine(ctx, '-', 'ERROR', `${cmd}: ${e.message}`)
    process.stderr.write(`ERROR: ${e.message}\n`)
    return 1
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('wolfpack-cron-resume.mjs')
if (invokedDirectly) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`ERROR: ${e && e.message}\n`); process.exit(1) })
}
