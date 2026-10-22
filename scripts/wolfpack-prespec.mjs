#!/usr/bin/env node
// scripts/wolfpack-prespec.mjs — deterministic core of the campaign pre-spec sweep.
//
// The /run-campaign-local Step 1.5 sweep shells out to this so hunt selection,
// the decisions-table write and the acceptance lint are unit-tested rather than
// re-derived by an LLM each run.
//
// Run: node scripts/wolfpack-prespec.mjs <list|record-decision|lint> ...
//   list <campaign.md> [--wave] [--root <dir>]
//       → JSON { campaign, root, mode, resume_wave, selected[], skipped[] }
//   record-decision <plan.md> --hunt <slug> --question <text> --answer <text> [--date YYYY-MM-DD]
//       → appends the next D<n> row to the plan's decisions table (idempotent)
//   lint <acceptance.md> [--max-manual=N]
//       → checks the criteria the release/smoke parser reads
// Exit codes: 0 ok · 1 failed check/refusal · 2 usage/IO.
//
// Worktree dirs probed for a hunt's plan: .claude/worktrees, .agents/worktrees.
// Run tests: node --test scripts/wolfpack-prespec.test.mjs

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { parseAcceptanceCriteria, CriteriaError, DEFAULT_SMOKE_TENANTS } from './wolfpack-release.mjs'

export class PrespecError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PrespecError'
  }
}

// Mirrors the campaign runner's status rules.
const DONE_STATUSES = ['merged', 'certified', 'certified_not_merged']

// ─── Campaign parse ───────────────────────────────────────────────
export function parseCampaignHunts(md) {
  const lines = String(md || '').split('\n')
  const start = lines.findIndex((l) => /^##\s+Proposed Hunts/.test(l))
  if (start === -1) throw new PrespecError('campaign has no "## Proposed Hunts" section')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  const hunts = []
  let cur = null
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]
    const h = line.match(/^###\s+\d+\.\s+([A-Za-z0-9][A-Za-z0-9-]*)\s*$/)
    if (h) {
      cur = { slug: h[1], waveRaw: null, trigger: '', order: hunts.length }
      hunts.push(cur)
      continue
    }
    if (!cur) continue
    const w = line.match(/^\s*-\s+\*\*Wave:\*\*\s*(.*\S)\s*$/)
    if (w && cur.waveRaw === null) cur.waveRaw = w[1]
    const t = line.match(/^\s*-\s+\*\*Trigger:\*\*\s*(.*\S)\s*$/)
    if (t && !cur.trigger) cur.trigger = t[1]
  }
  if (hunts.length === 0) throw new PrespecError('campaign "Proposed Hunts" lists no hunts')
  const out = []
  for (const h of hunts) {
    const raw = h.waveRaw === null ? '' : h.waveRaw
    if (/^blocked/i.test(raw.replace(/[*`_\s]/g, ''))) continue
    const m = raw.match(/^\**\s*(\d+)/)
    if (!m) throw new PrespecError(`hunt ${h.slug}: unreadable Wave '${raw}'`)
    out.push({ slug: h.slug, wave: parseInt(m[1], 10), trigger: h.trigger, order: h.order })
  }
  out.sort((a, b) => a.wave - b.wave || a.order - b.order)
  return out
}

// ─── Hunt state ───────────────────────────────────────────────────
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new PrespecError(`cannot read ${file}: ${e.message}`)
  }
}

export function resolveHuntState(root, slug) {
  const cands = [
    { source: 'worktree', dir: join(root, '.claude', 'worktrees', slug, '.wolfpack', 'plans', slug) },
    { source: 'worktree', dir: join(root, '.agents', 'worktrees', slug, '.wolfpack', 'plans', slug) },
    { source: 'main', dir: join(root, '.wolfpack', 'plans', slug) },
  ]
  const hit = cands.find((c) => existsSync(join(c.dir, 'metadata.json')))
  if (!hit) {
    return {
      slug,
      planDir: cands[0].dir,
      source: 'none',
      status: null,
      hasAcceptance: false,
      hasRecordedAnswers: false,
      hasPlanArtifacts: false,
    }
  }
  const meta = readJson(join(hit.dir, 'metadata.json'))
  const status = meta && typeof meta.status === 'string' ? meta.status : null
  const accPath = join(hit.dir, 'acceptance.md')
  const hasAcceptance = existsSync(accPath)
  let hasRecordedAnswers = false
  if (hasAcceptance) {
    const acc = readFileSync(accPath, 'utf8')
    hasRecordedAnswers =
      /^\s*-\s*Interview answers\b/m.test(acc) || (meta && meta.spec && meta.spec.ambiguity_open === false)
  }
  let files = []
  try {
    files = readdirSync(hit.dir)
  } catch {
    files = []
  }
  const hasPlanArtifacts = files.some((f) => /^(plan\.md|plan-final\.md|plan-revised-.*\.md|review-.*\.md)$/.test(f))
  return { slug, planDir: hit.dir, source: hit.source, status, hasAcceptance, hasRecordedAnswers, hasPlanArtifacts }
}

export function classifyForPrespec(state) {
  const s = state.status
  if (DONE_STATUSES.includes(s)) return { select: false, reason: 'done', redraft: false }
  if (s === 'needs_spec') {
    return {
      select: true,
      reason: state.hasRecordedAnswers ? 'needs_spec (answers recorded — not re-drafted)' : 'needs_spec',
      redraft: !state.hasRecordedAnswers,
    }
  }
  if (typeof s === 'string' && s.startsWith('parked:')) {
    return { select: false, reason: 'parked (past Spec — /resolve)', redraft: false }
  }
  if (state.hasAcceptance) return { select: false, reason: 'has acceptance.md', redraft: false }
  if (state.hasPlanArtifacts) return { select: false, reason: 'past Spec', redraft: false }
  if (state.source === 'none') return { select: true, reason: 'not scaffolded', redraft: true }
  if (s === 'ready_for_alpha') return { select: true, reason: 'no acceptance.md', redraft: true }
  return { select: false, reason: `past Spec (${s})`, redraft: false }
}

export function resumeWave(entries) {
  let best = null
  for (const e of entries) {
    if (DONE_STATUSES.includes(e.status)) continue
    if (best === null || e.wave < best) best = e.wave
  }
  return best
}

// ─── Source plan lookup ───────────────────────────────────────────
export function findSpecPlan(trigger, campaignMd, root) {
  const t = String(trigger || '').match(/\bSpec:\s*`?([^\s`"'§,;]+\.md)/)
  if (t) {
    const p = resolve(root, t[1])
    if (existsSync(p)) return { path: p, from: 'trigger' }
    return { path: null, note: `Trigger names ${t[1]} but it does not exist` }
  }
  const c = String(campaignMd || '').match(/^\s*(?:-\s*)?\**Plan:\**\s*`?([^\s`]+\.md)/m)
  if (c) {
    const p = resolve(root, c[1])
    if (existsSync(p)) return { path: p, from: 'campaign' }
    return { path: null, note: `Campaign names ${c[1]} but it does not exist` }
  }
  return { path: null, note: 'no source plan named (answers in acceptance.md only)' }
}

export function selectHunts(campaignPath, { wave = false, root } = {}) {
  const campaignAbs = resolve(campaignPath)
  const md = readFileSync(campaignAbs, 'utf8')
  let r = root
  if (!r) {
    const slugDir = dirname(campaignAbs)
    const campaignsDir = dirname(slugDir)
    r =
      basename(campaignAbs) === 'campaign.md' && basename(campaignsDir) === 'campaigns' && basename(dirname(campaignsDir)) === '.wolfpack'
        ? resolve(campaignsDir, '..', '..')
        : process.cwd()
  }
  r = resolve(r)
  const hunts = parseCampaignHunts(md)
  const entries = hunts.map((h) => {
    const st = resolveHuntState(r, h.slug)
    const cls = classifyForPrespec(st)
    const sp = findSpecPlan(h.trigger, md, r)
    const e = {
      slug: h.slug,
      wave: h.wave,
      status: st.status,
      source: st.source,
      plan_dir: st.planDir,
      reason: cls.reason,
      spec_plan: sp.path,
      spec_plan_from: sp.path ? sp.from : null,
      spec_plan_note: sp.path ? null : sp.note,
    }
    return { e, cls }
  })
  const rw = resumeWave(entries.map((x) => x.e))
  const selected = []
  const skipped = []
  for (const { e, cls } of entries) {
    if (wave && e.wave !== rw) continue
    if (cls.select) selected.push({ ...e, redraft: cls.redraft })
    else skipped.push(e)
  }
  return {
    campaign: campaignAbs,
    root: r,
    mode: wave ? 'wave' : 'all',
    resume_wave: rw,
    selected,
    skipped,
  }
}

// ─── Decisions table ──────────────────────────────────────────────
export function findDecisionsTable(lines) {
  const found = []
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\|\s*#\s*\|\s*Decision\s*\|/i.test(lines[i]) && /^\|\s*:?-{3,}/.test(lines[i + 1])) {
      let last = i + 1
      for (let j = i + 2; j < lines.length && /^\|/.test(lines[j]); j++) last = j
      const cols = lines[i].replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).length
      found.push({ headerIdx: i, sepIdx: i + 1, lastRowIdx: last, cols })
    }
  }
  if (found.length === 0) throw new PrespecError('no recognisable decisions table ("| # | Decision |" header + separator)')
  if (found.length > 1) throw new PrespecError(`ambiguous: ${found.length} decisions tables`)
  return found[0]
}

function cell(s) {
  return String(s).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

function normKey(s) {
  return String(s).replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim().toLowerCase()
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())
}

export function recordDecision(md, { question, answer, hunt, date } = {}) {
  const q = question == null ? '' : String(question).trim()
  const a = answer == null ? '' : String(answer).trim()
  const h = hunt == null ? '' : String(hunt).trim()
  if (!q) throw new PrespecError('question is empty')
  if (!a) throw new PrespecError('answer is empty')
  if (!h) throw new PrespecError('hunt is empty')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new PrespecError(`date must be YYYY-MM-DD (got '${date}')`)
  const lines = String(md).split('\n')
  const tbl = findDecisionsTable(lines)
  let maxN = 0
  const nq = normKey(q)
  const na = normKey(a)
  for (let i = tbl.sepIdx + 1; i <= tbl.lastRowIdx; i++) {
    const cells = splitRow(lines[i])
    const m = (cells[0] || '').match(/^D(\d+)$/)
    if (!m) continue
    const n = parseInt(m[1], 10)
    if (n > maxN) maxN = n
    if (normKey(cells[1] || '') === nq) {
      if (normKey(cells[2] || '').includes(na)) return { md: String(md), id: cells[0], action: 'exists' }
      throw new PrespecError(`${cells[0]} already decides this question with a different answer — not overwriting`)
    }
  }
  const id = `D${maxN + 1}`
  let row = `| ${id} | ${cell(q)} | **Decided ${date}** (pre-spec sweep, ${cell(h)}): ${cell(a)} |`
  for (let c = 3; c < tbl.cols; c++) row += '  |'
  lines.splice(tbl.lastRowIdx + 1, 0, row)
  return { md: lines.join('\n'), id, action: 'added' }
}

// ─── Acceptance lint ──────────────────────────────────────────────
// `tenants`: the allowed `[tenant:<name>]` scope names (plus `both`); default surgical,mobile.
export function lintAcceptance(md, { maxManual = 2, tenants = DEFAULT_SMOKE_TENANTS } = {}) {
  const text = String(md || '')
  const errors = []
  // Parse line by line so one bad tenant scope reports itself and the rest still lint.
  const crit = []
  for (const line of text.split('\n')) {
    try {
      crit.push(...parseAcceptanceCriteria(line, 'lint', { tenants }))
    } catch (e) {
      if (!(e instanceof CriteriaError)) throw e
      const m = /^lint\/(\d+): (.*)$/.exec(e.message)
      errors.push({ id: m ? `AC${m[1]}` : null, message: m ? `AC${m[1]}: ${m[2]}` : e.message })
    }
  }
  const counts = { auto: 0, manual: 0, compliance: 0 }
  for (const c of crit) counts[c.tag]++
  if (crit.length === 0) errors.push({ id: null, message: 'no acceptance criteria parse (- AC<n> [auto|manual|compliance] <text>)' })

  const seen = new Set()
  const dup = new Set()
  for (const c of crit) {
    if (seen.has(c.id)) {
      if (!dup.has(c.id)) {
        dup.add(c.id)
        errors.push({ id: c.id, message: `${c.id}: duplicate id` })
      }
    }
    seen.add(c.id)
  }
  if (counts.manual > maxManual) {
    const ids = crit.filter((c) => c.tag === 'manual').map((c) => c.id)
    errors.push({ id: null, message: `${counts.manual} [manual] criteria (max ${maxManual}): ${ids.join(', ')} — automate or re-scope` })
  }

  const lines = text.split('\n')
  const parsedRe = /^\s*-\s+(AC\d+)\s+\[(auto|manual|compliance)\](?:\s+\[tenant:[^\]\s]*\])?\s+(.*\S)\s*$/i
  const scopeErr = new Set(errors.map((e) => e.id).filter(Boolean))
  let inSection = false
  for (const line of lines) {
    if (/^##\s/.test(line)) inSection = /^##\s+Acceptance criteria/i.test(line)
    const idm = line.match(/^\s*-\s+(AC\d+)\b/)
    if (inSection) {
      if (idm && !parsedRe.test(line) && !scopeErr.has(idm[1].toUpperCase())) {
        errors.push({
          id: idm[1],
          message: `${idm[1]}: not parsed (tag must be [auto], [manual] or [compliance], followed by text) — release/smoke would drop it`,
        })
      }
    } else {
      const m = line.match(/^\s*-\s+(AC\d+)\s+\[([^\]]*)\]/)
      if (m && !['auto', 'manual', 'compliance'].includes(m[2].toLowerCase())) {
        errors.push({
          id: m[1],
          message: `${m[1]}: not parsed (tag must be [auto], [manual] or [compliance], followed by text) — release/smoke would drop it`,
        })
      }
    }
  }
  return { ok: errors.length === 0, errors, counts }
}

// ─── CLI ──────────────────────────────────────────────────────────
const USAGE = `usage:
  wolfpack-prespec.mjs list <campaign.md> [--wave] [--root <dir>]
  wolfpack-prespec.mjs record-decision <plan.md> --hunt <slug> --question <text> --answer <text> [--date YYYY-MM-DD]
  wolfpack-prespec.mjs lint <acceptance.md> [--max-manual=N] [--tenants a,b]`

function parseFlags(args) {
  const pos = []
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (a === '--wave') flags.wave = true
      else {
        flags[a.slice(2)] = args[i + 1]
        i++
      }
    } else pos.push(a)
  }
  return { pos, flags }
}

export function main(argv) {
  const [cmd, ...rest] = argv
  const { pos, flags } = parseFlags(rest)
  try {
    if (cmd === 'list') {
      if (pos.length !== 1) {
        console.error(USAGE)
        return 2
      }
      if (flags.wave !== undefined && flags.wave !== true && flags.wave !== 'true') {
        console.error(`--wave takes no value (got --wave=${flags.wave})`)
        console.error(USAGE)
        return 2
      }
      const out = selectHunts(pos[0], { wave: flags.wave !== undefined, root: flags.root })
      console.log(JSON.stringify(out, null, 2))
      return 0
    }
    if (cmd === 'record-decision') {
      if (pos.length !== 1 || !flags.hunt || !flags.question || !flags.answer) {
        console.error(USAGE)
        return 2
      }
      const plan = pos[0]
      const md = readFileSync(plan, 'utf8')
      const date = flags.date || new Date().toLocaleDateString('en-CA')
      const r = recordDecision(md, { question: flags.question, answer: flags.answer, hunt: flags.hunt, date })
      if (r.action === 'added') {
        const tmp = `${plan}.prespec-tmp`
        writeFileSync(tmp, r.md)
        renameSync(tmp, plan)
        console.log(`${r.id} added to ${plan}`)
      } else {
        console.log(`${r.id} already recorded — unchanged`)
      }
      return 0
    }
    if (cmd === 'lint') {
      if (pos.length !== 1) {
        console.error(USAGE)
        return 2
      }
      const raw = flags['max-manual'] !== undefined ? flags['max-manual'] : process.env.WOLFPACK_MAX_MANUAL
      let maxManual = 2
      if (raw !== undefined && raw !== '') {
        if (!/^\d+$/.test(String(raw))) {
          console.error(`wolfpack-prespec: invalid manual budget '${raw}'`)
          return 2
        }
        maxManual = parseInt(raw, 10)
      }
      const file = pos[0]
      let tenants = DEFAULT_SMOKE_TENANTS
      if (flags.tenants !== undefined) {
        tenants = String(flags.tenants).split(',').map((t) => t.trim()).filter(Boolean)
        if (!tenants.length || tenants.some((t) => !/^[a-z][a-z0-9-]*$/.test(t))) {
          console.error(`wolfpack-prespec: invalid --tenants '${flags.tenants}'`)
          return 2
        }
      }
      const res = lintAcceptance(readFileSync(file, 'utf8'), { maxManual, tenants })
      if (res.ok) {
        const n = res.counts.auto + res.counts.manual + res.counts.compliance
        console.log(`OK ${file}: ${n} criteria (${res.counts.auto} auto, ${res.counts.manual} manual, ${res.counts.compliance} compliance)`)
        return 0
      }
      for (const e of res.errors) console.log(`${file}: ${e.message}`)
      return 1
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.error(`wolfpack-prespec: ${e.message}`)
      return 2
    }
    console.error(`wolfpack-prespec: ${e.message}`)
    return 1
  }
  console.error(USAGE)
  return 2
}

if (process.argv[1] && process.argv[1].endsWith('wolfpack-prespec.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
