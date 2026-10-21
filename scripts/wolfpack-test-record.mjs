#!/usr/bin/env node
// scripts/wolfpack-test-record.mjs — the pipeline's SHA-STAMPED full-suite test record.
//
// WHY: agent-reported test results drift from what the committed code does (a Tracker logged
// "all passed" while the committed suite failed; a certify commit's own pedigree row broke a
// test that was green at the Tracker's HEAD). This script runs the project's test command ONCE
// at an exact commit and writes, with no agent prose in between:
//   <record dir>/test-record-<stage>.json   { schema:1, stage, commit, head, ref, ran_in, dirty,
//       command, config, verdict_command, exit, timed_out, summary, verdict_exit,
//       verdict_summary, pass, reason, log, log_sha256, started_at, finished_at, duration_ms }
//   <record dir>/test-record-<stage>.log    the raw, interleaved stdout+stderr of the run
// Stages: tracker (after Tracker), final (after the certify commit), release (campaign tip).
// Watchdog, /merge, /merge-wave, /release-campaign and hunt-pipeline.js reuse a record whose
// commit equals the target and re-run only when it moved.
//
// TRUST ANCHOR: the test command (and the optional verdict command) come from the MAIN
// checkout's wolfpack-config.md (mainWorktree() of --repo), never the hunt worktree's copy, so a
// hunt branch cannot rewrite its own test command to `true`. The workflow cross-checks the
// recorded command against its own config and fails closed on a mismatch. The workflow reaches
// this script only through a relay agent that returns its stdout verbatim.
//
// VERDICT: `pass` is `exit === 0`, unless wolfpack-config.md → Project Identity → Test verdict
// command is set: then `pass` is that command's exit === 0 ({log}, {exit}, {main} placeholders;
// paths substituted shell-quoted) — for suites that exit non-zero on documented baseline
// failures by design. The record keeps the raw `exit` either way.
//
// RUN LOCATION: --repo when its HEAD is the target commit and it has no tracked changes;
// otherwise a scratch detached worktree at the target (removed afterwards), so the record
// always reflects the COMMIT, never an uncommitted edit.
//
// CLI (JSON on stdout with --json; human lines on stderr):
//   run    --stage S --record-dir D [--repo R] [--rev REV] [--config PATH] [--timeout-min N] [--json]
//   ensure (same flags)  reuse a pass/fail record at the target commit + command; else run
//   check  --stage S --record-dir D [--rev REV] [--repo R] [--json]   never runs
//   gate   (same flags as check)  check; a STALE record (tip moved) is re-run once, then re-checked
// Exit codes: run/ensure 0 = pass, 2 = fail; check/gate 0 = allow, 2 = refuse (prints the fix
// line); 1 = infrastructure error (no record written).
// Env: WOLFPACK_TEST_RECORD_TIMEOUT_MIN (default 90; must be > 0) when --timeout-min is absent.
//
// Run tests: node --test scripts/wolfpack-test-record.test.mjs

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, mainWorktree } from './wolfpack-config.mjs'

export const STAGES = Object.freeze(['tracker', 'final', 'release'])
const SHA_RE = /^[0-9a-f]{40}$/
const SUMMARY_RE = /\b(pass(ed|es)?|fail(ed|ures?|s)?|ok|errors?|tests?|skipped)\b/i
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

class InfraError extends Error {}

// The suite's own summary line: the LAST non-empty line that reads like a test summary, else
// the last non-empty line, else '(no output)'.
export function summaryLine(output) {
  const lines = String(output ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length) return '(no output)'
  for (let i = lines.length - 1; i >= 0; i--) if (SUMMARY_RE.test(lines[i])) return lines[i]
  return lines[lines.length - 1]
}

export function recordPaths(dir, stage) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage ${JSON.stringify(stage)} — expected one of ${STAGES.join(', ')}`)
  const d = resolve(dir)
  return { json: join(d, `test-record-${stage}.json`), log: join(d, `test-record-${stage}.log`) }
}

// {log} / {main} → shell-quoted paths; {exit} → the integer.
export function substituteVerdict(cmd, { log, exit, main }) {
  return String(cmd)
    .replace(/\{log\}/g, () => shq(log))
    .replace(/\{main\}/g, () => shq(main))
    .replace(/\{exit\}/g, () => String(Math.trunc(Number(exit))))
}

// Judge an existing record against the target → { state, ok, reason }.
//   missing | invalid | stale (commit / command / verdict command differ) | fail | pass
export function checkRecord(record, { sha, command, verdictCommand, stage } = {}) {
  const out = (state, reason) => ({ state, ok: state === 'pass', reason })
  if (record == null) return out('missing', 'no test record')
  if (typeof record !== 'object' || Array.isArray(record)) return out('invalid', 'the record is not a JSON object')
  if (record.schema !== 1) return out('invalid', `unknown record schema ${JSON.stringify(record.schema ?? null)}`)
  if (typeof record.commit !== 'string' || !SHA_RE.test(record.commit)) return out('invalid', 'the record commit is not a 40-hex SHA')
  if (!Number.isInteger(record.exit)) return out('invalid', 'the record exit is not an integer')
  if (typeof record.pass !== 'boolean') return out('invalid', 'the record pass is not a boolean')
  if (stage && record.stage !== stage) return out('invalid', `the record stage ${JSON.stringify(record.stage ?? null)} is not ${stage}`)
  if (record.commit !== sha) return out('stale', `the record is for ${record.commit.slice(0, 12)}, the target is ${String(sha).slice(0, 12)}`)
  if (record.command !== command) return out('stale', `the record ran ${JSON.stringify(record.command ?? null)}, the configured test command is ${JSON.stringify(command ?? null)}`)
  if ((record.verdict_command ?? null) !== (verdictCommand ?? null)) return out('stale', 'the record verdict command differs from the configured one')
  if (record.pass === false) return out('fail', record.reason || `suite exit ${record.exit}`)
  return out('pass', null)
}

// The exact command that (re-)takes a record.
export function fixLine({ stage, recordDir, rev, repo, pack }) {
  const script = join(pack, 'scripts', 'wolfpack-test-record.mjs')
  return `node ${shq(script)} ensure --stage ${stage} --record-dir ${shq(recordDir)} --rev ${shq(rev)}${repo ? ` --repo ${shq(repo)}` : ''}`
}

// ─── host I/O ────────────────────────────────────────────────────────────────
const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function git(cwd, args, { allowFail = false, raw = false } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0 && !allowFail) throw new InfraError(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout || '').trim()}`)
  return r.status === 0 ? (raw ? r.stdout : r.stdout.trim()) : null
}

const resolveSha = (repo, rev) => git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true })

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const o = { cmd, json: false }
  const takes = { '--stage': 'stage', '--record-dir': 'recordDir', '--repo': 'repo', '--rev': 'rev', '--config': 'config', '--timeout-min': 'timeoutMin' }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--json') { o.json = true; continue }
    if (takes[a]) {
      if (i + 1 >= rest.length) throw new InfraError(`${a} needs a value`)
      o[takes[a]] = rest[++i]
      continue
    }
    throw new InfraError(`unknown argument ${a}`)
  }
  if (!['run', 'ensure', 'check', 'gate'].includes(cmd)) throw new InfraError('usage: wolfpack-test-record.mjs run|ensure|check|gate --stage S --record-dir D [--repo R] [--rev REV] [--config PATH] [--timeout-min N] [--json]')
  if (!STAGES.includes(o.stage)) throw new InfraError(`--stage must be one of ${STAGES.join(', ')}`)
  if (!o.recordDir) throw new InfraError('--record-dir is required')
  return o
}

function timeoutMs(o, env = process.env) {
  const raw = o.timeoutMin ?? env.WOLFPACK_TEST_RECORD_TIMEOUT_MIN
  if (raw == null || String(raw).trim() === '') return 90 * 60 * 1000
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new InfraError(`test-record timeout ${JSON.stringify(raw)} is invalid — expected minutes > 0 (--timeout-min / WOLFPACK_TEST_RECORD_TIMEOUT_MIN)`)
  return Math.max(1, Math.round(n * 60 * 1000))
}

// The trusted context: target commit, main checkout, config (from the MAIN checkout).
function context(o) {
  const repo = resolve(o.repo || process.cwd())
  const main = mainWorktree(repo)
  if (!main) throw new InfraError(`${repo} is not inside a git repository`)
  const configPath = resolve(o.config || join(main, 'wolfpack-config.md'))
  let cfg
  try { cfg = loadConfig(configPath) } catch (e) { throw new InfraError(e.message) }
  if (typeof cfg.testCommand !== 'string' || !cfg.testCommand) throw new InfraError(`${configPath} has no Project Identity → Test command`)
  const rev = o.rev || 'HEAD'
  const sha = resolveSha(repo, rev)
  if (!sha) throw new InfraError(`cannot resolve ${rev} to a commit in ${repo}`)
  const paths = recordPaths(o.recordDir, o.stage)
  return { repo, main, configPath, cfg, rev, sha, paths, command: cfg.testCommand, verdictCommand: cfg.testVerdictCommand ?? null }
}

function readRecord(path) {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return { unparseable: true } }
}

// Run `script` under bash in its own process group, stdout+stderr into logPath; kills the whole
// group on timeout. → { exit, timedOut }
function runSuite(script, cwd, logPath, ms) {
  return new Promise((done, fail) => {
    const fd = openSync(logPath, 'w')
    let child
    try {
      child = spawn('bash', ['-c', `exec 2>&1 </dev/null\n${script}`], { cwd, detached: true, stdio: ['ignore', fd, fd] })
    } catch (e) { closeSync(fd); fail(new InfraError(`cannot start bash: ${e.message}`)); return }
    let timedOut = false
    const kill = (sig) => { try { process.kill(-child.pid, sig) } catch { /* gone */ } }
    const t = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 10000).unref() }, ms)
    child.on('error', (e) => { clearTimeout(t); closeSync(fd); fail(new InfraError(`cannot run the test command: ${e.message}`)) })
    child.on('exit', (code, signal) => {
      clearTimeout(t)
      kill('SIGKILL')   // reap any straggler the suite left in its group
      closeSync(fd)
      done({ exit: timedOut ? 124 : (code ?? (signal ? 128 : 1)), timedOut })
    })
  })
}

function linkWorktree(main, dir, links) {
  for (const l of links || []) {
    const src = join(main, l)
    const dst = join(dir, l)
    if (!existsSync(src) || existsSync(dst)) continue
    mkdirSync(dirname(dst), { recursive: true })
    symlinkSync(src, dst)
  }
}

async function takeRecord(o, c) {
  const ms = timeoutMs(o)
  const repoHead = resolveSha(c.repo, 'HEAD')
  const dirty = (git(c.repo, ['status', '--porcelain', '--untracked-files=no'], { raw: true }) || '')
    .split('\n').filter(Boolean).map(l => l.slice(3))
  const inRepo = repoHead === c.sha && dirty.length === 0
  let cwd = c.repo
  let scratch = null
  mkdirSync(dirname(c.paths.json), { recursive: true })
  const partial = `${c.paths.log}.partial`
  const startedMs = Date.now()
  let run
  try {
    if (!inRepo) {
      scratch = mkdtempSync(join(tmpdir(), 'wolfpack-test-record-'))
      git(c.repo, ['worktree', 'add', '--detach', scratch, c.sha])
      linkWorktree(c.main, scratch, c.cfg.worktreeLinks)
      cwd = scratch
    }
    process.stderr.write(`wolfpack-test-record: running ${c.command} at ${c.sha.slice(0, 12)} in ${inRepo ? 'the repo' : 'a scratch worktree'}\n`)
    run = await runSuite(c.command, cwd, partial, ms)
    const after = resolveSha(c.repo, c.rev)
    if (after !== c.sha) {
      try { unlinkSync(partial) } catch { /* already gone */ }
      throw new InfraError(`HEAD moved during the run (${c.rev}: ${c.sha.slice(0, 12)} → ${String(after).slice(0, 12)}) — no record written`)
    }
    renameSync(partial, c.paths.log)
    const logText = readFileSync(c.paths.log)
    const summary = summaryLine(logText.toString('utf8'))
    let verdictExit = null
    let verdictSummary = null
    let pass = run.exit === 0 && !run.timedOut
    let reason = run.timedOut ? `timed out after ${Math.round(ms / 60000 * 100) / 100} min` : (run.exit === 0 ? null : `suite exit ${run.exit}`)
    if (c.verdictCommand && !run.timedOut) {
      const v = spawnSync('bash', ['-c', `exec 2>&1 </dev/null\n${substituteVerdict(c.verdictCommand, { log: c.paths.log, exit: run.exit, main: c.main })}`],
        { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 })
      verdictExit = v.status ?? 1
      verdictSummary = summaryLine(`${v.stdout || ''}${v.error ? `\n${v.error.message}` : ''}`)
      pass = verdictExit === 0
      reason = pass ? null : `verdict command exit ${verdictExit}`
    }
    const finishedMs = Date.now()
    const record = {
      schema: 1, stage: o.stage, commit: c.sha, head: after, ref: c.rev,
      ran_in: inRepo ? 'repo' : 'scratch', dirty,
      command: c.command, config: c.configPath, verdict_command: c.verdictCommand,
      exit: run.exit, timed_out: run.timedOut, summary,
      verdict_exit: verdictExit, verdict_summary: verdictSummary,
      pass, reason, log: c.paths.log, log_sha256: createHash('sha256').update(logText).digest('hex'),
      started_at: new Date(startedMs).toISOString(), finished_at: new Date(finishedMs).toISOString(),
      duration_ms: finishedMs - startedMs,
    }
    const tmp = `${c.paths.json}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
    renameSync(tmp, c.paths.json)
    return record
  } finally {
    try { if (existsSync(partial)) unlinkSync(partial) } catch { /* best effort */ }
    if (scratch) {
      git(c.repo, ['worktree', 'remove', '--force', scratch], { allowFail: true })
      git(c.repo, ['worktree', 'prune'], { allowFail: true })
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

function emit(o, obj, human) {
  if (human) process.stderr.write(`${human}\n`)
  if (o.json) process.stdout.write(`${JSON.stringify(obj)}\n`)
  else if (!human) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`)
}

const recordLine = (r, reused) => `wolfpack-test-record: ${r.stage} ${r.commit.slice(0, 12)} ${r.pass ? 'PASS' : 'FAIL'} — ${r.summary} [${reused ? 'reused' : `ran in ${r.ran_in}`}] log ${r.log}`

export async function main(argv) {
  let o = { json: argv.includes('--json') }
  try {
    o = parseArgs(argv)
    const c = context(o)
    const fix = fixLine({ stage: o.stage, recordDir: resolve(o.recordDir), rev: o.rev || 'HEAD', repo: o.repo ? resolve(o.repo) : null, pack: PACK_ROOT })
    const judge = () => {
      const rec = readRecord(c.paths.json)
      return { rec, ...checkRecord(rec && rec.unparseable ? { unparseable: true } : rec, { sha: c.sha, command: c.command, verdictCommand: c.verdictCommand, stage: o.stage }) }
    }
    if (o.cmd === 'run' || o.cmd === 'ensure') {
      if (o.cmd === 'ensure') {
        const j = judge()
        if (j.state === 'pass' || j.state === 'fail') {
          emit(o, { ...j.rec, reused: true }, recordLine(j.rec, true))
          return j.rec.pass ? 0 : 2
        }
      }
      const rec = await takeRecord(o, c)
      emit(o, { ...rec, reused: false }, recordLine(rec, false))
      return rec.pass ? 0 : 2
    }
    // check / gate
    let j = judge()
    let ran = false
    if (o.cmd === 'gate' && j.state === 'stale') {
      process.stderr.write(`wolfpack-test-record: ${j.reason} — re-taking the record once\n`)
      await takeRecord(o, c)
      ran = true
      j = judge()
    }
    const res = { stage: o.stage, target: c.sha, state: j.state, ok: j.ok, reason: j.reason, ran, record_path: c.paths.json, fix: j.ok ? null : fix }
    emit(o, res, j.ok
      ? `wolfpack-test-record: ${o.cmd} ALLOW — passing ${o.stage} record at ${c.sha.slice(0, 12)}`
      : `wolfpack-test-record: ${o.cmd} REFUSE — ${j.state}: ${j.reason}\n  fix: ${fix}`)
    return j.ok ? 0 : 2
  } catch (e) {
    const msg = e instanceof InfraError ? e.message : (e && e.stack) || String(e)
    process.stderr.write(`✗ wolfpack-test-record: ${msg}\n`)
    if (o.json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
