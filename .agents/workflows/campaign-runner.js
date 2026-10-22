export const meta = {
// Wolfpack campaign runner — the canonical, durable orchestrator. Consuming projects run a GENERATED, stamped copy (`bash <pack>/install.sh --consumer <repo>`), checked at run start; wolfpack itself runs this file via its .claude/workflows link. Project specifics come from the consuming repo's wolfpack-config.md (read by <pack>/scripts/wolfpack-config.mjs) — never hard-code one project's values here. Every pack script runs from WOLFPACK_HOME (env, else wolfpack-config.md → Wolfpack home), never the consuming repo.
  name: 'campaign-runner',
  description: 'Run all hunts in a Wolfpack campaign wave by wave',
  phases: [
    { title: 'Parse', detail: 'Read campaign.md and extract wave structure' },
    { title: 'Execute', detail: 'Run hunts wave by wave with parallel tracks' },
  ],
}
// pack-install-model: THIS script's own stamp. The canonical carries the null form; the pack's
// generator (scripts/wolfpack-workflows.mjs, run by install.sh) replaces exactly this one line in
// a consumer's copy with {workflow, commit, version, source}. Keep it unique and on one line.
const WOLFPACK_STAMP = null // wolfpack-stamp — generated copies carry {workflow, commit, version, source}; see scripts/wolfpack-workflows.mjs
// workflow-meta-runtime: the runtime STRIPS the `export const meta` block before executing this
// script, so runtime code must never reference `meta`. This constant MUST equal the name field
// declared in the meta block (guarded by scripts/wolfpack-campaign-runner.test.mjs).
const WORKFLOW_NAME = 'campaign-runner'

const CAMPAIGN_SCHEMA = {
  type: 'object',
  properties: {
    waves: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'number' },
          hunts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                slug: { type: 'string' },
                description: { type: 'string' },
                tier: { type: 'string' },
                mode: { type: 'string' },
                blocked: { type: 'boolean' },
                dependsOn: { type: 'array', items: { type: 'string' } },
                ticketRefs: { type: 'string' },
                todoItemsCleared: { type: 'string' },
                migrationRisk: { type: 'string' },
                rationale: { type: 'string' },
                status: { type: 'string' },
                // Chain mode (campaign-chain-mode). REQUIRED, so a dropped field fails schema
                // validation instead of silently disabling AC9 rule (b) / the A-12 reapply /
                // heldHunts (the usageOffload lesson). Barrier code ignores all of them.
                migrationApps: { type: 'array', items: { type: 'string' } },
                revertedBecause: { type: ['string', 'null'] },
                heldOn: { type: 'array', items: { type: 'string' } },
                baseBranch: { type: 'string' },
              },
              required: ['slug', 'description', 'migrationApps', 'revertedBecause', 'heldOn'],
            },
          },
        },
        required: ['number', 'hunts'],
      },
    },
    // Chain mode: REQUIRED (a barrier campaign returns false / "") so a dropped field can never
    // silently read as barrier mode over a chain campaign.
    chainMode: { type: 'boolean' },
    chainBranch: { type: 'string' },
  },
  required: ['waves', 'chainMode', 'chainBranch'],
}

// args may arrive as an object or, when the invoker stringifies it, as a JSON
// string. Parse defensively so campaignSlug never silently resolves to undefined.
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const { campaignSlug, maxParallel, chain: chainArg, unattended: unattendedArg } = parsedArgs
// campaign-cron-resume: `/run-campaign-local --unattended` (chain mode only) passes unattended: true.
// The runner itself behaves the same; the flag is echoed in the result and the log.
const unattended = unattendedArg === true
const parallelCap = maxParallel || 2
// Chain mode (`--chain`, campaign-chain-mode): the launch command greps this marker.
// WOLFPACK_CHAIN_RUNNER=1
// POSIX single-quote a value for a shell command string (same as hunt-pipeline's shq).
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

// Alternate the cross-examiner per hunt so two parallel hunts never
// stack their reviews on the same model (which trips Mistral rate limits).
// Examiner SPREAD DEFAULT (the "runner rebalances" baseline): hunts rotate their FIRST
// examiner over the enabled families, so parallel hunts don't all start on one provider.
// This is only a HINT now — once a hunt's Alpha runs, its pedigree-driven
// model_assignments.bloodhound OVERRIDES this per hunt (hunt-pipeline.js
// setExaminer), and the hunt then sticks with whichever examiner answers. When
// two concurrent hunts' Alphas land on the same provider anyway, the per-model
// flock cap in the shim scripts (≤2 calls at once) prevents overload. Full
// Alpha-aware cross-hunt reassignment would need post-Plan coordination — not
// done yet; the flock cap is the interim safeguard.
let huntCounter = 0
// The hint rotates over the ENABLED SHIM examiner families, in hunt-pipeline's chain order:
// glm unless WOLFPACK_ENABLE_GLM is off (default ON — unset/""/"1"/"true"); mistral unless
// WOLFPACK_ENABLE_MISTRAL_AUTO is off (same gate shape, also default ON). With the defaults
// that alternates glm/mistral. `claude` is deliberately NOT in the rotation: a hint rotates
// the chain's FIRST link, and claude must never be first (it is the last-resort link only).
// A hint only ROTATES the first link — hunt-pipeline still removes the code writer's family
// (e.g. glm on a GLM-Shepherd hunt), so a hint can never cause a same-family review; a
// disabled family is never hinted. gemini/agy is RETIRED (2026-10-15).
const _envRunner = (k) => ((typeof process !== 'undefined' && process.env) ? process.env[k] : undefined)
// Shared default-ON gate, identical to hunt-pipeline's _enabledGate (a deliberate "=0" now
// means OFF; the old `!!_envRunner(...)` test made "0" truthy).
const _enabledGateRunner = (k) => {
  const v = _envRunner(k)
  if (v === undefined || v === null) return true
  const t = String(v).trim().toLowerCase()
  return t === '' || t === '1' || t === 'true'
}
const MISTRAL_AUTO = _enabledGateRunner('WOLFPACK_ENABLE_MISTRAL_AUTO')   // default ON
const GLM_ENABLED  = _enabledGateRunner('WOLFPACK_ENABLE_GLM')            // default ON
const EXAMINER_ROTATION = ['glm', 'mistral']
  .filter(f => (f === 'glm' && GLM_ENABLED) || (f === 'mistral' && MISTRAL_AUTO))
// Both kill switches off → no SHIM family to hint. Return null rather than indexing modulo 0
// (NaN): the hint is advisory, and hunt-pipeline's own gates are the authority. The empty-chain
// case fails loud there, where it belongs — not silently here.
const nextCrossExaminer = () => (EXAMINER_ROTATION.length ? EXAMINER_ROTATION[huntCounter++ % EXAMINER_ROTATION.length] : null)

// ─── [05] AC1 — self-imposed token-budget breaker ─────────────
// The Workflow harness `budget` global is a SHARED output-token pool across the main
// loop and every workflow; `budget.total` is the ceiling an operator set for an
// overnight run ("how much of my window I'll spend"), `budget.remaining()` what's left.
// This is the runaway guard (NOT the account rate-limit). The account rate-limit is the
// USAGE GATE (usage-limit-gate, AC5), which is now IN-RUNNER: before claiming each NEW hunt
// the runner asks <pack>/scripts/wolfpack-window-gate.mjs (via a sonnet agent Bash step — this
// file cannot read the clock or fs) for the live 5h/weekly decision; see usageGate below.
// Before scaffolding each NEW hunt we check we
// can afford to FINISH it: if remaining < one hunt's estimated cost, stop scaffolding
// and park the queue (return WAVE_PAUSED_BUDGET) rather than start a hunt that strands
// half-built at the ceiling.
//
// estimatedHuntCost is a DECLARED, conservative per-tier estimate — NOT measured (the
// per-hunt token meter is [05] C1b / [06], deferred; we do not fabricate measured
// numbers). Over-estimating is the SAFE direction here (pause earlier = the fail-loud
// A4 rule), and every value is env-overridable so an operator calibrates from real runs:
// WOLFPACK_HUNT_COST_{GREEN,BLUE,YELLOW,ORANGE,RED} (output tokens). Wire these to the
// spend-by-model meter when it lands. Unknown tier ⇒ Red (the most expensive ⇒ most
// conservative breaker).
const DEFAULT_HUNT_COST = { Green: 30000, Blue: 50000, Yellow: 120000, Orange: 200000, Red: 350000 }
// Normalize the tier to Capitalized ("yellow"/"YELLOW" → "Yellow") so a case variant
// never silently falls through to the Red default and over-reserves.
const normTier = (t) => {
  const s = String(t || '').trim()
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : 'Red'
}
const estimatedHuntCost = (tier) => {
  const t = normTier(tier)
  const fromEnv = Number(typeof process !== 'undefined' && process.env && process.env[`WOLFPACK_HUNT_COST_${t.toUpperCase()}`])
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return DEFAULT_HUNT_COST[t] || DEFAULT_HUNT_COST.Red
}
// Returns the shortfall object when the budget can't afford `tier`, else null. Guards
// against `budget` being undefined and against no ceiling set (budget.total falsy ⇒
// breaker disabled — the runaway guard only engages for a deliberately budgeted run).
const budgetShortfall = (tier) => {
  if (typeof budget === 'undefined' || !budget || !budget.total) return null
  const need = estimatedHuntCost(tier)
  const have = budget.remaining()
  return have < need ? { need, have, tier } : null
}
// ─── usage-limit-gate (AC5/AC6) — the in-runner usage gate ─────
// Called once per NEW hunt, BEFORE workflow('hunt-pipeline') (never between phases — a
// half-built hunt is worse than an idle one). The gate decides on Claude Code's real 5h /
// 7d usage (status-line snapshot), falling back to the transcript estimate (`degraded`).
//   defer   → stop scaffolding; in-flight hunts finish; return WAVE_PAUSED_QUOTA + resetAt.
//   proceed + offload → the next hunt runs with usageOffload (GLM Shepherd on every tier).
// The schema mirrors the gate's FLAT output contract; only decision/source/degraded/exitCode
// are required so a degraded output (no usage figures) always validates.
const USAGE_GATE_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['proceed', 'defer', 'error'] },
    reason: { type: 'string' },
    reset_at: { type: ['string', 'null'] },
    source: { type: 'string' },
    degraded: { type: 'boolean' },
    degraded_reason: { type: ['string', 'null'] },
    offload: { type: 'boolean' },
    offload_reason: { type: ['string', 'null'] },
    five_hour_pct: { type: ['number', 'null'] },
    seven_day_pct: { type: ['number', 'null'] },
    weekly_pace: { type: ['number', 'null'] },
    exitCode: { type: 'integer' },
  },
  required: ['decision', 'source', 'degraded', 'exitCode'],
}
// Pointer r1 F2 — LEGACY gate (a pack's <pack>/scripts/wolfpack-window-gate.mjs that predates
// usage-limit-gate: no WOLFPACK_GATE_PROTOCOL marker). It emits only {decision, exit,
// gateEnabled, reason, used, remaining, reset_at} — no source/degraded — so the full schema
// would reject EVERY result and abort every hunt claim. Same merge→sync reasoning as the
// AC25 STALE PIPELINE warning below: the preflight detects it ONCE, warns loudly, and the
// gate runs in a LABELLED degraded mode (source "legacy_gate", degraded:true, offload never
// set) — its real transcript-estimate proceed/defer still gates. Set by the preflight.
let legacyGate = false
const LEGACY_GATE_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['proceed', 'defer', 'error'] },
    reason: { type: 'string' },
    reset_at: { type: ['string', 'null'] },
    exitCode: { type: 'integer' },
  },
  required: ['decision', 'exitCode'],
}
// Validates BEFORE any caller reads `decision`; never invents proceed/defer. A null result
// (schema failure), decision 'error', an exit code outside {0,10}, or an inconsistent
// decision/exit pair ⇒ THROW (loud; nothing has been scaffolded for this hunt yet).
const usageGate = async (hunt) => {
  const tier = normTier(hunt.tier)
  const g = legacyGate ? await agent(`
READ-ONLY — modify nothing. From the repo root run exactly:
  node ${shq(packScript('wolfpack-window-gate.mjs'))} --json
Exit code 10 is a NORMAL "defer", not an error. Return the parsed JSON fields VERBATIM
(decision, reason, reset_at) plus exitCode = the script's real exit code.
If the script is missing, exits with anything other than 0 or 10, or prints no parseable
JSON on stdout, return exactly {decision:'error', exitCode:<the real exit code, or -1 if it
did not run>, reason:<first stderr line>}. Never invent a proceed/defer.
`, { label: `usage-gate-legacy:${hunt.slug}`, phase: 'Execute', model: 'sonnet', schema: LEGACY_GATE_SCHEMA })
  : await agent(`
READ-ONLY — modify nothing. From the repo root run exactly:
  node ${shq(packScript('wolfpack-window-gate.mjs'))} --json --tier ${tier}
Exit code 10 is a NORMAL "defer", not an error. Return the parsed JSON fields VERBATIM
(decision, reason, reset_at, source, degraded, degraded_reason, offload, offload_reason,
five_hour_pct, seven_day_pct, weekly_pace) plus exitCode = the script's real exit code.
If the script is missing, exits with anything other than 0 or 10, or prints no parseable
JSON on stdout, return exactly {decision:'error', source:'', degraded:true,
exitCode:<the real exit code, or -1 if it did not run>, reason:<first stderr line>}.
Never invent a proceed/defer.
`, { label: `usage-gate:${hunt.slug}`, phase: 'Execute', model: 'sonnet', schema: USAGE_GATE_SCHEMA })
  const fail = (why) => {
    throw new Error(`campaign-runner: usage gate unavailable (${why}) — not starting ${hunt.slug}`)
  }
  if (!g) fail('no schema-valid gate result')
  if (g.exitCode !== 0 && g.exitCode !== 10) fail(`gate exit ${g.exitCode}${g.reason ? `: ${g.reason}` : ''}`)
  if (g.decision === 'error') fail(g.reason || 'gate reported error')
  if ((g.decision === 'proceed' && g.exitCode !== 0) || (g.decision === 'defer' && g.exitCode !== 10)) {
    fail(`inconsistent gate result: decision ${g.decision} with exit ${g.exitCode}`)
  }
  const out = legacyGate ? {
    decision: g.decision, reason: g.reason || '', reset_at: g.reset_at ?? null,
    source: 'legacy_gate', degraded: true,
    degraded_reason: `STALE gate script (pre-usage-limit-gate, no WOLFPACK_GATE_PROTOCOL) — transcript estimate only; the pack at ${wolfpackHome.home} has no scripts/wolfpack-window-gate.mjs (or it predates the usage gate) — point WOLFPACK_HOME / Wolfpack home at an up-to-date wolfpack checkout`,
    offload: false, offload_reason: null, five_hour_pct: null, seven_day_pct: null, weekly_pace: null,
  } : {
    decision: g.decision, reason: g.reason || '', reset_at: g.reset_at ?? null,
    source: g.source, degraded: !!g.degraded, degraded_reason: g.degraded_reason ?? null,
    offload: g.offload === true, offload_reason: g.offload_reason ?? null,
    five_hour_pct: g.five_hour_pct ?? null, seven_day_pct: g.seven_day_pct ?? null,
    weekly_pace: g.weekly_pace ?? null,
  }
  if (out.degraded) {
    log(`⚠ USAGE GATE DEGRADED (${hunt.slug}): ${out.degraded_reason || 'snapshot unusable'} — source ${out.source || '?'}; live 5h/weekly gating and offload are INACTIVE for this decision.`)
  }
  const figs = out.five_hour_pct == null ? '' : ` [5h ${out.five_hour_pct}%${out.seven_day_pct == null ? '' : ` · 7d ${out.seven_day_pct}% · pace ${out.weekly_pace}`}]`
  log(`usage gate ${hunt.slug} (${tier}): ${out.decision}${out.offload ? ' + OFFLOAD' : ''} — ${out.reason}${figs}`)
  return out
}
// The WAVE_PAUSED_QUOTA return for a usage-gate defer — modelled on the WAVE_PAUSED_BUDGET
// return; the verdict token is the existing barrier token the overnight driver loops on.
const usagePausedReturn = (pause, waveResults, deferred, waveNumber) => {
  log(``)
  log(`⛔ Usage gate: ${pause.reason} — not starting ${pause.slug}; resume after ${pause.reset_at || 'the window resets'}`)
  log(`Deferred ${deferred.length} hunt(s): ${deferred.map(h => h.slug).join(', ')}`)
  return {
    campaign: campaignSlug,
    completed: false,
    verdict: 'WAVE_PAUSED_QUOTA',
    certifiedHunts: waveResults.filter(r => r.verdict === 'CERTIFIED_AWAITING_DEPLOY').map(r => r.slug),
    parkedHunts: [],
    deferredHunts: deferred.map(h => ({ slug: h.slug, tier: h.tier })),
    quotaDeferredHunts: [],
    failedHunts: [],
    completedWave: waveNumber,
    resetAt: pause.reset_at || null,     // informational (log / operator / campaign-cron-resume)
    usage: { source: pause.source, reason: pause.reason },
  }
}

// [Fix 1] The old batch-sum breaker (budgetShortfallForBatch) retired with the batch
// scheduler. The rolling pool below reserves each in-flight hunt's full estimated cost
// (inFlightReserved) and gates a new claim on (this hunt + in-flight reserved) — same
// "two concurrent Reds can't both pass a single-hunt check then exhaust the pool"
// guarantee, now enforced per-claim instead of per-batch.

// ─── Phase: Parse Campaign ─────────────────────────────────────
phase('Parse')
log(`Parsing campaign: ${campaignSlug}`)
if (unattended) log(`UNATTENDED run: no one is watching — anything that needs a human parks; the armed campaign is disarmed and paged at the end (campaign-cron-resume)`)

// ─── Preflight: the consuming project's wolfpack-config.md (wolfpack-self-hosting, AC10) ───
// pack-install-model (D9): this block runs FIRST in the Parse phase — before the parse-campaign
// agent — so a stale runner stops before any campaign work and the parse prompt can use
// worktreeRoot. Order: config probe (read-only) → pack home → stamp check.
// The runner surfaces the project's deploy step in the release queue, and every hunt it
// launches reads the same config. The Workflow script has no filesystem access, so one
// read-only agent runs the deterministic reader (<pack>/scripts/wolfpack-config.mjs) and relays its
// JSON. Fail closed: a missing/incomplete config, a garbled relay or a dead seat THROWS
// before any hunt launches — the runner never guesses a project value.
// workflow-meta-runtime: the two run-start probes (project-config, workflow-stamp) must run in
// the SAME host repo. Each prints its pwd in the same command line and returns it as `cwd`; the
// stamp check fails closed unless both agree with the checker's consumer.
const PROBE_NO_CD = 'Run in your STARTING directory exactly as launched — do NOT cd anywhere first (not to a repo root, not into any project, repo or path named in your context or memory). Run the command below as ONE command line.'
// Trailing-slash/whitespace normalized only (no realpath — a symlink-vs-logical difference fails
// closed). '' when absent, empty or not absolute; callers treat '' as a mismatch.
const probeRoot = (v) => (typeof v === 'string' && v.trim().startsWith('/')) ? (v.trim().replace(/\/+$/, '') || '/') : ''
let hostRepoRoot = ''
const PROJECT_CONFIG_SCHEMA = { type: 'object', properties: { exitCode: { type: 'number' }, output: { type: 'string' }, cwd: { type: 'string' }, pack: { type: 'string' } }, required: ['exitCode', 'output', 'cwd', 'pack'] }
// scripts-unfork: the config probe runs the PACK's reader (`<pack>/scripts/wolfpack-config.mjs`),
// never a copy in the consuming repo. The probe runs before the pack home is known, so it
// bootstraps with the same resolver: the workflow INJECTS its own WOLFPACK_HOME as a literal
// (the probe seat's env is never consulted — it may be curated); unset → the probe takes
// wolfpack-config.md → Project Identity → Wolfpack home VERBATIM and the shell expands only a
// leading `~` (the reader's expandHome rule). It reports the PACK it used as PACK_HOME=, and
// requireProbedPack() fails closed unless that equals resolveWolfpackHome(). Body identical
// in both workflows.
let probedPackHome = ''
const configProbeCommand = (envHome) => {
  const run = 'echo "PROBE_PWD=$(pwd)"; echo "PACK_HOME=$PACK"; node "$PACK/scripts/wolfpack-config.mjs" --json wolfpack-config.md 2>&1; echo "CONFIG_RC=$?"'
  if (envHome) return `Run exactly:
  PACK=${shq(envHome)}; ${run}`
  return `First read wolfpack-config.md (in your starting directory) → ## Project Identity → **Wolfpack home**: its backticked path, VERBATIM — do NOT expand \`~\`, resolve symlinks or substitute any other path (the workflow rejects a non-absolute or mismatched home itself). Substitute it for <home> below, inside the single quotes (the config reader refuses a pack home that contains a single quote); if there is no such key, use an empty <home>. Then run exactly:
  PACK='<home>'; case "$PACK" in "~"|"~/"*) PACK="$HOME\${PACK#"~"}" ;; esac; ${run}`
}
const requireProbedPack = (who, home) => {
  if (probeRoot(probedPackHome) !== probeRoot(home.home)) throw new Error(`${who}: the config probe ran the reader from '${probedPackHome}' but the pack home resolves to '${home.home}' (${home.source}) — the config was not read by this pack's reader. Fix: make WOLFPACK_HOME and wolfpack-config.md → Wolfpack home name the same absolute path, then relaunch.`)
}
// The first brace-balanced {…} block of a text (string-aware, so braces inside JSON strings
// never end it early; a non-greedy first-} match would truncate inside nested objects).
const firstJsonObject = (text) => {
  const t = String(text || '')
  const start = t.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1) }
  }
  return null
}
let projectConfig = null
{
  const pc = await agent(`You ONLY read this project's Wolfpack config — modify nothing. ${PROBE_NO_CD} ${configProbeCommand((_envRunner('WOLFPACK_HOME') || '').trim())}
Return cwd = the path after PROBE_PWD= VERBATIM, pack = the path after PACK_HOME= VERBATIM, exitCode = the number after CONFIG_RC= and output = the command's stdout+stderr VERBATIM, minus the PROBE_PWD, PACK_HOME and CONFIG_RC lines.
If the command could not run at all, return exitCode 2, the error text as output, pack = the PACK value you used (or ''), and cwd = the output of pwd. Never create, fix or edit anything.`,
    { label: 'project-config', phase: 'Parse', model: 'sonnet', schema: PROJECT_CONFIG_SCHEMA })
  const out = (pc && typeof pc.output === 'string') ? pc.output : ''
  // The reader's ✗ line names the missing keys; surface it first, then the head of the output.
  const outLines = out.split('\n')
  const flagged = outLines.filter(l => /^\s*✗/.test(l))
  const detail = out ? [...flagged, ...outLines.slice(0, 20).filter(l => !flagged.includes(l))].join('\n') : '(no output — the probe seat returned nothing)'
  let parsed = null
  let why = ''
  if (!pc) why = 'the project-config probe returned no result'
  else if (pc.exitCode !== 0) why = `the reader exited ${pc.exitCode}`
  else {
    const block = firstJsonObject(out)
    try { parsed = block ? JSON.parse(block) : null } catch { parsed = null }
    if (!parsed) why = 'the reader output held no parseable JSON object'
    else if (typeof parsed.testCommand !== 'string' || !parsed.testCommand) why = 'testCommand is not a string'
    else if (!Array.isArray(parsed.compliancePaths)) why = 'compliancePaths is not an array'
  }
  if (why) {
    throw new Error(`campaign-runner: wolfpack-config.md is missing or incomplete — no hunt may start. ${why}: ${detail}. Fix: copy wolfpack-config.example.md to wolfpack-config.md and fill the required keys (Name, Test command, Compliance areas, Risk-surface paths, Model Pool judgment + reviewer-a); check with node <pack>/scripts/wolfpack-config.mjs --json, and make sure WOLFPACK_HOME / Wolfpack home points at a wolfpack checkout (the reader is <pack>/scripts/wolfpack-config.mjs)`)
  }
  const root = probeRoot(pc.cwd)
  if (!root) throw new Error(`campaign-runner: the project-config probe did not report the directory it ran in (cwd ${JSON.stringify(pc.cwd ?? null)}) — the host repo is UNKNOWN, so the stamp check cannot confirm both probes read the same repo. Relaunch from the consuming repo's root.`)
  hostRepoRoot = root
  probedPackHome = typeof pc.pack === 'string' ? pc.pack : ''
  projectConfig = parsed
  log(`Project config: ${projectConfig.name} — tests: ${projectConfig.testCommand}; deploy: ${projectConfig.devDeployCommand || 'none'}`)
}
// exec-layer-into-pack: the pack's execution layer resolves from WOLFPACK_HOME — env, else
// wolfpack-config.md → Project Identity → Wolfpack home, else STOP with the fix (before any
// hunt launches). Never the consuming repo. TRUST BOUNDARY: the key leg reads ONLY the
// projectConfig probed above from the main checkout's root, never a worktree. Nothing is
// passed to the hunts: each hunt-pipeline resolves for itself from the same env and key.
// Body identical to hunt-pipeline.js's resolveWolfpackHome (apart from the env accessor).
const resolveWolfpackHome = (who) => {
  const env = _envRunner('WOLFPACK_HOME'); const key = projectConfig && projectConfig.wolfpackHome
  const fix = 'Fix: export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add "- **Wolfpack home:** `<path>`" under ## Project Identity in wolfpack-config.md (check: node <pack>/scripts/wolfpack-config.mjs)'
  const raw = (typeof env === 'string' && env.trim()) ? env.trim() : (typeof key === 'string' && key.trim()) ? key.trim() : ''
  const source = (typeof env === 'string' && env.trim()) ? 'env WOLFPACK_HOME' : 'wolfpack-config.md → Project Identity → Wolfpack home'
  if (!raw) throw new Error(`${who}: WOLFPACK_HOME is not set and wolfpack-config.md has no Wolfpack home — the pack's execution shims are never looked up in the consuming repo. ${fix}`)
  if (!raw.startsWith('/')) throw new Error(`${who}: ${source} is not an absolute path ('${raw}'). ${fix}`)
  return { home: raw.replace(/\/+$/, '') || '/', source }
}
// Top-level (pack-install-model): the stamp check and the Execute-phase fix texts need it.
const wolfpackHome = resolveWolfpackHome('campaign-runner')
requireProbedPack('campaign-runner', wolfpackHome)
// scripts-unfork: every pack script runs from the pack home, never the consuming repo.
const packScript = (name) => `${wolfpackHome.home}/scripts/${name}`
log(`Pack home (WOLFPACK_HOME): ${wolfpackHome.home} — from ${wolfpackHome.source}`)
// pack-install-model: where hunt worktrees live (wolfpack-config.md → Project Identity →
// Worktree root, repo-relative). Required — the pipeline never guesses it. Re-validated here
// with the reader's validWorktreeRoot rule (fail closed on a garbled relay). Body identical in
// hunt-pipeline.js and campaign-runner.js.
const requireWorktreeRoot = (who, value) => {
  const fix = 'Fix: add "- **Worktree root:** `<dir>`" under ## Project Identity, where <dir> is the repo-relative, gitignored directory this project\'s hunt worktrees live in (e.g. `.agents/worktrees` or `.claude/worktrees`); check: node <pack>/scripts/wolfpack-config.mjs --json'
  if (typeof value !== 'string' || !value) throw new Error(`${who}: wolfpack-config.md has no Worktree root — the pipeline will not guess where hunt worktrees live. ${fix}`)
  const segs = value.split('/')
  const ok = !value.startsWith('/') && !value.startsWith('~') && segs[0] !== '.git' &&
    segs.every(seg => /^\.?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(seg))
  if (!ok) throw new Error(`${who}: wolfpack-config.md → Worktree root '${value}' is not a repo-relative path (no leading / or ~, no . or .. segments, no spaces or shell characters, not under .git). ${fix}`)
  return value
}
const worktreeRoot = requireWorktreeRoot('campaign-runner', projectConfig.worktreeRoot)
log(`Worktree root: ${worktreeRoot} (wolfpack-config.md → Project Identity)`)
// pack-install-model (AC5): the run-start stamp check. WOLFPACK_STAMP is THIS script's own
// stamp (null in the canonical). A read-only probe runs the pack's checker against the main
// checkout; fail closed on any malformed/absent result. Throws BEFORE any state is mutated.
// Body identical in hunt-pipeline.js and campaign-runner.js (byte-identical; the per-file value is WORKFLOW_NAME).
const STAMP_PROBE_SCHEMA = { type: 'object', properties: { exitCode: { type: 'number' }, output: { type: 'string' }, cwd: { type: 'string' } }, required: ['exitCode', 'output', 'cwd'] }
const checkWorkflowStamp = async (who, label, phaseName) => {
  const self = `${WORKFLOW_NAME}.js`
  const home = wolfpackHome.home
  if (home.includes("'")) throw new Error(`${who}: WOLFPACK_HOME contains a single quote — refusing to build the stamp probe`)
  const p = await agent(`READ-ONLY workflow stamp probe — modify nothing. ${PROBE_NO_CD} Run exactly:
  echo "PROBE_PWD=$(pwd)"; node '${home}/scripts/wolfpack-workflows.mjs' check --pack '${home}' --consumer "$(pwd)" --json 2>&1; echo "STAMP_RC=$?"
Return cwd = the path after PROBE_PWD= VERBATIM, exitCode = the number after STAMP_RC= and output = the command's stdout+stderr VERBATIM, minus the PROBE_PWD and STAMP_RC lines.
If the command could not run at all, return exitCode 2, the error text as output, and cwd = the output of pwd. Never create, fix, regenerate or edit anything.`,
    { label, phase: phaseName, model: 'sonnet', schema: STAMP_PROBE_SCHEMA })
  if (!p) throw new Error(`${who}: the workflow stamp probe returned no result — workflow freshness UNKNOWN; relaunch`)
  const out = typeof p.output === 'string' ? p.output : ''
  const head = out.split('\n').slice(0, 20).join('\n') || '(no output)'
  if (p.exitCode !== 0 && p.exitCode !== 1) throw new Error(`${who}: the workflow stamp check failed (exit ${p.exitCode}) — workflow freshness UNKNOWN: ${head}. Fix: run node '${home}/scripts/wolfpack-workflows.mjs' check --consumer <this repo> and resolve what it names (bash '${home}/install.sh' --check lists every problem)`)
  let parsed = null
  try { const block = firstJsonObject(out); parsed = block ? JSON.parse(block) : null } catch { parsed = null }
  if (!parsed || !Array.isArray(parsed.workflows)) throw new Error(`${who}: the workflow stamp probe output held no checker result (no workflows[] array) — workflow freshness UNKNOWN: ${head}`)
  const entry = parsed.workflows.find(w => w && w.name === self)
  if (!entry || typeof entry.state !== 'string') throw new Error(`${who}: the workflow stamp check did not report ${self} — workflow freshness UNKNOWN: ${head}`)
  // workflow-meta-runtime: fail closed unless the config probe, this probe and the checker all
  // name the SAME host repo (a probe that cd'd elsewhere would compare the wrong consumer).
  const probePwd = probeRoot(p.cwd)
  const checkedConsumer = probeRoot(parsed.consumer)
  if (!hostRepoRoot || probePwd !== hostRepoRoot || checkedConsumer !== hostRepoRoot) {
    const show = (v) => v || '(not reported)'
    throw new Error(`${who}: HOST REPO DRIFTED between probes — the project-config probe ran in ${show(hostRepoRoot)}, but the workflow stamp probe ran in ${show(probePwd)} and checked consumer ${show(checkedConsumer)}. Refusing to run: ${self}'s freshness would be judged against a different repo than the config was read from. Fix: relaunch from the consuming repo's root (the probes must not cd).`)
  }
  const S = WOLFPACK_STAMP
  const packVersion = parsed.packVersion
  const packCommit = String(parsed.packCommit || '')
  if (S === null) {
    if (entry.state === 'canonical') {
      log(`Workflow version: ${self} canonical — pack ${packVersion} @ ${packCommit.slice(0, 12)} (${entry.file})`)
      return parsed
    }
    throw new Error(`${who}: this run is the UNSTAMPED canonical ${self} but ${entry.file} is ${entry.state} — fix: ${entry.fix || `bash '${home}/install.sh' --consumer <this repo>`}, then restart Claude Code (named workflows are cached per session) and relaunch`)
  }
  if (S.source === entry.canonicalSource) {
    if (entry.state === 'current') {
      log(`Workflow version: ${self} ${S.version} @ ${String(S.commit).slice(0, 12)} (source ${String(S.source).slice(0, 19)}…) — current against the pack at ${home}`)
      return parsed
    }
    throw new Error(`${who}: ${entry.file} is ${entry.state} — its stamp matches the pack but the copy on disk is not the generated bytes. ` +
      `Fix: ${entry.fix || 'regenerate it'}, then restart Claude Code (named workflows are cached per session) and relaunch.`)
  }
  throw new Error(`${who}: STALE WORKFLOW — this run is ${self} ${S.version} @ ${String(S.commit).slice(0, 12)}, but the pack's canonical ${self} has changed. ` +
    (entry.state === 'current'
      ? `${entry.file} is already regenerated: this session is running a CACHED older copy — restart Claude Code (named workflows are cached per session) and relaunch.`
      : `${entry.file} is ${entry.state}. Fix: ${entry.fix || `bash '${home}/install.sh' --consumer <this repo>`}, then restart Claude Code and relaunch.`))
}
const stampState = await checkWorkflowStamp('campaign-runner', 'workflow-stamp', 'Parse')
// The runner launches workflow('hunt-pipeline') by name: refuse to start a wave when that copy
// is not current (each hunt would stop at its own run start anyway — fail once, early).
const hp = stampState.workflows.find(w => w.name === 'hunt-pipeline.js')
if (!hp || !['current', 'canonical'].includes(hp.state)) throw new Error(`campaign-runner: the runtime hunt-pipeline.js is ${hp ? hp.state : 'not reported'} — no hunt may start. Fix: ${hp && hp.fix ? hp.fix : `bash '${wolfpackHome.home}/install.sh' --consumer <this repo>`}, then restart Claude Code and relaunch.`)


const campaign = await agent(`
Read the campaign file at .wolfpack/campaigns/${campaignSlug}/campaign.md.
Also read .wolfpack/campaigns/${campaignSlug}/metadata.json.

Extract the wave structure from the "## Proposed Hunts" section and the "### Wave diagram" section.

For each hunt, extract ALL of these fields — Alpha needs them for scoping:
- slug (from the ### N. <slug> heading)
- description (from the Trigger line, inside the quotes after the slug — this is the FULL description, not a summary)
- tier (from the Tier field — Alpha MUST respect this, not downgrade)
- mode (from the Mode field — update or feature)
- blocked (true if Wave is "BLOCKED")
- dependsOn (array of slugs from the "Depends on" field; empty array if None)
- ticketRefs (from "Ticket refs" field — e.g. "[dev #26 Urgent, #61 Urgent]")
- todoItemsCleared (from "TODO items cleared" field — what gets removed from TODO.md)
- migrationRisk (from "Migration risk" field — none, additive, or destructive)
- rationale (from "Rationale" field — why this hunt is scoped/bundled this way)

Group hunts by their Wave number.

Also read each hunt's CURRENT status so the runner can skip work that's already done. The
status field is the AUTHORITATIVE on-disk log — return it VERBATIM, do NOT re-derive or
normalize it:
- Read the hunt's metadata.json — the worktree copy
  ${worktreeRoot}/<slug>/.wolfpack/plans/<slug>/metadata.json FIRST if it exists (it's the
  live one during a run), else the main-repo copy .wolfpack/plans/<slug>/metadata.json — and
  return its \`status\` as-is. Meanings:
  - "merged" — stamped by /merge + /merge-wave at copy-back; the hunt shipped.
  - "certified" / "certified_not_merged" — Watchdog PASS, NOT yet merged (await /merge-wave).
  - "needs_spec" or "parked:<reason>" (parked:open_critical, parked:compliance_review,
    parked:non_convergence, parked:model_quota, …) — await a human via /resolve (except
    parked:model_quota, which auto-resumes). Pass through verbatim; do NOT drop them.
  - CHAIN MODE statuses (pass through verbatim, never normalize): "merged_to_campaign",
    "merged_to_campaign_pending_compliance" (merged into the campaign branch, awaiting the
    campaign release), "certified_pending_compliance", "certified_held_overlap" (certified,
    not yet merged into the campaign branch), "parked:campaign_merge_conflict",
    "parked:reverted_from_campaign", "reverted_with_dependency".
  - anything else (ready_for_alpha, reviewing, reviewed, implementing, …) — mid-pipeline, resumable.
- LEGACY FALLBACK ONLY: if an OLD hunt's status is still "certified" but feat/<slug> is gone AND
  its merge commit is on main, you MAY return "merged". New hunts are stamped "merged" directly,
  so this git inference should not normally be needed.

Chain-mode fields — ALWAYS return them for every hunt (barrier campaigns too):
- migrationApps (ALWAYS return it; from the "Migration app(s)" field — a JSON-ish list like ["app_a"]; [] if absent or "[]")
- revertedBecause: metadata.reverted_because if set, else null;  heldOn: slugs in metadata.held_on, else []
- baseBranch: metadata.base_branch if a non-empty string, else ""
Top level (ALWAYS return both): chainMode = true iff .wolfpack/campaigns/${campaignSlug}/metadata.json has chain.mode === "chain",
else false; chainBranch = chain.branch whenever the metadata has a chain block with a non-empty branch, WHATEVER chain.mode reads (else "").

Return the structured wave data. Exclude BLOCKED hunts. Include done, certified, and
parked/needs_spec hunts with their verbatim status.
`, { label: 'parse-campaign', phase: 'Parse', schema: CAMPAIGN_SCHEMA })

log(`Campaign parsed: ${campaign.waves.length} waves, ${campaign.waves.reduce((n, w) => n + w.hunts.length, 0)} hunts`)

// ─── Preflight: runtime hunt-pipeline supports the hinted examiner families ────
// The runtime hunt-pipeline.js in a consuming project is a GENERATED, often gitignored
// copy — a GENERATED, stamped copy (install.sh). A stale copy predates the examiner chain: it
// would silently misread a "glm" hint (as mistral, or drop it). The preflight now runs
// UNCONDITIONALLY — there is no "gemini-only, nothing to check" case any more, so the old
// `some(f => f !== 'gemini')` wrapper was trivially true and therefore meaningless.
//
// FLOOR vs LATEST (AC25). REQUIRED is the FLOOR: below it the runtime cannot honor an
// examiner-chain hint at all, so we throw. LATEST is what the current canonical
// hunt-pipeline emits; at-or-above the floor but below LATEST we WARN and CONTINUE, because
// this file is tracked and merges with the hunt while the consumer's hunt-pipeline.js stays
// gitignored and un-regenerated until the operator re-runs install.sh — a GENERATED, stamped copy (install.sh). Throwing
// there would abort every campaign launch AND every cron auto-resume at the Parse phase for
// the whole merge→sync window — converting a known, temporary, documented drift into an
// outage. The degrade is bounded and LOUD: an old protocol-2 pipeline honors a glm hint and
// falls back to its own gemini-first chain otherwise.
const REQUIRED_EXAMINER_PROTOCOL = 2   // FLOOR: understands the examiner chain / crossExaminer hint at all
const LATEST_EXAMINER_PROTOCOL   = 3   // what the current canonical hunt-pipeline emits
let chainCapability = null   // the probe result, read by the chain-mode checks below
{
  const cap = await agent(`
READ-ONLY check — modify nothing. From the current repo root, pick the runtime workflow file:
.claude/workflows/hunt-pipeline.js if it exists, else .agents/workflows/hunt-pipeline.js.
Run: grep -o 'WOLFPACK_EXAMINER_PROTOCOL=[0-9]*' <that file> | head -1
Also run: grep -o 'WOLFPACK_USAGE_PROTOCOL=[0-9]*' <that file> | head -1
Then, for the usage gate script (the PACK's), run: test -f ${shq(packScript('wolfpack-window-gate.mjs'))} && echo present
and: grep -o 'WOLFPACK_GATE_PROTOCOL=[0-9]*' ${shq(packScript('wolfpack-window-gate.mjs'))} | head -1
Chain mode: grep -o 'WOLFPACK_CHAIN_PROTOCOL=[0-9]*' <the runtime workflow file> | head -1
and: test -f ${shq(packScript('wolfpack-chain.mjs'))} && echo present
Return path (the file you checked, or "" if neither exists), protocol (the integer after
the first marker's "=", or 0 if the marker is absent / the file is missing),
usageProtocol (the integer after the second marker's "=", or 0 if absent), gatePresent
(true only if ${packScript('wolfpack-window-gate.mjs')} exists) and gateProtocol (the integer after
the WOLFPACK_GATE_PROTOCOL marker's "=", or 0 if absent / the file is missing),
chainProtocol (the integer after the WOLFPACK_CHAIN_PROTOCOL marker's "=", or 0 if absent)
and chainScriptPresent (true only if ${packScript('wolfpack-chain.mjs')} exists).
`, { label: 'pipeline-capability', phase: 'Parse', model: 'sonnet', schema: {
    type: 'object',
    properties: {
      path: { type: 'string' }, protocol: { type: 'number' }, usageProtocol: { type: 'number' },
      gatePresent: { type: 'boolean' }, gateProtocol: { type: 'number' },
      chainProtocol: { type: 'number' }, chainScriptPresent: { type: 'boolean' },
    },
    required: ['protocol', 'gatePresent', 'gateProtocol'],
  } })
  // Pointer r2 F3: a null result is a PROBE failure (agent error / schema exhaustion), not
  // evidence of a stale pipeline — say so instead of sending the operator to re-sync.
  if (cap == null) {
    throw new Error(`campaign-runner: the pipeline-capability probe returned no result (agent failure) — capability is UNKNOWN, so no hunt may start. This is not a stale-pipeline diagnosis; relaunch to re-run the probe, and check the agent/model availability if it repeats.`)
  }
  chainCapability = cap
  const proto = Number(cap.protocol) || 0
  if (proto < REQUIRED_EXAMINER_PROTOCOL) {
    throw new Error(`campaign-runner: the runtime hunt-pipeline (${(cap && cap.path) || 'not found'}) is STALE — examiner protocol ${proto} < ${REQUIRED_EXAMINER_PROTOCOL}; it cannot honor the ${EXAMINER_ROTATION.join('/')} examiner hints. Regenerate it: bash '${wolfpackHome.home}/install.sh' --consumer <this repo> (then restart Claude Code), then relaunch.`)
  }
  if (proto < LATEST_EXAMINER_PROTOCOL) {
    // Disclosed degrade (CLAUDE.md § Fail Loud): logged at WARNING level AND visible in the
    // campaign output, every pass, naming the exact fix.
    log(`⚠ STALE PIPELINE: the runtime hunt-pipeline (${(cap && cap.path) || 'not found'}) reports examiner protocol ${proto}, this campaign-runner is ${LATEST_EXAMINER_PROTOCOL}. Reviews will run on the OLD (gemini-first) chain until you regenerate it: bash '${wolfpackHome.home}/install.sh' --consumer <this repo> (then restart Claude Code)`)
  } else {
    log(`Pipeline capability OK: examiner protocol ${proto} (${cap.path}) — hint rotation ${EXAMINER_ROTATION.join(' / ')}`)
  }
  // usage-limit-gate: a WARNING, not a throw — same merge→sync reasoning as AC25 above. The
  // gate itself still works (it runs here, in the runner); only the hunt-side offload record
  // and usage_delta/heartbeat stamping are missing until the runtime copy is regenerated.
  if ((Number(cap && cap.usageProtocol) || 0) < 1) {
    log(`⚠ STALE PIPELINE: runtime hunt-pipeline predates the usage gate — usage offload and usage_delta will NOT be recorded until you regenerate it: bash '${wolfpackHome.home}/install.sh' --consumer <this repo> (then restart Claude Code)`)
  }
  // Pointer r1 F2 — gate-script capability. MISSING ⇒ throw here, once, naming the fix (no
  // gate at all is not a degrade we can label). PRESENT but pre-protocol ⇒ WARN and run the
  // labelled legacy mode (see legacyGate) instead of letting the schema reject every claim.
  if (!(cap && cap.gatePresent)) {
    throw new Error(`campaign-runner: ${packScript('wolfpack-window-gate.mjs')} is MISSING — the usage gate cannot run, so no hunt may start. Fix: the pack at ${wolfpackHome.home} has no scripts/wolfpack-window-gate.mjs (or it predates the usage gate) — point WOLFPACK_HOME / Wolfpack home at an up-to-date wolfpack checkout, then relaunch.`)
  }
  if ((Number(cap.gateProtocol) || 0) < 1) {
    legacyGate = true
    log(`⚠ STALE USAGE GATE: ${packScript('wolfpack-window-gate.mjs')} predates usage-limit-gate (no WOLFPACK_GATE_PROTOCOL marker). Gating on its TRANSCRIPT ESTIMATE only (source legacy_gate, degraded) — live 5h/weekly figures and usage offload are INACTIVE until fixed: the pack at ${wolfpackHome.home} has no scripts/wolfpack-window-gate.mjs (or it predates the usage gate) — point WOLFPACK_HOME / Wolfpack home at an up-to-date wolfpack checkout`)
  } else {
    log(`Usage gate capability OK: gate protocol ${cap.gateProtocol}`)
  }
}


// ─── Chain mode (`--chain`, campaign-chain-mode) ───────────────
// Chain mode moves the integration target from `main` to a LOCAL `campaign/<slug>` branch:
// waves auto-merge into it (`--no-ff`, no tag, no push), later waves fork from it, `main` is
// merged in at each wave start, and a blocked hunt only holds the hunts that CONFLICT with it
// (dependency, shared migration app, or overlapping files). One `/release-campaign` merges the
// branch into `main` with one tag, after the human approves. This file cannot run git, so every git
// step goes through <pack>/scripts/wolfpack-chain.mjs (a deterministic, temp-repo-tested CLI) via a
// sonnet agent that returns its JSON verbatim. The BARRIER loop below is untouched: runChain()
// is a separate path (its rolling pool deliberately duplicates the barrier pool's claim logic —
// keep the two twins in step).
//
// The pure core block is byte-identical (minus `export `) to the one in
// scripts/wolfpack-chain.mjs; a drift test fails if they differ.
// ── BEGIN wolfpack-chain core (keep byte-identical: scripts/wolfpack-chain.mjs ⇄ campaign-runner.js) ──
const CHAIN_STATUS = Object.freeze({
  MERGED: 'merged_to_campaign',
  MERGED_PENDING_COMPLIANCE: 'merged_to_campaign_pending_compliance',
  CERTIFIED_PENDING_COMPLIANCE: 'certified_pending_compliance',
  HELD_OVERLAP: 'certified_held_overlap',
  MERGE_CONFLICT: 'parked:campaign_merge_conflict',
  REVERTED: 'parked:reverted_from_campaign',
  REVERTED_WITH_DEP: 'reverted_with_dependency',
})
// 'released' | 'campaign_merged' | 'awaiting_merge' | 'reverted_dep' | 'quota' | 'blocked' | 'pending'
function chainClass(status) {
  const s = String(status || '')
  if (s === 'merged') return 'released'
  if (s === CHAIN_STATUS.MERGED || s === CHAIN_STATUS.MERGED_PENDING_COMPLIANCE) return 'campaign_merged'
  if (['certified', 'certified_not_merged', CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE, CHAIN_STATUS.HELD_OVERLAP].includes(s)) return 'awaiting_merge'
  if (s === CHAIN_STATUS.REVERTED_WITH_DEP) return 'reverted_dep'
  if (s === 'parked:model_quota') return 'quota'
  if (s === 'needs_spec' || s.startsWith('parked:')) return 'blocked'
  return 'pending'
}
const isDependencyMet = (status) => ['released', 'campaign_merged'].includes(chainClass(status))
const isBlockedStatus = (status) => ['blocked', 'reverted_dep'].includes(chainClass(status))
// The statuses an overlap hold (rule c) may overwrite with HELD_OVERLAP. A pending-compliance
// certification keeps its compliance flag, and a reverted_with_dependency hunt keeps its
// reapply resolution and stays a blocker, so neither is in the list. Runner and CLI share it.
const HOLDABLE_STATUSES = Object.freeze(['certified', 'certified_not_merged', CHAIN_STATUS.HELD_OVERLAP])
// graph: { [slug]: { dependsOn: string[], migrationApps: string[] } }
// Returns Map dep → path, where path is the slug chain from `slug` to that dep inclusive
// (x→y→b gives b → ['x','y','b']). Breadth-first, so each path is a shortest one; a
// visited set makes it cycle-safe.
function dependencyClosure(slug, graph) {
  const out = new Map()
  const g = graph || {}
  const queue = [[slug, [slug]]]
  const seen = new Set([slug])
  while (queue.length) {
    const [cur, path] = queue.shift()
    const deps = (g[cur] && Array.isArray(g[cur].dependsOn)) ? g[cur].dependsOn : []
    for (const d of deps) {
      if (seen.has(d)) continue
      seen.add(d)
      const p = [...path, d]
      out.set(d, p)
      queue.push([d, p])
    }
  }
  return out
}
// overlaps: { [blockedSlug]: string[] } (rule c, precomputed by the CLI). Returns [] when no conflict.
// One entry per (blocker, rule): a = depends on it (directly or transitively), b = shares a
// migration app with it (case-insensitive), c = its diff overlaps the blocker's diff.
function chainConflicts(slug, blockedSlugs, graph, overlaps = {}) {
  const g = graph || {}
  const out = []
  const closure = dependencyClosure(slug, g)
  const appsOf = (s) => ((g[s] && Array.isArray(g[s].migrationApps)) ? g[s].migrationApps : [])
    .map(a => String(a).trim().toLowerCase()).filter(Boolean)
  const mine = new Set(appsOf(slug))
  for (const b of blockedSlugs || []) {
    if (b === slug) continue
    if (closure.has(b)) out.push({ rule: 'a', with: b, via: closure.get(b) })
    const shared = [...new Set(appsOf(b))].filter(a => mine.has(a))
    if (shared.length) out.push({ rule: 'b', with: b, apps: shared })
    const files = (overlaps && Array.isArray(overlaps[b])) ? overlaps[b] : []
    if (files.length) out.push({ rule: 'c', with: b, files: [...files] })
  }
  return out
}
// ── END wolfpack-chain core ──

// The CLI result shapes the chain agents return (verbatim JSON + exitCode).
const CHAIN_CLI_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' }, reason: { type: 'string' }, branch: { type: 'string' }, sha: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } }, warning: { type: ['string', 'null'] },
    commit: { type: 'string' }, stamped: { type: 'string' }, stage: { type: 'string' }, exitCode: { type: 'integer' },
  },
  required: ['status'],
}
const CHAIN_OVERLAP_SCHEMA = {
  type: 'object',
  properties: {
    overlaps: { type: 'object' }, noDiff: { type: 'array', items: { type: 'string' } }, held: { type: 'boolean' },
    status: { type: 'string' }, reason: { type: 'string' }, exitCode: { type: 'integer' },
  },
  required: ['held'],
}

// One deterministic chain-mode git step. A null or error result THROWS with the step named:
// that is safe, because anything already certified is merged on the next run (merge
// candidates come from on-disk status).
async function chainCli(cliArgs, label, schema = CHAIN_CLI_SCHEMA) {
  const r = await agent(`
You run ONE deterministic chain-mode git step for campaign ${campaignSlug}. The script does ALL
the git work — you do NOT run any git command yourself, do NOT edit any file, and do NOT retry.
From the MAIN repo root (the current directory — not a hunt worktree) run exactly:
  node ${shq(packScript('wolfpack-chain.mjs'))} ${cliArgs}
Exit code 0 means the step DECIDED — a "conflict" or held:true result is a normal, decided outcome.
Read the JSON the script prints on stdout and return it VERBATIM (every field it printed), plus
exitCode = the script's real exit code. Never invent or "fix up" a result.
If the script is missing, exits with anything other than 0, or prints no parseable JSON on stdout,
return exactly {status:'error', held:false, exitCode:<the real exit code, or -1 if it did not run>,
reason:<the JSON "reason" field if there is one, else the first stderr line>}.
`, { label, phase: 'Execute', model: 'sonnet', schema })
  if (r == null) {
    throw new Error(`campaign-runner: chain step ${label} returned no result (agent failure) — nothing was assumed. Re-run the campaign; anything already certified is merged on the next run.`)
  }
  if (r.status === 'error' || (typeof r.exitCode === 'number' && r.exitCode !== 0)) {
    throw new Error(`campaign-runner: chain step ${label} failed${r.reason ? `: ${r.reason}` : ''} (exit ${r.exitCode ?? '?'}) — fix it and re-run the campaign; anything already certified is merged on the next run.`)
  }
  return r
}

// campaign-cron-resume (AC11): disarm + phone notifications through the pack's
// wolfpack-cron-resume.sh. NEVER throws, never blocks (AC13): a failure is a ⚠ log line, and
// the CLI itself is a no-op for a campaign that is not armed. The runner cannot run a shell,
// so a sonnet agent runs the one command (the usageGate / chainCli precedent).
const CRON_EVENT_SCHEMA = { type: 'object', properties: { exitCode: { type: 'integer' }, output: { type: 'string' } }, required: ['exitCode', 'output'] }
const cronEvent = async (cliArgs, label) => {
  let r = null
  try {
    r = await agent(`
From the repo root run exactly ONE command line:
  bash ${shq(packScript('wolfpack-cron-resume.sh'))} ${cliArgs}
Return exitCode (its real exit code) and output (its last stdout line). Modify nothing else.
`, { label, phase: 'Execute', model: 'sonnet', schema: CRON_EVENT_SCHEMA })
  } catch (e) { log(`⚠ cron event ${label} failed: ${e && e.message}`); return }
  if (!r || r.exitCode !== 0 || /^dropped:|FAILED/.test(String(r.output || ''))) log(`⚠ cron event ${label}: exit ${r ? r.exitCode : 'none'} — ${r ? r.output : 'no result'} (runner continues)`)
}
// End of a chain run → the cron state: completion and "everything waits on a human" disarm
// (with a page); a quota pause tells the cron when to resume; anything else marks the session
// ended so the next tick may relaunch.
const cronFinish = async (res) => {
  const v = String((res && res.verdict) || 'unknown')
  const c = shq(campaignSlug)
  // wave-auto-smoke (AC30/AC35): the release report link rides along as report_url when the
  // post-merge stage built one (the notifier drops anything that is not a meshnet http URL).
  const reportUrl = res && res.stage && typeof res.stage.reportUrl === 'string' && res.stage.reportUrl ? res.stage.reportUrl : null
  const ru = reportUrl ? ` --report-url ${shq(reportUrl)}` : ''
  // Everything merged but a compliance sign-off is still owed: that waits on a human (AC11).
  if (v === 'CAMPAIGN_READY_FOR_RELEASE' && res.pendingComplianceHunts && res.pendingComplianceHunts.length) {
    return cronEvent(`event waiting-on-you --campaign ${c} --status merged_awaiting_compliance${ru}`, 'cron-finish')
  }
  if (v === 'CAMPAIGN_READY_FOR_RELEASE') return cronEvent(`event ready-for-release --campaign ${c}${ru}`, 'cron-finish')
  // A parked post-merge stage waits on a human: one page, with the park code and the report.
  if (v === 'CAMPAIGN_PARKED_STAGE') {
    return cronEvent(`event waiting-on-you --campaign ${c} --status ${shq(`parked:${res.parkReason || 'stage'}`)}${ru}`, 'cron-finish')
  }
  if (v === 'CAMPAIGN_AWAITING_HUMAN' || v === 'CAMPAIGN_PARKED_MAIN_CONFLICT') {
    return cronEvent(`event waiting-on-you --campaign ${c} --status ${shq(v.toLowerCase())}${ru}`, 'cron-finish')
  }
  if (v === 'WAVE_PAUSED_QUOTA' && res.resetAt) return cronEvent(`note-pause --campaign ${c} --reset-at ${shq(res.resetAt)}`, 'cron-finish')
  // The per-run runaway breaker tripped: a relaunch would reset the run budget and defeat it.
  if (v === 'WAVE_PAUSED_BUDGET') return cronEvent(`event waiting-on-you --campaign ${c} --status wave_paused_budget`, 'cron-finish')
  return cronEvent(`note-exit --campaign ${c} --verdict ${shq(v)}`, 'cron-finish')
}

// ─── Post-merge stage relays (wave-auto-smoke; docs/post-merge-stage.md) ───────
// Every stage step runs ONE pack CLI from the main repo root through a sonnet relay that
// returns its stdout VERBATIM; the JSON is parsed HERE (never by the agent), so park/retry
// decisions stay in tested code. Unlike chainCli, a relay never throws: a missing or garbled
// result comes back as {status:'error'} and the stage parks it (stage_cli_error), loudly.
// Long steps (deploy, migrate, ensure, the integration record) use the background rc-file
// relay — twin of hunt-pipeline.js shimRun / SHIM_WAIT_RULE (keep the two in step).
const STAGE_RELAY_SCHEMA = { type: 'object', properties: { exitCode: { type: 'integer' }, output: { type: 'string' } }, required: ['exitCode', 'output'] }
const stageShimRun = (cmd, base) => `( ${cmd} > ${base}.out 2> ${base}.err; echo $? > ${base}.rc ) </dev/null >/dev/null 2>&1 &
       then, in the FOREGROUND, repeat
         timeout 540 bash -c 'until [ -f "$1" ]; do sleep 20; done' _ ${base}.rc
       until ${base}.rc exists (give up after ~90 minutes → this attempt FAILED, evidence "step did not finish").
       The exit code is the content of ${base}.rc; the script's JSON is ${base}.out (stderr: ${base}.err).`
const STAGE_WAIT_RULE = `   WAITING ON A LONG STEP (hard rule): the step stays alive only while YOU keep working. Wait ONLY with
   the foreground \`timeout 540 … until [ -f <rc> ]\` poll above, issued again and again until the rc file
   exists. Do NOT use Monitor, ScheduleWakeup, or the Bash tool's run_in_background, do NOT stop the
   step's task, and NEVER end your turn or reply with a "waiting…" message while it runs.`
async function stageCli(script, cliArgs, label, { long = false } = {}) {
  const cmd = `node ${shq(packScript(script))} ${cliArgs}`
  const safe = String(label).replace(/[^A-Za-z0-9_.-]/g, '_')
  const relayDir = `.wolfpack/campaigns/${campaignSlug}/stage/.relay`
  const base = `${relayDir}/${safe}`
  let r = null
  try {
    r = await agent(long ? `
You RELAY one deterministic post-merge-stage step for campaign ${campaignSlug}. The script does ALL the work —
do NOT run anything else, do NOT edit any file, do NOT retry, do NOT interpret the result.
From the MAIN repo root (the current directory — not a hunt worktree) first run:
  mkdir -p ${shq(relayDir)} && rm -f ${shq(`${base}.out`)} ${shq(`${base}.err`)} ${shq(`${base}.rc`)}
Then run exactly (ONE command line — the step can outlast one shell call, so it runs in the background):
       ${stageShimRun(cmd, shq(base))}
${STAGE_WAIT_RULE}
Return exitCode = the integer content of ${base}.rc and output = the content of ${base}.out VERBATIM.
If the command could not run at all, return exitCode -1 and the error text as output. Never invent a result.
` : `
You RELAY one deterministic post-merge-stage step for campaign ${campaignSlug}. The script does ALL the work —
do NOT run anything else, do NOT edit any file, do NOT retry, do NOT interpret the result.
From the MAIN repo root (the current directory — not a hunt worktree) run exactly ONE command line:
  ${cmd}
Return exitCode = its real exit code and output = its stdout VERBATIM (the JSON it printed).
If the command could not run at all, return exitCode -1 and the error text as output. Never invent a result.
`, { label, phase: 'Execute', model: 'sonnet', schema: STAGE_RELAY_SCHEMA })
  } catch (e) {
    return { status: 'error', reason: `relay ${label} failed: ${(e && e.message) || e}`, exitCode: -1 }
  }
  if (!r) return { status: 'error', reason: `relay ${label} returned no result`, exitCode: -1 }
  let obj = null
  try { const block = firstJsonObject(r.output); obj = block ? JSON.parse(block) : null } catch { obj = null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { status: 'error', reason: `${label}: no parseable JSON (exit ${r.exitCode}): ${String(r.output || '').split('\n')[0].slice(0, 300)}`, exitCode: r.exitCode }
  }
  if (typeof obj.status !== 'string') obj.status = r.exitCode === 0 ? 'ok' : 'error'
  obj.exitCode = r.exitCode
  return obj
}

async function runChain(campaign) {
  // Reverted-dependent guard: `revert` always stamps reverted_because, so a parsed
  // reverted_with_dependency hunt without it means the parse dropped the field. Never "waits".
  const orphan = campaign.waves.flatMap(w => w.hunts)
    .filter(h => h.status === CHAIN_STATUS.REVERTED_WITH_DEP && !(typeof h.revertedBecause === 'string' && h.revertedBecause !== ''))
  if (orphan.length) throw new Error(`REVERTED DEPENDENT WITHOUT reverted_because: ${orphan.map(h => h.slug).join(', ')} — the parse dropped the field (or metadata is corrupt); check .wolfpack/plans/<slug>/metadata.json reverted_because and re-run.`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(campaignSlug || ''))) {
    throw new Error(`campaign-runner: invalid campaign slug ${JSON.stringify(campaignSlug)} for chain mode — must match ^[a-z0-9][a-z0-9-]*$ (it names the branch campaign/<slug>)`)
  }
  const branch = `campaign/${campaignSlug}`
  const chainCap = maxParallel || 1   // chain mode defaults to sequential (max-parallel > 1 is allowed, untested)
  const hunts = []
  for (const w of campaign.waves) for (const h of w.hunts) { h.__wave = w.number; hunts.push(h) }
  const bySlug = new Map(hunts.map(h => [h.slug, h]))
  const graph = {}
  for (const h of hunts) {
    graph[h.slug] = {
      dependsOn: Array.isArray(h.dependsOn) ? h.dependsOn : [],
      migrationApps: Array.isArray(h.migrationApps) ? h.migrationApps : [],
    }
  }
  const status = new Map(hunts.map(h => [h.slug, String(h.status || '')]))   // live, updated as this run progresses
  const revertedBecause = new Map(hunts.map(h => [h.slug, h.revertedBecause || null]))
  const heldOn = new Map(hunts.filter(h => Array.isArray(h.heldOn) && h.heldOn.length).map(h => [h.slug, [...h.heldOn]]))
  const failed = new Set()          // non-certified, non-park results this run — blocked for the rest of the run
  const quotaDeferred = []          // parked:model_quota results this run
  const waiting = new Map()         // slug → { slug, on, rule }
  const cls = (s) => chainClass(status.get(s))
  // The hunts that block `slug`: every blocked/failed hunt except `slug` itself and the
  // reverted dependents waiting on `slug` (reverted_because === slug). Those re-merge only
  // AFTER `slug` is campaign-merged again, so counting them would be a circular wait (A-12).
  const blockersFor = (slug) => hunts
    .filter(h => h.slug !== slug && (isBlockedStatus(status.get(h.slug)) || failed.has(h.slug)))
    .filter(h => !(cls(h.slug) === 'reverted_dep' && revertedBecause.get(h.slug) === slug))
    .map(h => h.slug)
  const depMet = (d) => bySlug.has(d) && isDependencyMet(status.get(d))
  const depsMet = (h) => graph[h.slug].dependsOn.every(depMet)
  const firstUnmetDep = (h) => graph[h.slug].dependsOn.find(d => !depMet(d))
  const reapplyReady = (h) => { const d = revertedBecause.get(h.slug); return !!d && depMet(d) }
  const ruleText = (c) => {
    if (c.rule === 'a') return `depends on blocked ${c.with}${Array.isArray(c.via) && c.via.length > 2 ? ` (via ${c.via.join(' → ')})` : ''}`
    if (c.rule === 'b') return `shares migration app(s) ${(c.apps || []).join(', ')} with blocked ${c.with}`
    if (c.rule === 'c') return `its diff overlaps blocked ${c.with} (${(c.files || []).join(', ')})`
    if (c.rule === 'unknown_dep') return `depends on ${c.with}, which is not a hunt of this campaign (cannot be verified — fix the campaign's "Depends on")`
    return `waits for ${c.with} to be campaign-merged`
  }
  const markWaiting = (slug, c) => {
    const prev = waiting.get(slug)
    waiting.set(slug, { slug, on: c.with, rule: c.rule })
    if (!(prev && prev.on === c.with && prev.rule === c.rule)) log(`  ⏳ ${slug} waits: ${ruleText(c)}`)
  }
  const chainBase = { campaign: campaignSlug, mode: 'chain', branch }
  // Pause returns: a compliance-held certification is still certified (recordResult agrees).
  // The barrier-mode usagePausedReturn is shared and left unchanged (AC1), so chain overrides it.
  const chainCertified = (rs) => rs
    .filter(r => r.verdict === 'CERTIFIED_AWAITING_DEPLOY' || r.verdict === 'CERTIFIED_PENDING_COMPLIANCE').map(r => r.slug)

  log(`⛓ CHAIN MODE: ${campaignSlug} → ${branch} (max-parallel ${chainCap}; no wave barriers — release with /release-campaign ${campaignSlug})`)
  const init = await chainCli(`init --campaign ${shq(campaignSlug)} --graph ${shq(JSON.stringify(graph))}`, 'chain-init')
  log(`Chain branch ${init.status === 'adopted' ? 'adopted' : 'created'}: ${init.branch || branch}${init.sha ? ` @ ${String(init.sha).slice(0, 12)}` : ''}`)

  const mainConflictReturn = (sync, where) => {
    log(``)
    log(`⛔ main → ${branch} merge CONFLICTED (${where}): ${(sync.files || []).join(', ') || '(files not reported)'} — the merge was aborted and nothing was scaffolded.`)
    log(`Resolve it by hand (merge main into ${branch} in a scratch worktree, fix, commit), then re-run the campaign.`)
    return { ...chainBase, completed: false, verdict: 'CAMPAIGN_PARKED_MAIN_CONFLICT', conflictFiles: sync.files || [], at: where }
  }

  const recordResult = (hunt, r) => {
    waiting.delete(hunt.slug)
    if (!r) {
      failed.add(hunt.slug)
      status.set(hunt.slug, 'failed')
      log(`  ✗ ${hunt.slug}: no result — treated as blocked for the rest of this run`)
      return
    }
    log(`  ${r.slug || hunt.slug}: ${r.verdict}`)
    if (r.verdict === 'CERTIFIED_AWAITING_DEPLOY') status.set(hunt.slug, 'certified')
    else if (r.verdict === 'CERTIFIED_PENDING_COMPLIANCE') status.set(hunt.slug, CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE)
    else if (r.verdict === 'PARKED' || r.verdict === 'NEEDS_SPEC') {
      const st = (r.status === 'parked:model_quota' || r.reason === 'model_quota') ? 'parked:model_quota'
        : (r.status || (r.verdict === 'NEEDS_SPEC' ? 'needs_spec' : `parked:${r.reason || 'unknown'}`))
      status.set(hunt.slug, st)
      if (st === 'parked:model_quota') quotaDeferred.push(hunt.slug)
    } else {
      failed.add(hunt.slug)
      status.set(hunt.slug, 'failed')
      log(`  ✗ ${hunt.slug}: ${r.verdict}${r.status ? ` (${r.status})` : ''} — did not certify; treated as blocked for the rest of this run`)
    }
  }

  // campaign-cron-resume (AC11): one `park` page per newly parked hunt. parked:model_quota is
  // transient (it auto-resumes; the cron's own gate defer covers the wait), so it never pages.
  // wave-auto-smoke (AC25): a stage revert's page carries the report link (report_url) and
  // nothing else beyond the allowlisted fields.
  const notifyPark = async (hunt, reportUrl = null) => {
    const st = String(status.get(hunt.slug) || '')
    if (!(st === 'needs_spec' || (st.startsWith('parked:') && st !== 'parked:model_quota'))) return
    const reasonCode = st === 'needs_spec' ? 'needs_spec' : st.slice('parked:'.length)
    await cronEvent(`event park --campaign ${shq(campaignSlug)} --hunt ${shq(hunt.slug)} --status ${shq(st)} --reason ${shq(reasonCode)}${reportUrl ? ` --report-url ${shq(reportUrl)}` : ''}`, `cron-park:${hunt.slug}`)
  }

  // Merge every awaiting-merge hunt (and every reapply-ready reverted dependent) of waves ≤ N,
  // one at a time, dependencies first. Rules a/b first, then rule c (only when blockers exist).
  // Candidates come from the LIVE status map seeded from on-disk status, so a hunt that
  // certified in a crashed run (on disk: certified) is merged here on the next run.
  const mergeStep = async (waveNumber, mergedLog, heldLog) => {
    const overlapChecked = new Set()   // a hold is judged once per merge step
    let progress = true
    while (progress) {
      progress = false
      const cands = hunts.filter(h => h.__wave <= waveNumber && ['awaiting_merge', 'reverted_dep'].includes(cls(h.slug)))
      for (const h of cands) {
        if (overlapChecked.has(h.slug)) continue
        if (cls(h.slug) === 'reverted_dep') {
          if (!reapplyReady(h)) { markWaiting(h.slug, { rule: 'dep', with: revertedBecause.get(h.slug) }); continue }
        } else if (!depsMet(h)) {
          const d = firstUnmetDep(h)
          markWaiting(h.slug, bySlug.has(d) ? { rule: (isBlockedStatus(status.get(d)) || failed.has(d)) ? 'a' : 'dep', with: d } : { rule: 'unknown_dep', with: d })
          continue
        }
        const blockers = blockersFor(h.slug)
        const conf = chainConflicts(h.slug, blockers, graph)
        if (conf.length) { markWaiting(h.slug, conf[0]); continue }
        if (blockers.length) {
          const ov = await chainCli(`overlap --campaign ${shq(campaignSlug)} --hunt ${shq(h.slug)} --blockers ${shq(blockers.join(','))}`, `chain-overlap:${h.slug}`, CHAIN_OVERLAP_SCHEMA)
          overlapChecked.add(h.slug)
          if (Array.isArray(ov.noDiff) && ov.noDiff.length) log(`  ${h.slug}: no diff yet for ${ov.noDiff.join(', ')} — only rules a/b applied against them`)
          if (ov.held === true) {
            const on = Object.keys(ov.overlaps || {})
            heldOn.set(h.slug, on)
            // Same rule as the CLI's on-disk stamp: only HOLDABLE_STATUSES become HELD_OVERLAP.
            if (HOLDABLE_STATUSES.includes(status.get(h.slug))) status.set(h.slug, CHAIN_STATUS.HELD_OVERLAP)
            waiting.delete(h.slug)
            const reHeld = heldLog.includes(h.slug)   // mergeStep runs again after each dependent
            if (!reHeld) heldLog.push(h.slug)
            const files = [...new Set(on.flatMap(b => (ov.overlaps || {})[b] || []))]
            if (!reHeld) log(`  ⏸ ${h.slug}: certified but HELD unmerged — ${ruleText({ rule: 'c', with: on.join(', '), files })}; it merges once ${on.join(', ')} is merged`)
            continue
          }
        }
        const m = await chainCli(`merge-hunt --campaign ${shq(campaignSlug)} --hunt ${shq(h.slug)}`, `chain-merge:${h.slug}`)
        if (m.status === 'merged') {
          status.set(h.slug, m.stamped || CHAIN_STATUS.MERGED)
          heldOn.delete(h.slug)
          waiting.delete(h.slug)
          mergedLog.push(h.slug)
          progress = true
          log(`  ⛓ ${h.slug} → ${branch}${m.commit ? ` (${String(m.commit).slice(0, 12)})` : ''}${m.stamped === CHAIN_STATUS.MERGED_PENDING_COMPLIANCE ? ' — merged, awaiting compliance sign-off at the release' : ''}`)
        } else if (m.status === 'conflict') {
          status.set(h.slug, CHAIN_STATUS.MERGE_CONFLICT)
          waiting.delete(h.slug)
          log(`  ⛔ ${h.slug}: auto-merge into ${branch} CONFLICTED (${m.stage || '?'}: ${(m.files || []).join(', ') || 'files not reported'}) — aborted, ${branch} unchanged; held as ${CHAIN_STATUS.MERGE_CONFLICT} → /resolve ${h.slug}`)
        } else {
          throw new Error(`campaign-runner: chain step chain-merge:${h.slug} returned an unknown status ${JSON.stringify(m.status)}`)
        }
      }
    }
  }

  // ─── Post-merge stage (wave-auto-smoke, plan §7.4–§7.5; operator doc docs/post-merge-stage.md) ───
  // After each wave's merges: deploy the campaign tip to dev from a temp worktree, migrate,
  // ensure the smoke tenants, probe the sessions, run the touched apps' suites on the isolated
  // test DB, smoke every merged [auto] criterion on each smoke tenant, triage (fix ≤2 reviewed
  // rounds / log / block-and-revert), re-verify; one polish wave at campaign end; the release
  // report. Opt-in: wolfpack-config.md → Deployment Notes → Post-merge smoke stage: on. Every
  // decision is made by <pack>/scripts/wolfpack-smoke-stage.mjs; this block only sequences it.
  const stageOn = projectConfig.postMergeStage === true
  const STAGE_STEPS = ['begin', 'deploy', 'migrate', 'ensure', 'session', 'integration', 'smoke', 'triage', 'act', 'done']
  let stageInfo = { lastWave: null, result: null, reportUrl: null, park: null }
  const S = (sub, args, label, opts) => stageCli('wolfpack-smoke-stage.mjs', `${sub} --campaign ${shq(campaignSlug)}${args ? ` ${args}` : ''}`, label, opts)
  const TIER_ORDER = ['Green', 'Blue', 'Yellow', 'Orange', 'Red']
  const stageTier = (slugs) => (slugs || []).map(s => normTier((bySlug.get(s) || {}).tier || 'Blue'))
    .reduce((a, t) => (TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(a) ? t : a), 'Blue')
  const stageReport = async () => {
    const r = await S('report', '', 'stage-report')
    if (r.status !== 'ok') log(`⚠ report: ${r.reason || 'failed'}`)
    else {
      if (r.warning) log(r.warning)
      if (r.report_url) stageInfo.reportUrl = r.report_url
    }
    return stageInfo.reportUrl
  }
  // Park the CAMPAIGN on a stage failure: report first (so the page carries the link), then the
  // CLI records parked:<code> (the relaunch re-arms it), then one CAMPAIGN_PARKED_STAGE return
  // (cronFinish sends the one notification). Every code is in docs/post-merge-stage.md.
  const stagePark = async (code, detail, atStep) => {
    await stageReport()
    const p = await S('park', `--code ${shq(code)} --detail ${shq(String(detail || '').slice(0, 900))}${atStep ? ` --step ${shq(atStep)}` : ''}`, `stage-park:${code}`)
    if (p.status !== 'ok') log(`⚠ post-merge stage: park ${code} not recorded in smoke-stage.json: ${p.reason}`)
    stageInfo = { ...stageInfo, result: `parked:${code}`, park: { code, detail: String(detail || '') } }
    log(``)
    log(`⛔ post-merge stage PARKED: ${code} — ${detail}`)
    log(`   Clear it (docs/post-merge-stage.md → park codes), then re-run the campaign: the relaunch re-arms the stage.`)
    if (stageInfo.reportUrl) log(`Report: ${stageInfo.reportUrl}`)
    return { ...chainBase, completed: false, verdict: 'CAMPAIGN_PARKED_STAGE', parkReason: code, parkDetail: String(detail || ''), stage: { ...stageInfo } }
  }
  // A stage CLI error: a named config problem parks smoke_config_missing; anything else unmapped
  // parks stage_cli_error naming the step — never a silent skip or retry.
  const stageErr = (r, stepLabel, atStep) => (r && r.code === 'smoke_config_missing'
    ? stagePark('smoke_config_missing', `${stepLabel}: ${r.key ? `${r.key} — ` : ''}${r.reason || 'config problem'}${r.detail ? ` (${r.detail})` : ''}`, atStep)
    : stagePark('stage_cli_error', `${stepLabel}: ${(r && r.reason) || 'no result'}`, atStep))
  // AC3: a defer before a Claude-heavy step (smoke, fix round, polish) is the re-runnable pause.
  const stageGate = async (what, waveNumber, slugs) => {
    const tier = stageTier(slugs)
    const g = await usageGate({ slug: `stage:${campaignSlug}:${what}`, tier })
    if (g.decision !== 'defer') return null
    log(`⏸ post-merge stage: usage gate deferred ${what} — state saved; re-run after ${g.reset_at || 'the window resets'}`)
    return {
      ...usagePausedReturn({ slug: `stage:${what}`, tier, reason: g.reason, reset_at: g.reset_at, source: g.source }, [], [], waveNumber),
      mode: 'chain', branch, stage: { ...stageInfo },
    }
  }
  // S4/S-pre: a REFUSED host or hook is a config problem; anything else unreadable is the browser.
  const sessionProblem = (r, atStep) => {
    const probs = Array.isArray(r.problems) ? r.problems : []
    const refused = probs.find(p => p.kind === 'refused')
    if (refused) return stagePark('smoke_config_missing', `Smoke login hook / Deployment Notes → Smoke tenants (${refused.tenant}): ${refused.host} — ${refused.detail}`, atStep)
    const dead = probs.find(p => p.kind !== 'refused')
    if (dead) return stagePark('smoke_browser_unreachable', `${dead.host}: ${dead.detail} — start the Spark smoke Chrome (docs: smoke-on-spark), then re-run the campaign`, atStep)
    return null
  }
  // AC24/AC26: revert a blocked hunt (+ its fix merges, + dependents) out of the campaign branch.
  const stageRevert = async (h, ids, text) => {
    const t = text || {}
    const args = [
      `revert --campaign ${shq(campaignSlug)} --hunt ${shq(h)}`,
      `--reason ${shq(`post-merge stage: ${(ids || []).join(', ') || 'blocked'}`)}`,
      t.summary ? `--summary ${shq(t.summary)}` : '', t.evidence ? `--evidence ${shq(t.evidence)}` : '',
      ids && ids.length ? `--issues ${shq(ids.join(','))}` : '', t.question ? `--question ${shq(t.question)}` : '',
    ].filter(Boolean).join(' ')
    const rv = await stageCli('wolfpack-release.mjs', args, `stage-revert:${h}`)
    if (rv.status !== 'reverted') return stagePark('campaign_revert_failed', `${h}: ${rv.reason || 'revert failed'} — ${branch} unchanged`, 'act')
    status.set(h, CHAIN_STATUS.REVERTED)
    for (const x of (Array.isArray(rv.reverted) ? rv.reverted : [])) {
      if (!x || x.slug === h) continue
      status.set(x.slug, CHAIN_STATUS.REVERTED_WITH_DEP)
      revertedBecause.set(x.slug, h)
    }
    log(`  ↩ ${h} reverted from ${branch}${rv.campaign_sha ? ` (tip ${String(rv.campaign_sha).slice(0, 12)})` : ''}: ${(ids || []).join(', ')}`)
    if (ids && ids.length) {
      const rs = await S('resolve', `--ids ${shq(ids.join(','))} --resolution reverted`, `stage-resolve:${h}`)
      if (rs.status !== 'ok') log(`⚠ post-merge stage: could not mark ${ids.join(', ')} reverted: ${rs.reason}`)
    }
    const url = await stageReport()
    await notifyPark(bySlug.get(h) || { slug: h }, url)
    return null
  }
  const BROWSER_PROBE_SCHEMA = { type: 'object', properties: { available: { type: 'boolean' }, tools_seen: { type: 'array', items: { type: 'string' } }, error: { type: ['string', 'null'] } }, required: ['available'] }
  const SMOKE_AGENT_SCHEMA = { type: 'object', properties: { raw_path: { type: 'string' }, status: { type: 'string' }, note: { type: 'string' } }, required: ['raw_path'] }
  const PLANNER_SCHEMA = { type: 'object', properties: { status: { type: 'string', enum: ['ok', 'error'] }, plan: { type: 'string' }, acceptance: { type: 'string' }, reason: { type: 'string' } }, required: ['status'] }
  const certifiedVerdict = (r) => !!r && ['CERTIFIED_AWAITING_DEPLOY', 'CERTIFIED_PENDING_COMPLIANCE'].includes(r.verdict)
  // The Claude planner that turns a fix round's findings (or the polish items) into a plan that
  // hunt-pipeline starts at Implement. It plans only; Shepherd writes the code.
  const plannerPrompt = (sc, kind) => `
You are the Alpha planner for a post-merge-stage ${kind === 'polish' ? 'POLISH WAVE' : 'FIX ROUND'} of chain campaign ${campaignSlug}
(operator doc: ${wolfpackHome.home}/docs/post-merge-stage.md). Plan only — do NOT edit, stage or commit any source file,
do NOT run tests, do NOT use the browser.
Worktree: ${sc.worktree} (branch ${sc.branch}, forked from the campaign tip ${String(sc.base_sha || '').slice(0, 12)}).
Plan dir: ${sc.plan_dir}
1. Read ${sc.plan_dir}/findings.md (the issue-log entries to fix: ids ${(sc.issues || []).join(', ')}) and ${sc.plan_dir}/metadata.json.
${kind === 'polish'
    ? '2. These are cosmetic/polish items logged across the campaign. Plan ONE change that fixes all of them; never touch the code of a hunt that is reverted or parked.'
    : `2. Read the parent hunt's plan and acceptance: .wolfpack/plans/${sc.parent_hunt}/plan-final.md and acceptance.md (main repo, or the parent's worktree copy). Fix exactly the findings; nothing else.`}
3. Write ${sc.plan_dir}/acceptance.md: a "## Acceptance criteria" section with one "- AC<n> [auto] <text>" line per finding, stating the
   EXPECTED behaviour (from the finding / the parent's acceptance) as a checkable criterion.
4. Write ${sc.plan_dir}/plan-final.md: the files to modify, the exact change per finding, and the test that FAILS before the fix
   (the Tracker writes it). Follow the project's wolfpack-config.md rules. Tests for this hunt run ONLY through the configured
   test command with the campaign's isolated test DB (metadata test_isolation).
Return {status:'ok', plan:<plan-final.md path>, acceptance:<acceptance.md path>}, or {status:'error', reason} if you cannot plan it.`
  const runStagePipeline = async (sc, kind) => {
    const pl = await agent(plannerPrompt(sc, kind), { label: `stage-${kind}-plan:${sc.slug}`, phase: 'Execute', model: 'opus', schema: PLANNER_SCHEMA })
    if (!pl || pl.status !== 'ok') return { ok: false, why: `planner: ${(pl && pl.reason) || 'no result'}` }
    let res = null
    try {
      res = await workflow('hunt-pipeline', {
        slug: sc.slug, description: sc.description, campaign: campaignSlug, tier: sc.tier, mode: 'update',
        crossExaminer: nextCrossExaminer(), baseBranch: branch, testIsolation: campaignSlug,
      })
    } catch (e) { return { ok: false, why: `hunt-pipeline threw: ${(e && e.message) || e}` } }
    if (!certifiedVerdict(res)) return { ok: false, why: res ? `${res.verdict}${res.status ? ` (${res.status})` : ''}` : 'hunt-pipeline returned no result' }
    return { ok: true, res }
  }

  // S0–S9 for one wave (or one polish iteration). Returns null when the stage resolved (green /
  // resolved), else the run's return object (WAVE_PAUSED_QUOTA or CAMPAIGN_PARKED_STAGE).
  const postMergeStage = async (waveNumber, mergedSlugs, opts = {}) => {
    const W = waveNumber
    const beginArgs = opts.polish
      ? `--wave ${W} --polish ${shq(opts.polish)}`
      : `--wave ${W}${mergedSlugs && mergedSlugs.length ? ` --merged ${shq(mergedSlugs.join(','))}` : ''}`
    const b = await S('begin', beginArgs, 'stage-begin')
    if (b.status !== 'ok') return stageErr(b, 'stage-begin', 'begin')
    if (b.action === 'nothing') { log(`post-merge stage: nothing new on ${branch}${b.reason ? ` (${b.reason})` : ''}`); return null }
    stageInfo.lastWave = W
    let step = b.action === 'resume' ? b.step : 'begin'
    let tip = b.campaign_sha
    let iteration = b.iteration
    let polishSlug = b.polish || null
    let polishMerge = b.polish_merge || null
    const polishIssues = Array.isArray(b.polish_issues) ? b.polish_issues : []
    const merged = Array.isArray(b.merged) ? b.merged : (mergedSlugs || [])
    log(`post-merge stage: wave ${W} ${b.action}${b.action === 'resume' ? ` after ${step}` : ''} @ ${String(tip).slice(0, 12)} (iteration ${iteration}${polishSlug ? `, polish ${polishSlug}` : ''})`)
    const past = (s) => STAGE_STEPS.indexOf(step) >= STAGE_STEPS.indexOf(s)
    for (;;) {
      // S-pre: the sessions BEFORE the deploy (first iteration only).
      if (!past('deploy') && iteration === 1) {
        const sb = await S('session', '--when before', 'stage-session:before')
        if (sb.status !== 'ok') return stageErr(sb, 'stage-session:before', 'deploy')
        const sp = sessionProblem(sb, 'deploy'); if (sp) return sp
      }
      // S1 deploy (one retry), S2 migrate (A-18).
      if (!past('deploy')) {
        for (;;) {
          const d = await S('deploy', '', 'stage-deploy', { long: true })
          if (d.status !== 'ok') return stageErr(d, 'stage-deploy', 'deploy')
          if (d.exit === 0) break
          if ((d.attempts || 0) >= 2) return stagePark('dev_deploy_failed', `deploy exited ${d.exit} twice: ${d.last_line || '(no output)'} (log ${d.log})`, 'deploy')
          log(`↻ post-merge stage: deploy failed (exit ${d.exit}: ${d.last_line || '?'}) — retrying once`)
        }
        step = 'deploy'
      }
      let migrateBlocked = false
      if (!past('migrate')) {
        for (;;) {
          const m = await S('migrate', '', 'stage-migrate', { long: true })
          if (m.status !== 'ok') return stageErr(m, 'stage-migrate', 'migrate')
          if (m.exit === 0) break
          if (Array.isArray(m.migrating_hunts) && m.migrating_hunts.length) {
            migrateBlocked = true
            log(`⛔ post-merge stage: migrate failed (exit ${m.exit}) — blocking the migrating hunt(s) ${m.migrating_hunts.join(', ')}; never smoked over`)
            break
          }
          if ((m.attempts || 0) >= 2) return stagePark('dev_deploy_failed', `migrate exited ${m.exit} twice with no migrating hunt in the wave: ${m.last_line || '(no output)'} (log ${m.log})`, 'migrate')
          log(`↻ post-merge stage: migrate failed (exit ${m.exit}: ${m.last_line || '?'}) — retrying once`)
        }
        if (!migrateBlocked) step = 'migrate'
      }
      if (!migrateBlocked) {
        // S3 ensure the smoke tenants (A-11/A-12).
        if (!past('ensure')) {
          const e = await S('ensure-tenants', '', 'stage-ensure-tenants', { long: true })
          if (e.status !== 'ok') return stageErr(e, 'stage-ensure-tenants', 'ensure')
          if (e.exit !== 0) return stagePark('smoke_tenant_ensure_failed', `exit ${e.exit}: ${e.last_line || '(no output)'} (log ${e.log})`, 'ensure')
          for (const n of (e.notices || [])) log(`ℹ post-merge stage notice: ${n.text} (report only)`)
          step = 'ensure'
        }
        // S4 sessions after the deploy (A-15).
        if (!past('session')) {
          const sa = await S('session', '--when after', 'stage-session')
          if (sa.status !== 'ok') return stageErr(sa, 'stage-session', 'session')
          const sp = sessionProblem(sa, 'session'); if (sp) return sp
          if (Array.isArray(sa.session_drops) && sa.session_drops.length) {
            log(`⚠ post-merge stage: signed out after the deploy on ${sa.session_drops.join(', ')} — logged for Cecil (session_drop, prod-relevant); signing in again through the hook`)
          }
          step = 'session'
        }
        // S5 integration suites on the isolated test DB (A-5..A-8, A-17).
        if (!past('integration')) {
          const su = await S('suites', polishSlug ? `--polish ${shq(polishSlug)}` : `--wave ${W}`, 'stage-suites')
          if (su.status !== 'ok') return stageErr(su, 'stage-suites', 'integration')
          if (su.empty) log(`post-merge stage: integration — ${su.reason}; nothing to run`)
          else {
            log(`post-merge stage: integration — ${su.reason}`)
            const recordDir = `${hostRepoRoot}/.wolfpack/campaigns/${campaignSlug}/stage/wave-${W}`
            let infra = 0
            for (;;) {
              const rec = await stageCli('wolfpack-test-record.mjs',
                `run --json --stage integration --record-dir ${shq(recordDir)} --repo ${shq(hostRepoRoot)} --rev ${shq(tip)} --labels ${shq(su.record_labels)} --campaign ${shq(campaignSlug)} --timeout-min 55`,
                'stage-integration', { long: true })
              if (rec.exitCode !== 0 && rec.exitCode !== 2) {
                infra++
                if (infra >= 2) return stagePark('integration_infra', `the integration record failed twice: ${rec.error || rec.reason || `exit ${rec.exitCode}`}`, 'integration')
                log(`↻ post-merge stage: integration record failed (${rec.error || rec.reason || `exit ${rec.exitCode}`}) — retrying once`)
                continue
              }
              const ig = await S('ingest-integration', `--wave ${W}`, 'stage-ingest-integration')
              if (ig.status !== 'ok') return stageErr(ig, 'stage-ingest-integration', 'integration')
              for (const w of (ig.warnings || [])) log(w)
              if (ig.action === 'retake') { log(`↻ post-merge stage: integration ${ig.busy ? `test DB busy — re-taking (${ig.busy_retries})` : `incomplete (${ig.reason || 'infra'}) — retrying once`}`); continue }
              if (ig.action === 'park') {
                if (ig.code === 'integration_unattributed') return stagePark('integration_unattributed', ig.reason, 'integration')
                return stagePark('integration_infra', ig.reason, 'integration')
              }
              log(`post-merge stage: integration ${ig.action === 'pass' ? 'green' : `${ig.findings} finding(s): ${(ig.ids || []).join(', ')}`}`)
              break
            }
          }
          step = 'integration'
        }
        // S6 smoke (A-0, A-16, AC12–AC17).
        if (!past('smoke')) {
          const ps = await S('plan-smoke', `--wave ${W} --sha ${shq(tip)}`, 'stage-plan-smoke')
          if (ps.status !== 'ok') return stageErr(ps, 'stage-plan-smoke', 'smoke')
          const wa = await S('worktree', `add --wave ${W}`, 'stage-worktree-add')
          if (wa.status !== 'ok') return stageErr(wa, 'stage-worktree-add', 'smoke')
          try {
            let raw = ps.raw_exists ? ps.raw_path : null
            if (raw) log(`post-merge stage: a raw results file for ${String(tip).slice(0, 12)} is already there (the /smoke-chain fallback) — ingesting it`)
            for (;;) {
              if (!raw) {
                const gp = await stageGate(`w${W}:smoke`, W, polishSlug ? [] : merged); if (gp) return gp
                const probe = await agent(`
READ-ONLY browser probe for the post-merge stage of campaign ${campaignSlug}. Call the tool mcp__chrome-devtools__list_pages
EXACTLY ONCE (no navigation, no sign-in, no other tool). Return available = true only if that call succeeded,
tools_seen = the mcp__chrome-devtools__* tool names you have, error = the error text or null.
If the tool is not available to you, return {available:false, tools_seen:[…], error:"mcp__chrome-devtools__list_pages not available"}.`,
                  { label: 'stage-browser-probe', phase: 'Execute', model: 'sonnet', schema: BROWSER_PROBE_SCHEMA })
                if (!probe || probe.available !== true) {
                  return stagePark('smoke_browser_unavailable', `${(probe && probe.error) || 'the browser probe returned no result'} — fallback: run /smoke-chain ${campaignSlug} ${W} in the interactive session, then re-run the campaign`, 'smoke')
                }
                const sm = await agent(`
You are the post-merge-stage SMOKE agent for campaign ${campaignSlug}, wave ${W} (iteration ${iteration}).
Read and follow ${wolfpackHome.home}/.agents/commands/smoke-chain.md EXACTLY, with the plan file
  ${ps.plan}
Sign in ONLY through the project's Smoke login hook (the plan's login_hook); never type a password, never read ~/.secrets,
never open file:// or any host not in the plan. You do NOT triage, fix, revert or build the report.
Write the raw results file the command describes to ${ps.raw_path} and return {raw_path: "${ps.raw_path}"}.`,
                  { label: `stage-smoke:w${W}`, phase: 'Execute', model: 'opus', schema: SMOKE_AGENT_SCHEMA })
                raw = sm && typeof sm.raw_path === 'string' && sm.raw_path ? sm.raw_path : null
                if (!raw) {
                  const sf = await S('smoke-failed', `--wave ${W} --reason ${shq('the smoke agent returned no raw results path')}`, 'stage-smoke-failed')
                  if (sf.status !== 'ok') return stageErr(sf, 'stage-smoke-failed', 'smoke')
                  if ((sf.attempts || 0) >= 2) return stagePark('smoke_agent_failed', 'the smoke agent returned no raw results twice', 'smoke')
                  log('↻ post-merge stage: the smoke agent returned no results — running it once more')
                  continue
                }
              }
              const is = await S('ingest-smoke', `--wave ${W} --raw ${shq(raw)}`, 'stage-ingest-smoke')
              if (is.status === 'ok') {
                if (is.warning) log(is.warning)
                log(`post-merge stage: smoke — ${Object.entries(is.verdicts || {}).map(([h, v]) => `${h} ${v}`).join(', ') || 'no criteria'}; ${is.findings} finding(s)`)
                break
              }
              if (is.code === 'smoke_raw_invalid') {
                if ((is.attempts || 0) >= 2) return stagePark('smoke_agent_failed', `the raw results failed validation twice: ${is.reason}`, 'smoke')
                log(`↻ post-merge stage: raw results rejected (${is.reason}) — renamed aside, running the smoke agent once more`)
                raw = null
                continue
              }
              return stageErr(is, 'stage-ingest-smoke', 'smoke')
            }
          } finally {
            const wr = await S('worktree', `remove --wave ${W}`, 'stage-worktree-remove')
            if (wr.status !== 'ok') log(`⚠ post-merge stage: smoke worktree not removed: ${wr.reason}`)
          }
          step = 'smoke'
        }
      }
      // S7 triage (AC18/AC19).
      const tri = await S('triage', `--wave ${W}`, 'stage-triage')
      if (tri.status !== 'ok') return stageErr(tri, 'stage-triage', 'triage')
      step = 'triage'
      for (const x of (tri.classified || [])) log(`  triage ${x.id} ${x.hunt || '(campaign)'}: ${x.outcome} (${x.rule}) — ${x.reasoning}`)
      // Polish iteration (AC27/AC28): a regression reverts the polish merge only.
      if (tri.polish) {
        const pol = tri.polish
        if (Array.isArray(pol.regressions) && pol.regressions.length) {
          const what = pol.regressions.map(r => r.what || r.id).join(', ')
          const rv = await stageCli('wolfpack-release.mjs', `revert-merge --campaign ${shq(campaignSlug)} --commit ${shq(polishMerge)} --reason ${shq(`polish change broke ${what}`)}`, 'stage-revert-polish')
          if (rv.status !== 'reverted') return stagePark('campaign_revert_failed', `polish merge ${String(polishMerge).slice(0, 12)}: ${rv.reason || 'revert failed'} — ${branch} unchanged`, 'act')
          log(`  ↩ polish merge ${String(polishMerge).slice(0, 12)} reverted: it broke ${what}`)
          if (polishIssues.length) await S('resolve', `--ids ${shq(polishIssues.join(','))} --resolution ${shq('needs Cecil')} --reason ${shq(`polish change broke ${what}`)} --polish-slug ${shq(polishSlug)} --polish-result reverted`, 'stage-resolve-polish')
          const it = await S('iterate', '--clear-polish', 'stage-iterate')
          if (it.status !== 'ok') return stageErr(it, 'stage-iterate', 'act')
          iteration = it.iteration; tip = it.campaign_sha; step = 'begin'; polishSlug = null; polishMerge = null
          log(`post-merge stage: re-verify the reverted tip ${String(tip).slice(0, 12)} with the same suite set (iteration ${iteration})`)
          continue
        }
        if (pol.fixed && pol.fixed.length) await S('resolve', `--ids ${shq(pol.fixed.join(','))} --resolution polished --polish-slug ${shq(polishSlug)} --polish-result merged`, 'stage-resolve-polished')
        if (pol.still_failing && pol.still_failing.length) await S('resolve', `--ids ${shq(pol.still_failing.join(','))} --resolution ${shq('needs Cecil')} --reason ${shq('still fails after the polish change')} --polish-slug ${shq(polishSlug)} --polish-result merged`, 'stage-resolve-unpolished')
        const fin = await S('finish', '--result resolved', 'stage-finish')
        if (fin.status !== 'ok') return stageErr(fin, 'stage-finish', 'done')
        stageInfo.result = 'resolved'
        await stageReport()
        log(`post-merge stage: polish ${polishSlug} — ${(pol.fixed || []).length} polished, ${(pol.still_failing || []).length} need Cecil`)
        return null
      }
      if (Array.isArray(tri.campaign_blocks) && tri.campaign_blocks.length) {
        return stagePark('stage_cli_error', `stage-triage: finding(s) ${tri.campaign_blocks.join(', ')} block with no hunt to revert`, 'triage')
      }
      // S8 act: blocks first (newest merge first), then fix rounds (AC21–AC26).
      const pend = tri.pending || { fix: {}, block: {} }
      let changed = false
      const order = (hs) => [...hs].sort((a, b) => merged.indexOf(b) - merged.indexOf(a))
      for (const h of order(Object.keys(pend.block || {}))) {
        if (cls(h) !== 'campaign_merged') { log(`  ${h}: already out of ${branch} (${status.get(h)}) — nothing to revert`); continue }
        const r = await stageRevert(h, pend.block[h], (tri.block_text || {})[h])
        if (r) return r
        changed = true
      }
      for (const h of Object.keys(pend.fix || {})) {
        if (cls(h) !== 'campaign_merged') continue
        const gp = await stageGate(`w${W}:fix:${h}`, W, [h]); if (gp) return gp
        const sc = await S('fix-scaffold', `--hunt ${shq(h)}`, `stage-fix-scaffold:${h}`)
        if (sc.status !== 'ok') return stageErr(sc, `stage-fix-scaffold:${h}`, 'act')
        log(`  🔧 fix round for ${h}: ${sc.slug} (${sc.tier}) from ${branch} @ ${String(sc.base_sha || '').slice(0, 12)} — ${(sc.issues || []).join(', ')}`)
        const run = await runStagePipeline(sc, 'fix')
        if (run.ok) {
          const m = await stageCli('wolfpack-chain.mjs', `merge-hunt --campaign ${shq(campaignSlug)} --hunt ${shq(sc.slug)} --fix-of ${shq(h)}`, `chain-merge:${sc.slug}`)
          if (m.status === 'merged' && m.commit) {
            if (m.warning) log(`⚠ ${m.warning}`)
            const rf = await S('record-fix', `--hunt ${shq(h)} --fix ${shq(sc.slug)} --commit ${shq(m.commit)} --issues ${shq((sc.issues || []).join(','))}`, `stage-record-fix:${sc.slug}`)
            if (rf.status !== 'ok') return stageErr(rf, `stage-record-fix:${sc.slug}`, 'act')
            log(`  ⛓ ${sc.slug} → ${branch} (${String(m.commit).slice(0, 12)}); ${h} fix rounds: ${rf.fix_rounds}`)
            changed = true
            continue
          }
          run.why = `merge-hunt ${m.status}${m.reason ? `: ${m.reason}` : ''}${m.files ? ` (${m.files.join(', ')})` : ''}`
        }
        log(`  ✗ fix round ${sc.slug} did not land: ${run.why} — ${h} blocks (fix_review_failed)`)
        const rc = await S('reclassify', `--hunt ${shq(h)} --rule fix_review_failed --reason ${shq(`${sc.slug}: ${run.why}`)}`, `stage-reclassify:${h}`)
        if (rc.status !== 'ok') return stageErr(rc, `stage-reclassify:${h}`, 'act')
        const r = await stageRevert(h, rc.ids || [], rc.block_text)
        if (r) return r
        changed = true
      }
      if (changed) {
        const it = await S('iterate', '', 'stage-iterate')
        if (it.status !== 'ok') return stageErr(it, 'stage-iterate', 'act')
        iteration = it.iteration; tip = it.campaign_sha; step = 'begin'
        log(`post-merge stage: re-verify ${branch} @ ${String(tip).slice(0, 12)} (iteration ${iteration})`)
        continue
      }
      // `green` = nothing ever failed in this wave's stage run; `resolved` = something failed and was
      // fixed, logged or blocked-and-reverted. A fix round / revert bumps the persisted iteration
      // past 1 (resume-safe), and the re-verify triage is then empty — so look at both.
      const result = ((tri.classified || []).length || iteration > 1) ? 'resolved' : 'green'
      const fin = await S('finish', `--result ${result}`, 'stage-finish')
      if (fin.status !== 'ok') return stageErr(fin, 'stage-finish', 'done')
      stageInfo.result = result
      await stageReport()
      log(`post-merge stage: wave ${W} ${result}${stageInfo.reportUrl ? ` — Report: ${stageInfo.reportUrl}` : ''}`)
      return null
    }
  }

  // Polish wave (AC27/AC28): once, at campaign end, for the open `log` items.
  const runPolish = async (lastWave) => {
    const pp = await S('polish-plan', '', 'stage-polish-plan')
    if (pp.status !== 'ok') return stageErr(pp, 'stage-polish-plan', 'done')
    if (!pp.items || !pp.items.length) { log(`post-merge stage: no polish wave (${pp.reason || 'no open log items'})`); return null }
    const gp = await stageGate('polish', lastWave, []); if (gp) return gp
    const sc = await S('fix-scaffold', '--polish', 'stage-polish-scaffold')
    if (sc.status !== 'ok') return stageErr(sc, 'stage-polish-scaffold', 'done')
    log(`  ✨ polish wave ${sc.slug} (${sc.tier}): ${(sc.issues || []).join(', ')}`)
    const run = await runStagePipeline(sc, 'polish')
    if (run.ok) {
      const m = await stageCli('wolfpack-chain.mjs', `merge-hunt --campaign ${shq(campaignSlug)} --hunt ${shq(sc.slug)} --polish`, `chain-merge:${sc.slug}`)
      if (m.status === 'merged') {
        if (m.warning) log(`⚠ ${m.warning}`)
        log(`  ⛓ ${sc.slug} → ${branch} (${String(m.commit || '').slice(0, 12)}) — redeploy + full re-verify`)
        return postMergeStage(lastWave, [], { polish: sc.slug })
      }
      run.why = `merge-hunt ${m.status}${m.reason ? `: ${m.reason}` : ''}`
    }
    log(`  ✗ polish wave ${sc.slug} did not land: ${run.why} — its items need Cecil`)
    await S('resolve', `--ids ${shq((sc.issues || []).join(','))} --resolution ${shq('needs Cecil')} --reason ${shq(`polish ${sc.slug}: ${run.why}`)} --polish-slug ${shq(sc.slug)} --open-set ${shq(pp.open_set || '')} --polish-result failed`, 'stage-resolve-polish')
    return null
  }

  phase('Execute')

  if (stageOn) {
    // AC13: every stage key present and every target allowed, BEFORE any deploy or browser call.
    const cc = await S('check-config', '', 'stage-check-config')
    if (cc.status !== 'ok') {
      log(`⛔ post-merge stage config: ${cc.reason || 'check-config failed'}`)
      return { ...chainBase, completed: false, verdict: 'CAMPAIGN_PARKED_STAGE', parkReason: 'smoke_config_missing', parkDetail: cc.reason || '', problems: cc.problems || [], stage: { ...stageInfo, result: 'parked:smoke_config_missing' } }
    }
    // Resume / re-arm / reconcile before any wave (AC2).
    const mergedByWave = {}
    for (const h of hunts) if (cls(h.slug) === 'campaign_merged') (mergedByWave[h.__wave] = mergedByWave[h.__wave] || []).push(h.slug)
    const waveNums = campaign.waves.map(w => w.number)
    const nextWave = waveNums.find(n => !(mergedByWave[n] || []).length) ?? (Math.max(0, ...waveNums) + 1)
    const openWaves = campaign.waves.filter(w => w.hunts.some(h => !['campaign_merged', 'released'].includes(cls(h.slug)))).map(w => w.number)
    const rr = await S('begin', `--resume-only --next-wave ${nextWave}${openWaves.length ? ` --open-waves ${shq(openWaves.join(','))}` : ''} --merged-by-wave ${shq(JSON.stringify(mergedByWave))}`, 'stage-begin')
    if (rr.status !== 'ok') return stageErr(rr, 'stage-begin', 'begin')
    if (rr.not_staged_below) log(`post-merge stage: waves < ${rr.not_staged_below} merged before the stage was on; not staged`)
    if (rr.rearmed) log(`post-merge stage: re-armed parked:${rr.rearmed} at ${rr.current ? rr.current.step : '?'}`)
    if (rr.current && rr.current.result == null) {
      const r = await postMergeStage(rr.current.wave, [])
      if (r) return r
    }
    for (const u of (rr.unstaged || [])) {
      log(`post-merge stage: wave ${u.wave} merged without a stage (crash recovery)`)
      const r = await postMergeStage(u.wave, u.merged)
      if (r) return r
    }
  } else {
    log('post-merge stage: off (wolfpack-config.md → Deployment Notes → Post-merge smoke stage)')
  }

  for (const wave of campaign.waves) {
    const pending = wave.hunts.filter(h => ['pending', 'quota'].includes(cls(h.slug)) && !failed.has(h.slug))
    const hasCandidates = hunts.some(h => h.__wave <= wave.number && ['awaiting_merge', 'reverted_dep'].includes(cls(h.slug)))
    if (!pending.length && !hasCandidates) {
      log(`Wave ${wave.number}: nothing to run or merge — skipping`)
      continue
    }
    log(`=== Wave ${wave.number} (chain → ${branch}): ${pending.length} pending ===`)
    const mergedThisWave = []
    const heldThisWave = []
    const waveResults = []

    if (pending.length) {
      // AC7: main is merged in BEFORE anything of this wave is scaffolded.
      const sync = await chainCli(`sync-main --campaign ${shq(campaignSlug)}`, `chain-sync-main:w${wave.number}`)
      if (sync.warning) log(`⚠ ${sync.warning}`)
      if (sync.status === 'conflict') return mainConflictReturn(sync, `wave ${wave.number} start`)
      log(`main → ${branch}: ${sync.status}`)
    }

    // AC9 rules a/b (and unknown dependencies) decide who runs now; rule c is judged at merge time.
    const runnable = []
    for (const h of pending) {
      const unknown = graph[h.slug].dependsOn.find(d => !bySlug.has(d))
      if (unknown) { markWaiting(h.slug, { rule: 'unknown_dep', with: unknown }); continue }
      const conf = chainConflicts(h.slug, blockersFor(h.slug), graph)
      if (conf.length) { markWaiting(h.slug, conf[0]); continue }
      waiting.delete(h.slug)
      runnable.push(h)
    }
    const independent = runnable.filter(depsMet)
    const dependent = runnable.filter(h => !depsMet(h))

    // ─── Independent hunts: rolling worker pool (TWIN of the barrier pool below) ───
    let cursor = 0
    let inFlightReserved = 0
    let budgetPause = null
    let usagePause = null
    let usageGateError = null
    if (independent.length > 0) {
      log(`Wave ${wave.number}: ${independent.length} independent hunts (rolling pool, cap: ${chainCap})`)
      const claimOnce = async () => {
        if (budgetPause || usagePause || usageGateError || cursor >= independent.length) return null
        const hunt = independent[cursor]
        let g
        try { g = await usageGate(hunt) } catch (e) { usageGateError = e; return null }
        if (g.decision === 'defer') {
          usagePause = { slug: hunt.slug, tier: normTier(hunt.tier), reason: g.reason, reset_at: g.reset_at, source: g.source }
          return null
        }
        if (typeof budget !== 'undefined' && budget && budget.total) {
          const need = estimatedHuntCost(hunt.tier) + inFlightReserved
          const have = budget.remaining()
          if (have < need) {
            budgetPause = { need, have, tier: normTier(hunt.tier), slug: hunt.slug }
            return null
          }
        }
        cursor++
        inFlightReserved += estimatedHuntCost(hunt.tier)
        hunt.__usageOffload = g.offload ? { reason: g.offload_reason || g.reason } : null
        return hunt
      }
      let claimChain = Promise.resolve(null)
      const claimNext = () => (claimChain = claimChain.then(claimOnce))
      const worker = async () => {
        for (let hunt = await claimNext(); hunt; hunt = await claimNext()) {
          log(`Wave ${wave.number}: ▶ ${hunt.slug} [${normTier(hunt.tier)}] starting on ${branch}`)
          let result = null
          try {
            result = await workflow('hunt-pipeline', {
              slug: hunt.slug,
              description: hunt.description,
              campaign: campaignSlug,
              tier: hunt.tier,
              mode: hunt.mode,
              ticketRefs: hunt.ticketRefs,
              todoItemsCleared: hunt.todoItemsCleared,
              migrationRisk: hunt.migrationRisk,
              rationale: hunt.rationale,
              crossExaminer: nextCrossExaminer(),
              usageOffload: hunt.__usageOffload || null,
              baseBranch: branch,
            })
          } finally {
            inFlightReserved -= estimatedHuntCost(hunt.tier)
          }
          if (result) waveResults.push(result)
          recordResult(hunt, result)
          await notifyPark(hunt)
        }
      }
      await Promise.all(Array.from({ length: Math.min(chainCap, independent.length) }, () => worker()))
    }

    if (budgetPause) {
      const deferred = independent.slice(cursor).concat(dependent)
      log(``)
      log(`⛔ Budget breaker: ~${budgetPause.have} output tokens left < ~${budgetPause.need} to start ${budgetPause.slug} (${budgetPause.tier}) alongside in-flight work.`)
      log(`Stopping before scaffolding a hunt we can't finish. Deferred ${deferred.length} hunt(s): ${deferred.map(h => h.slug).join(', ')} — re-run to resume mid-chain.`)
      return {
        campaign: campaignSlug,
        completed: false,
        verdict: 'WAVE_PAUSED_BUDGET',
        certifiedHunts: chainCertified(waveResults),
        parkedHunts: [],
        deferredHunts: deferred.map(h => ({ slug: h.slug, tier: h.tier })),
        failedHunts: [],
        completedWave: wave.number,
        budget: { remaining: budgetPause.have, neededForNext: budgetPause.need },
        mode: 'chain',
        branch,
      }
    }
    if (usageGateError) throw usageGateError   // loud, AFTER in-flight hunts finished
    if (usagePause) {
      return { ...usagePausedReturn(usagePause, waveResults, independent.slice(cursor).concat(dependent), wave.number), certifiedHunts: chainCertified(waveResults), mode: 'chain', branch }
    }

    // AC5: merge what certified, BEFORE the dependents (A-14: a same-wave dependent then forks
    // from a branch that already holds its dependency).
    await mergeStep(wave.number, mergedThisWave, heldThisWave)

    // Dependents, one at a time; each is merged right after it certifies.
    for (let di = 0; di < dependent.length; di++) {
      const hunt = dependent[di]
      if (!depsMet(hunt)) {
        const d = firstUnmetDep(hunt)
        markWaiting(hunt.slug, { rule: (isBlockedStatus(status.get(d)) || failed.has(d)) ? 'a' : 'dep', with: d })
        continue
      }
      const conf = chainConflicts(hunt.slug, blockersFor(hunt.slug), graph)   // a dependency may have blocked during this wave
      if (conf.length) { markWaiting(hunt.slug, conf[0]); continue }
      const depShortfall = budgetShortfall(hunt.tier)
      if (depShortfall) {
        const deferred = dependent.slice(di)
        log(``)
        log(`⛔ Budget breaker: ~${depShortfall.have} output tokens left < ~${depShortfall.need} for a ${depShortfall.tier} hunt. Stopping before ${hunt.slug}.`)
        log(`Deferred ${deferred.length} dependent hunt(s): ${deferred.map(h => h.slug).join(', ')} — re-run to resume mid-chain.`)
        return {
          campaign: campaignSlug,
          completed: false,
          verdict: 'WAVE_PAUSED_BUDGET',
          certifiedHunts: chainCertified(waveResults),
          parkedHunts: [],
          deferredHunts: deferred.map(h => ({ slug: h.slug, tier: h.tier })),
          failedHunts: [],
          completedWave: wave.number,
          budget: { remaining: depShortfall.have, neededForNext: depShortfall.need },
          mode: 'chain',
          branch,
        }
      }
      log(`Wave ${wave.number} dependent: ${hunt.slug} (depends on: ${graph[hunt.slug].dependsOn.join(', ')} — all on ${branch})`)
      const depGate = await usageGate(hunt)
      if (depGate.decision === 'defer') {
        return {
          ...usagePausedReturn(
            { slug: hunt.slug, tier: normTier(hunt.tier), reason: depGate.reason, reset_at: depGate.reset_at, source: depGate.source },
            waveResults, dependent.slice(di), wave.number),
          certifiedHunts: chainCertified(waveResults),
          mode: 'chain',
          branch,
        }
      }
      const result = await workflow('hunt-pipeline', {
        slug: hunt.slug,
        description: hunt.description,
        campaign: campaignSlug,
        tier: hunt.tier,
        mode: hunt.mode,
        crossExaminer: nextCrossExaminer(),
        usageOffload: depGate.offload ? { reason: depGate.offload_reason || depGate.reason } : null,
        baseBranch: branch,
      })
      if (result) waveResults.push(result)
      recordResult(hunt, result)
      await notifyPark(hunt)
      await mergeStep(wave.number, mergedThisWave, heldThisWave)
    }

    const waitingNow = [...waiting.values()].filter(w => bySlug.has(w.slug) && bySlug.get(w.slug).__wave <= wave.number).map(w => w.slug)
    log(`Wave ${wave.number} → ${branch}: merged [${mergedThisWave.join(', ')}], held [${heldThisWave.join(', ')}], waiting [${waitingNow.join(', ')}]`)

    // Post-merge stage (AC1/AC4): the next wave starts only after this wave's stage resolved.
    if (stageOn) {
      if (mergedThisWave.length) {
        const r = await postMergeStage(wave.number, mergedThisWave)
        if (r) return r
      } else log(`post-merge stage: nothing new on ${branch}`)
    }
  }

  // ─── End state (AC13) ───
  // A function: the polish wave (wave-auto-smoke) can revert hunts, so it is computed again after it.
  const computeEnd = () => {
    const campaignMergedHunts = hunts.filter(h => cls(h.slug) === 'campaign_merged').map(h => h.slug)
    const pendingComplianceHunts = hunts.filter(h => status.get(h.slug) === CHAIN_STATUS.MERGED_PENDING_COMPLIANCE).map(h => h.slug)
    const heldHunts = hunts
      .filter(h => cls(h.slug) === 'awaiting_merge' && (status.get(h.slug) === CHAIN_STATUS.HELD_OVERLAP || (heldOn.get(h.slug) || []).length))
      .map(h => ({ slug: h.slug, status: status.get(h.slug), heldOn: heldOn.get(h.slug) || [] }))
    const waitingHunts = [...waiting.values()]
    const waitersOf = (b) => waitingHunts.filter(w => w.on === b).map(w => w.slug)
    const resolveFor = (h) => {
      const st = status.get(h.slug)
      if (st === 'needs_spec') return `/spec ${h.slug}`
      if (st === CHAIN_STATUS.REVERTED_WITH_DEP) return `auto: re-merges after ${revertedBecause.get(h.slug)}`
      return `/resolve ${h.slug}`
    }
    const blockedHunts = hunts.filter(h => isBlockedStatus(status.get(h.slug)))
      .map(h => ({ slug: h.slug, status: status.get(h.slug), resolve: resolveFor(h), waiting: waitersOf(h.slug) }))
    const failedHunts = [...failed]
    const unaccounted = hunts.filter(h => !['released', 'campaign_merged'].includes(cls(h.slug)) &&
      !blockedHunts.some(b => b.slug === h.slug) && !heldHunts.some(x => x.slug === h.slug) &&
      !waiting.has(h.slug) && !failed.has(h.slug) && !quotaDeferred.includes(h.slug)).map(h => ({ slug: h.slug, status: status.get(h.slug) }))

    // Precedence: any quota result → WAVE_PAUSED_QUOTA (auto-resumes; the human lists still return);
    // else anything blocked/waiting/held/failed/unexplained → CAMPAIGN_AWAITING_HUMAN; else every
    // hunt is released or campaign-merged → CAMPAIGN_READY_FOR_RELEASE.
    let verdict
    if (quotaDeferred.length) verdict = 'WAVE_PAUSED_QUOTA'
    else if (blockedHunts.length || waitingHunts.length || heldHunts.length || failedHunts.length || unaccounted.length) verdict = 'CAMPAIGN_AWAITING_HUMAN'
    else verdict = 'CAMPAIGN_READY_FOR_RELEASE'
    return { campaignMergedHunts, pendingComplianceHunts, heldHunts, waitingHunts, waitersOf, resolveFor, blockedHunts, failedHunts, unaccounted, verdict }
  }
  let { campaignMergedHunts, pendingComplianceHunts, heldHunts, waitingHunts, blockedHunts, failedHunts, unaccounted, verdict } = computeEnd()
  // Polish wave + release report (wave-auto-smoke AC27–AC30): once, when the campaign is done or
  // only waits on a human — never on a quota pause (it would resume and run it then).
  if (stageOn && ['CAMPAIGN_READY_FOR_RELEASE', 'CAMPAIGN_AWAITING_HUMAN'].includes(verdict)) {
    const lastWave = stageInfo.lastWave || (campaign.waves.length ? campaign.waves[campaign.waves.length - 1].number : 1)
    const pr = await runPolish(lastWave)
    if (pr) return pr
    ;({ campaignMergedHunts, pendingComplianceHunts, heldHunts, waitingHunts, blockedHunts, failedHunts, unaccounted, verdict } = computeEnd())
  }

  if (verdict === 'CAMPAIGN_READY_FOR_RELEASE') {
    // Reconcile a main that advanced after the last wave start (always; the CLI no-ops when
    // main is already an ancestor), so /release-campaign's main_not_merged check never dead-ends.
    const sync = await chainCli(`sync-main --campaign ${shq(campaignSlug)}`, 'chain-sync-main:final')
    if (sync.warning) log(`⚠ ${sync.warning}`)
    if (sync.status === 'conflict') return mainConflictReturn(sync, 'final sync before release')
    log(`main → ${branch}: ${sync.status}`)
  }
  // S9: the campaign release report (fail soft: a broken report never blocks the verdict).
  if (stageOn && verdict !== 'WAVE_PAUSED_QUOTA') await stageReport()

  log(``)
  log(`=== Chain campaign ${campaignSlug} → ${branch}: ${campaignMergedHunts.length} campaign-merged (${pendingComplianceHunts.length} awaiting compliance sign-off), ${heldHunts.length} held, ${blockedHunts.length} blocked, ${waitingHunts.length} waiting, ${failedHunts.length} failed, ${quotaDeferred.length} quota-deferred ===`)
  if (quotaDeferred.length) {
    log(`These hunts hit MODEL QUOTA — transient, NO action needed; re-run the campaign once the window frees: ${quotaDeferred.join(', ')}`)
  }
  for (const b of blockedHunts) {
    log(`  ⛔ ${b.slug} [${b.status}]  →  ${b.resolve}${b.waiting.length ? `   (waiting on it: ${b.waiting.join(', ')})` : ''}`)
  }
  for (const x of heldHunts) {
    log(`  ⏸ ${x.slug} [${x.status}] held — overlaps ${x.heldOn.join(', ') || 'a blocked hunt'}; merges once that is merged`)
  }
  for (const w of waitingHunts.filter(w => !blockedHunts.some(b => b.slug === w.on))) {
    log(`  ⏳ ${w.slug} waits: ${ruleText({ rule: w.rule, with: w.on })}`)
  }
  for (const f of failedHunts) log(`  ✗ ${f}: did not certify — inspect .wolfpack/plans/${f}/ before re-running`)
  for (const u of unaccounted) log(`  ? ${u.slug} [${u.status}] — not runnable and not explained; inspect it`)
  if (verdict === 'CAMPAIGN_READY_FOR_RELEASE') {
    log(`Every hunt is campaign-merged. Release it: /release-campaign ${campaignSlug}   (one deploy, Red sign-offs, one version, one --no-ff merge into main + one tag; never pushes)`)
  } else if (verdict === 'CAMPAIGN_AWAITING_HUMAN') {
    log(`Answer the blocked hunts above, then re-run the campaign. To ship what is already merged now: /release-campaign ${campaignSlug} --checkpoint`)
  }
  if (stageOn) {
    if (stageInfo.park) log(`  post-merge stage: ${stageInfo.result} — ${stageInfo.park.detail}`)
    if (stageInfo.reportUrl) log(`Report: ${stageInfo.reportUrl}`)
  }

  return {
    ...chainBase,
    completed: verdict === 'CAMPAIGN_READY_FOR_RELEASE',
    verdict,
    campaignMergedHunts,
    pendingComplianceHunts,
    heldHunts,
    blockedHunts,
    waitingHunts,
    failedHunts,
    quotaDeferredHunts: [...quotaDeferred],
    ...(unaccounted.length ? { unaccounted } : {}),
    ...(stageOn ? { stage: { ...stageInfo } } : {}),
  }
}

// ─── Mode dispatch: chain (runChain above) vs barrier (below, unchanged) ───
const chainMode = chainArg === true || campaign.chainMode === true
if (!chainMode) {                                   // consistency guard: chain state on disk ⇒ never barrier
  const CHAIN_VALUES = Object.values(CHAIN_STATUS)
  const stray = campaign.waves.flatMap(w => w.hunts)
    .filter(h => CHAIN_VALUES.includes(h.status) || (typeof h.baseBranch === 'string' && h.baseBranch !== ''))
  const chainBlock = typeof campaign.chainBranch === 'string' && campaign.chainBranch !== ''   // campaign-level chain block (crash after chain-init, before any scaffold)
  if (stray.length || chainBlock) throw new Error(`CHAIN STATE WITHOUT CHAIN MODE: ${campaignSlug} has ${chainBlock ? `a chain block (${campaign.chainBranch}) and ` : ''}chain-mode hunts (${stray.map(h => `${h.slug}=${h.status}${h.baseBranch ? `@${h.baseBranch}` : ''}`).join(', ') || 'none'}) but the parse reported chainMode=${campaign.chainMode} — refusing to run barrier mode over a chain campaign. Re-run with --chain (and check .wolfpack/campaigns/${campaignSlug}/metadata.json chain.mode).`)
}
if (campaign.chainMode === true && chainArg !== true) log(`⚠ CHAIN MODE (sticky): ${campaignSlug} was started with --chain — continuing in chain mode on ${campaign.chainBranch || `campaign/${campaignSlug}`}. Pass --chain to silence this.`)
if (chainMode) {
  // Fail closed on a missing field: a stale runtime hunt-pipeline would fork hunts from `main`
  // and rebase them onto origin/main — silently wrong for a chain campaign.
  const ccap = chainCapability || {}
  if (!(Number(ccap.chainProtocol) >= 1)) {
    throw new Error(`campaign-runner: STALE PIPELINE for chain mode — the runtime hunt-pipeline (${ccap.path || 'not found'}) reports chain protocol ${Number(ccap.chainProtocol) || 0} < 1 (no WOLFPACK_CHAIN_PROTOCOL marker), so its hunts would fork from main and rebase onto origin/main. Regenerate it: bash '${wolfpackHome.home}/install.sh' --consumer <this repo> (then restart Claude Code), then relaunch.`)
  }
  if (ccap.chainScriptPresent !== true) {
    throw new Error(`campaign-runner: ${packScript('wolfpack-chain.mjs')} is MISSING (or the probe could not confirm it) — chain mode cannot run its git steps. Fix: point WOLFPACK_HOME / Wolfpack home at an up-to-date wolfpack checkout, then relaunch.`)
  }
  let chainResult
  try { chainResult = await runChain(campaign) }   // the barrier loop below is byte-identical to today
  catch (e) { await cronEvent(`note-exit --campaign ${shq(campaignSlug)} --verdict error`, 'cron-exit:error'); throw e }
  await cronFinish(chainResult)
  return { ...chainResult, unattended }
}

// ─── Phase: Execute Waves ──────────────────────────────────────
phase('Execute')

for (const wave of campaign.waves) {
  log(`=== Wave ${wave.number}: ${wave.hunts.length} hunts ===`)

  // Filter out already-completed AND human-gated hunts. The parse agent tags done
  // hunts as "merged" / "certified_not_merged"; every other status
  // (ready_for_alpha, reviewing, reviewed, …) is mid-pipeline and resumable, so it
  // must run. [02] EXCEPTION: a hunt awaiting a human — status "needs_spec" (Spec
  // parked it) or "parked:<reason>" (the pipeline parked it) — is NOT actionable on
  // cron. The driver only touches `ready`/in-flight hunts; the human touches the
  // parked ones (via /resolve), which flips the status back to a resumable rung for
  // the NEXT pass. Skipping them here is what makes "you resolve; cron resumes" work.
  // [05] AC3 — `parked:model_quota` is the ONE park that is NOT human-gated: it means
  // both cross-models were rate-limited, which is transient. The driver re-runs it on
  // the next pass (the host window gate + the shims' per-model cooldown handle the
  // timing), and hunt-pipeline's resume probe resumes it from its park.resume_phase.
  // Every other parked:<reason> still awaits a human /resolve.
  // A hunt is "done" (never re-run) when its status is a TERMINAL value the pipeline
  // itself stamps on disk — NOT something we re-derive from git every pass. `merged` is
  // stamped by /merge + /merge-wave at copy-back (authoritative: the hunt shipped).
  // `certified` / `certified_not_merged` mean Watchdog PASS but not yet merged — also NOT
  // runnable (they await the user's /merge-wave); just not shipped. Including raw
  // `certified` here is the durable fix for the recurring divergence: a certified-but-
  // unmerged hunt reads `certified` on disk (NOT the parse-agent's derived
  // `certified_not_merged`), so without it the hunt fell through to `pending` and got re-run.
  const DONE_STATUSES = ['merged', 'certified', 'certified_not_merged']
  const isQuotaPark = (s) => s === 'parked:model_quota'
  const isHumanGated = (s) => typeof s === 'string' && !isQuotaPark(s) && (s === 'needs_spec' || s.startsWith('parked:'))
  const pending = wave.hunts.filter(h => !DONE_STATUSES.includes(h.status) && !isHumanGated(h.status))
  const parked = wave.hunts.filter(h => isHumanGated(h.status))

  if (parked.length > 0) {
    log(`Wave ${wave.number}: ${parked.length} hunt(s) awaiting a human (run /parked to see them): ${parked.map(h => `${h.slug} [${h.status}]`).join(', ')}`)
  }

  if (pending.length === 0) {
    // [02] If the wave's only remaining work is PARKED (not merged/blocked), do NOT
    // `continue` into the next wave — those hunts await /resolve and the next wave may
    // depend on them; bleeding forward would branch dependents off stale main and
    // stack reviews. Stop at the barrier and report. A wave that is genuinely all-done
    // (everything merged/blocked, nothing parked) still skips forward as before.
    if (parked.length > 0) {
      log(`Wave ${wave.number}: all remaining hunts are parked — stopping at the wave barrier (answer them with /resolve, then re-run the campaign).`)
      return {
        campaign: campaignSlug,
        completed: false,
        verdict: 'WAVE_AWAITING_HUMAN',
        certifiedHunts: [],
        parkedHunts: parked.map(h => ({ slug: h.slug, status: h.status })),
        failedHunts: [],
        completedWave: wave.number,
      }
    }
    log(`Wave ${wave.number}: all hunts complete or blocked, skipping`)
    continue
  }

  log(`Wave ${wave.number}: ${pending.length} pending (${wave.hunts.length - pending.length} already complete or parked)`)

  // Every hunt result for THIS wave (certified or failed) — drives the wave barrier below.
  const waveResults = []

  // A declared dependency only forces SEQUENTIAL handling when it is still UNMET for
  // this run. A dep is unmet if it is another hunt still PENDING in THIS wave (genuine
  // intra-wave ordering), OR a cross-wave dep not yet MERGED to main (running would
  // branch off stale main). A dep already merged by an EARLIER wave — e.g. a Wave-1
  // foundation every Wave-2 hunt consumes — is satisfied by wave ordering, so the hunt
  // belongs in the parallel rolling pool, NOT the sequential path. Before this check,
  // ANY non-empty `dependsOn` shunted a hunt to the sequential loop, so every
  // multi-wave campaign whose later hunts depend on an earlier (already-shipped) hunt
  // silently serialized despite `maxParallel`.
  const pendingSlugs = new Set(pending.map(h => h.slug))
  const inWaveDeps = (h) => (h.dependsOn || []).filter(d => pendingSlugs.has(d))
  const crossWaveDeps = (h) => (h.dependsOn || []).filter(d => !pendingSlugs.has(d))

  // Verify cross-wave deps are MERGED before promoting their dependents into the
  // parallel pool — the pool, unlike the sequential loop below, does NOT merge-gate.
  // One batched check over the union of cross-wave dep slugs (cheap, and it replaces
  // the per-hunt sequential dep-checks for the merged ones). Fail-safe: any dep we
  // cannot confirm merged keeps its hunt on the sequential path, which re-checks and
  // BLOCKs it. Skip the agent entirely when there are no cross-wave deps.
  const crossDepSlugs = [...new Set(pending.flatMap(h => crossWaveDeps(h)))]
  let mergedCrossDeps = new Set()
  if (crossDepSlugs.length > 0) {
    const merged = await agent(`
For each of these dependency slugs, determine if it is MERGED to main (not just certified).
Slugs: ${crossDepSlugs.join(', ')}

For each slug:
1. Read .wolfpack/plans/<slug>/metadata.json — check its status field.
2. Check if branch feat/<slug> still exists: git branch --list feat/<slug>
3. Check if its merge commit is on main: git log --oneline main | grep -i <slug> | head -1

A slug is MERGED if: metadata status is "merged", OR (status "certified" AND feat/<slug> is gone), OR its merge commit appears on main.

Return { merged: ["slug", ...] } listing ONLY the slugs you confirmed merged.
`, { label: 'crosswave-dep-check', phase: 'Execute', schema: {
      type: 'object',
      properties: { merged: { type: 'array', items: { type: 'string' } } },
      required: ['merged'],
    }})
    mergedCrossDeps = new Set(merged.merged || [])
  }

  // Unmet ⇒ sequential. A hunt is unmet if it has any in-wave pending dep, or any
  // cross-wave dep not confirmed merged. Everything else runs in the parallel pool.
  const isUnmet = (h) =>
    inWaveDeps(h).length > 0 ||
    crossWaveDeps(h).some(d => !mergedCrossDeps.has(d))
  const independent = pending.filter(h => !isUnmet(h))
  const dependent = pending.filter(h => isUnmet(h))

  // ─── Independent hunts: rolling worker pool [Fix 1] ──────────
  // REPLACES the old fixed batch barrier (`for i += cap { await parallel(slice) }`).
  // That barrier wasted a freed slot until its WHOLE slice finished: when one hunt
  // parked early, its slot sat idle until its slice-mate also terminated. This pool
  // keeps exactly `parallelCap` hunts in flight — each worker pulls the NEXT pending
  // hunt the instant its current one finishes OR parks, so a park frees its slot
  // immediately. The only barrier left in the wave is the wave barrier below.
  let cursor = 0                 // next independent hunt to claim
  let inFlightReserved = 0       // Σ estimated cost of hunts currently running
  let budgetPause = null         // set to a shortfall once the breaker trips
  let usagePause = null          // set once the usage gate defers (usage-limit-gate AC5)
  let usageGateError = null      // a gate FAILURE: stop claiming, let in-flight finish, then throw
  if (independent.length > 0) {
    log(`Wave ${wave.number}: ${independent.length} independent hunts (rolling pool, cap: ${parallelCap})`)

    // Claim the next hunt SYNCHRONOUSLY so two workers never grab the same one or
    // race the budget reservation. [05] AC1 — budget breaker: don't START a hunt we
    // can't afford to FINISH alongside everything already in flight. We reserve the
    // FULL per-tier estimate at claim and release it at completion; gating on
    // (this hunt + in-flight reserved) preserves the old batch-sum guarantee.
    // budget.remaining() already reflects in-flight ACTUAL spend, so adding the full
    // reserve slightly OVER-reserves — the safe direction per the fail-loud A4 rule.
    // budget.total falsy ⇒ breaker disabled (only a deliberately budgeted run gates).
    //
    // usage-limit-gate: the claim now awaits the usage gate, so it is ASYNC — and
    // SERIALISED through claimChain, so two workers still never interleave a claim (the
    // cursor/reservation stay race-free exactly as before).
    const claimOnce = async () => {
      if (budgetPause || usagePause || usageGateError || cursor >= independent.length) return null
      const hunt = independent[cursor]
      let g
      try { g = await usageGate(hunt) } catch (e) { usageGateError = e; return null }
      if (g.decision === 'defer') {
        usagePause = { slug: hunt.slug, tier: normTier(hunt.tier), reason: g.reason, reset_at: g.reset_at, source: g.source }
        return null
      }
      if (typeof budget !== 'undefined' && budget && budget.total) {
        const need = estimatedHuntCost(hunt.tier) + inFlightReserved
        const have = budget.remaining()
        if (have < need) {
          budgetPause = { need, have, tier: normTier(hunt.tier), slug: hunt.slug }
          return null
        }
      }
      cursor++
      inFlightReserved += estimatedHuntCost(hunt.tier)
      hunt.__usageOffload = g.offload ? { reason: g.offload_reason || g.reason } : null
      return hunt
    }
    let claimChain = Promise.resolve(null)
    const claimNext = () => (claimChain = claimChain.then(claimOnce))

    // Each worker drains the shared queue; a finished/parked hunt immediately frees
    // the worker to claim the next one. Release the budget reserve in `finally` so a
    // thrown hunt-pipeline can't leak a reservation and wedge the breaker.
    const worker = async () => {
      for (let hunt = await claimNext(); hunt; hunt = await claimNext()) {
        log(`Wave ${wave.number}: ▶ ${hunt.slug} [${normTier(hunt.tier)}] starting`)
        let result = null
        try {
          result = await workflow('hunt-pipeline', {
            slug: hunt.slug,
            description: hunt.description,
            campaign: campaignSlug,
            tier: hunt.tier,
            mode: hunt.mode,
            ticketRefs: hunt.ticketRefs,
            todoItemsCleared: hunt.todoItemsCleared,
            migrationRisk: hunt.migrationRisk,
            rationale: hunt.rationale,
            crossExaminer: nextCrossExaminer(),
            usageOffload: hunt.__usageOffload || null,
          })
        } finally {
          inFlightReserved -= estimatedHuntCost(hunt.tier)
        }
        if (result) {
          log(`  ${result.slug}: ${result.verdict}`)
          waveResults.push(result)
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(parallelCap, independent.length) }, () => worker())
    )
  }

  // [05] AC1 — if the breaker tripped mid-pool, the hunts ALREADY in flight were left
  // to FINISH (better than stranding them half-built at the ceiling), but we do NOT
  // start the deferred independents or any dependents. `cursor` points at the hunt we
  // couldn't afford, so slice(cursor) is exactly the un-started tail.
  if (budgetPause) {
    const deferred = independent.slice(cursor).concat(dependent)
    log(``)
    log(`⛔ Budget breaker: ~${budgetPause.have} output tokens left < ~${budgetPause.need} to start ${budgetPause.slug} (${budgetPause.tier}) alongside in-flight work.`)
    log(`Stopping before scaffolding a hunt we can't finish. Deferred ${deferred.length} hunt(s): ${deferred.map(h => h.slug).join(', ')}`)
    log(`Re-run with a fresh budget (or after the window resets) to resume.`)
    return {
      campaign: campaignSlug,
      completed: false,
      verdict: 'WAVE_PAUSED_BUDGET',
      certifiedHunts: waveResults.filter(r => r.verdict === 'CERTIFIED_AWAITING_DEPLOY').map(r => r.slug),
      parkedHunts: [],
      deferredHunts: deferred.map(h => ({ slug: h.slug, tier: h.tier })),
      failedHunts: [],
      completedWave: wave.number,
      budget: { remaining: budgetPause.have, neededForNext: budgetPause.need },
    }
  }

  // usage-limit-gate (AC5): the usage gate deferred mid-pool. Same shape as the budget
  // pause: in-flight hunts already FINISHED (Promise.all above); the un-started tail and
  // every dependent are deferred; nothing is half-started.
  if (usageGateError) throw usageGateError   // loud, AFTER in-flight hunts finished
  if (usagePause) {
    return usagePausedReturn(usagePause, waveResults, independent.slice(cursor).concat(dependent), wave.number)
  }

  // Run dependent hunts — but ONLY if their dependencies are MERGED to main.
  // CERTIFIED_AWAITING_DEPLOY is NOT sufficient — the dependency's code isn't on main yet,
  // so the dependent hunt would branch from stale main and miss the changes.
  for (let di = 0; di < dependent.length; di++) {
    const hunt = dependent[di]

    // [05] AC1 — budget breaker before each dependent hunt too.
    const depShortfall = budgetShortfall(hunt.tier)
    if (depShortfall) {
      const deferred = dependent.slice(di)
      log(``)
      log(`⛔ Budget breaker: ~${depShortfall.have} output tokens left < ~${depShortfall.need} for a ${depShortfall.tier} hunt. Stopping before ${hunt.slug}.`)
      log(`Deferred ${deferred.length} dependent hunt(s): ${deferred.map(h => h.slug).join(', ')}`)
      return {
        campaign: campaignSlug,
        completed: false,
        verdict: 'WAVE_PAUSED_BUDGET',
        certifiedHunts: waveResults.filter(r => r.verdict === 'CERTIFIED_AWAITING_DEPLOY').map(r => r.slug),
        parkedHunts: [],
        deferredHunts: deferred.map(h => ({ slug: h.slug, tier: h.tier })),
        failedHunts: [],
        completedWave: wave.number,
        budget: { remaining: depShortfall.have, neededForNext: depShortfall.need },
      }
    }

    log(`Wave ${wave.number} dependent: ${hunt.slug} (depends on: ${hunt.dependsOn.join(', ')})`)

    const depCheck = await agent(`
Check if all dependencies for hunt "${hunt.slug}" are MERGED to main (not just certified).
Dependencies: ${hunt.dependsOn.join(', ')}

For each dependency slug:
1. Read .wolfpack/plans/<slug>/metadata.json — check status
2. Check if branch feat/<slug> still exists: git branch --list feat/<slug>
3. Check if the merge commit is on main: git log --oneline main | grep -i <slug> | head -1

A dependency is "merged" if:
- metadata status is "certified" AND the feat/<slug> branch no longer exists (was cleaned up after merge)
- OR the merge commit appears in main's log

A dependency is "certified but not merged" if:
- metadata status is "certified" but feat/<slug> still exists

Return { allMerged: true/false, notMerged: ["slug1", ...], certified: ["slug1", ...] }
`, { label: `dep-check:${hunt.slug}`, schema: {
      type: 'object',
      properties: {
        allMerged: { type: 'boolean' },
        notMerged: { type: 'array', items: { type: 'string' } },
        certified: { type: 'array', items: { type: 'string' } },
      },
      required: ['allMerged'],
    }})

    if (!depCheck.allMerged) {
      const notMergedList = depCheck.notMerged?.join(', ') || 'unknown'
      const certifiedList = depCheck.certified?.join(', ') || ''
      if (certifiedList) {
        log(`BLOCKED: ${hunt.slug} depends on ${notMergedList} which are certified but NOT merged to main.`)
        log(`  User must deploy + smoke + /merge these hunts first: ${notMergedList}`)
      } else {
        log(`BLOCKED: ${hunt.slug} depends on ${notMergedList} which are not yet certified.`)
      }
      continue
    }

    // usage-limit-gate (AC5): gate the dependent hunt too, right before it would start.
    const depGate = await usageGate(hunt)
    if (depGate.decision === 'defer') {
      return usagePausedReturn(
        { slug: hunt.slug, tier: normTier(hunt.tier), reason: depGate.reason, reset_at: depGate.reset_at, source: depGate.source },
        waveResults, dependent.slice(di), wave.number)
    }

    const result = await workflow('hunt-pipeline', {
      slug: hunt.slug,
      description: hunt.description,
      campaign: campaignSlug,
      tier: hunt.tier,
      mode: hunt.mode,
      crossExaminer: nextCrossExaminer(),
      usageOffload: depGate.offload ? { reason: depGate.offload_reason || depGate.reason } : null,
    })

    if (result) {
      log(`${hunt.slug}: ${result.verdict}`)
      waveResults.push(result)
    }
  }

  log(`Wave ${wave.number} development complete`)

  // ─── Wave barrier (HARD STOP) ────────────────────────────────
  // Merge + deploy + smoke are MANUAL user steps. The pipeline therefore stops
  // at EVERY wave boundary that had pending work — it must never bleed into the
  // next wave's hunts (that scaffolds work the user can't yet act on, wastes
  // tokens, and stacks reviews on the same model). We pause whether the wave
  // fully certified, partly failed, or wholly failed, and report the state.
  const certifiedThisWave = waveResults
    .filter(r => r.verdict === 'CERTIFIED_AWAITING_DEPLOY')
    .map(r => r.slug)
  // [02] A hunt that PARKED (verdict PARKED / NEEDS_SPEC) is awaiting a human, NOT
  // failed — surface it as its own bucket pointing at /resolve, separate from the
  // genuinely-broken hunts the user must inspect.
  // [05] AC3 — `parked:model_quota` is the exception: transient, auto-resumable, NOT a
  // human park. It gets its OWN bucket (quotaDeferredThisWave) so the headline verdict
  // is a re-runnable WAVE_PAUSED_QUOTA (the driver loops + the window gate waits), never
  // a WAVE_AWAITING_HUMAN that would strand it on a /resolve nobody needs to run.
  const isQuotaResult = (r) => r.verdict === 'PARKED' && (r.reason === 'model_quota' || r.status === 'parked:model_quota')
  const quotaDeferredThisWave = waveResults.filter(isQuotaResult)
  // [04] AC4 — a hunt parked for `compliance_review` is CERTIFIED-but-held: it is
  // excluded from the release queue until /resolve signs it off. Split it out of
  // the generic human-park bucket so the release report shows "awaiting sign-off"
  // (not lumped with open_critical/non_convergence breakage), and so /merge-wave
  // never sweeps it in. It still belongs to a human (run /resolve), so it is NOT
  // in the release sequence.
  const isComplianceReviewResult = (r) =>
    r.verdict === 'PARKED' && (r.reason === 'compliance_review' || r.status === 'parked:compliance_review')
  const complianceReviewThisWave = waveResults.filter(isComplianceReviewResult)
  const parkedThisWave = waveResults.filter(r =>
    !isQuotaResult(r) && !isComplianceReviewResult(r) && (r.verdict === 'PARKED' || r.verdict === 'NEEDS_SPEC'))
  const failedThisWave = waveResults.filter(r =>
    r.verdict !== 'CERTIFIED_AWAITING_DEPLOY' && r.verdict !== 'PARKED' && r.verdict !== 'NEEDS_SPEC')

  log(``)
  log(`=== Wave ${wave.number} barrier: ${certifiedThisWave.length} certified, ${complianceReviewThisWave.length} awaiting compliance sign-off, ${parkedThisWave.length} parked, ${quotaDeferredThisWave.length} quota-deferred, ${failedThisWave.length} failed/incomplete ===`)

  if (quotaDeferredThisWave.length > 0) {
    log(``)
    log(`These hunts hit MODEL QUOTA (both cross-models rate-limited) — transient, NO action needed; they auto-resume on the next pass once the window frees:`)
    for (const r of quotaDeferredThisWave) {
      log(`  ⏳ ${r.slug}: ${r.status || r.verdict} (auto-resumes)`)
    }
  }

  if (complianceReviewThisWave.length > 0) {
    log(``)
    log(`These hunts CERTIFIED but are held for COMPLIANCE SIGN-OFF (a declared risk surface — wolfpack-config.md → Compliance Requirements) — they are EXCLUDED from the release queue until you sign off with /resolve:`)
    for (const r of complianceReviewThisWave) {
      log(`  ⏸ ${r.slug}: ${r.status || r.verdict}  →  /resolve ${r.slug}`)
    }
  }

  if (parkedThisWave.length > 0) {
    log(``)
    log(`These hunts PARKED for a human — answer with /resolve, then re-run the campaign to resume them:`)
    for (const r of parkedThisWave) {
      log(`  ⏸ ${r.slug}: ${r.status || r.verdict}${r.reason ? ` (${r.reason})` : ''}  →  /resolve ${r.slug}`)
    }
  }

  if (failedThisWave.length > 0) {
    log(``)
    log(`These hunts did NOT certify — inspect their plan dirs before re-running:`)
    for (const r of failedThisWave) {
      log(`  ✗ ${r.slug}: ${r.verdict}${r.status ? ` (${r.status})` : ''}`)
    }
  }

  if (certifiedThisWave.length > 0) {
    // [04] The RELEASE QUEUE = certified hunts minus compliance-review holds.
    // On the batch path the WAVE owns one version tag and one deploy — so the
    // sequence is the two wave commands, NOT a per-hunt /merge loop. /merge-wave
    // merges each certified hunt sequentially (--no-ff, no per-hunt tag), then
    // finalizes ONE version + tag; /smoke-wave unions every released hunt's
    // acceptance criteria into a single consolidated pass.
    log(``)
    log(`RELEASE QUEUE — wave ${wave.number} (${certifiedThisWave.length} ready${complianceReviewThisWave.length ? `, ${complianceReviewThisWave.length} held for compliance sign-off` : ''}):`)
    for (const slug of certifiedThisWave) {
      log(`  ✅ ${slug}  certified`)
    }
    for (const r of complianceReviewThisWave) {
      log(`  ⏸ ${r.slug}  compliance_review (run /resolve first)`)
    }
    log(``)
    log(`Release this wave (single tag, single deploy, one consolidated smoke):`)
    log(`  1. /merge-wave ${campaignSlug} ${wave.number}   (sequential --no-ff merges → ONE wave tag → push)`)
    if (projectConfig.devDeployCommand) {
      log(`  2. ${projectConfig.devDeployCommand}   (ONE deploy for the whole wave — wolfpack-config.md → Dev deploy command)`)
      log(`  3. /smoke-wave ${campaignSlug} ${wave.number}    (consolidated [auto] smoke + [manual] checklist)`)
      log(``)
      log(`If one hunt fails smoke: git revert <that hunt's merge commit> (--no-ff merges are cleanly revertible),`)
      log(`re-lay the wave tag on the post-revert commit, redeploy, re-smoke that hunt only.`)
    } else {
      log(`  2. (no deploy step — wolfpack-config.md declares none)`)
      log(`  3. (no smoke-wave — nothing is deployed)`)
    }
  }

  log(``)
  log(`Pipeline STOPS here (wave barrier). Re-run /run-campaign ${campaignSlug} to continue the next wave`)
  log(`once this wave's certified hunts are merged + smoked.`)

  // [02] Headline verdict must NOT mask a mixed wave. Parks are a normal autonomous
  // outcome (not a failure), but a wave where some hunts certified AND others
  // failed/parked is PARTIAL — reporting it as a clean "complete awaiting release"
  // would hide the work still owed. Precedence: any certified → release something
  // (partial if anything else failed/parked/quota-deferred, else complete); else genuine
  // breakage → failed; else human parks → awaiting human; else ONLY quota-deferred →
  // WAVE_PAUSED_QUOTA (re-runnable: the driver loops, the window gate waits — [05] AC3).
  // (The per-bucket logs + arrays below always carry the full detail regardless.)
  // [04] A compliance-review hold is a human gate (like a park) for verdict
  // purposes — it keeps a wave from being "complete", and on its own (nothing
  // certified) it is WAVE_AWAITING_HUMAN, not a benign complete.
  let waveVerdict
  if (certifiedThisWave.length > 0) {
    waveVerdict = (failedThisWave.length > 0 || parkedThisWave.length > 0 || quotaDeferredThisWave.length > 0 || complianceReviewThisWave.length > 0)
      ? 'WAVE_PARTIAL_AWAITING_RELEASE'
      : 'WAVE_COMPLETE_AWAITING_RELEASE'
  } else if (failedThisWave.length > 0) {
    waveVerdict = 'WAVE_FAILED'
  } else if (parkedThisWave.length > 0 || complianceReviewThisWave.length > 0) {
    waveVerdict = 'WAVE_AWAITING_HUMAN'
  } else if (quotaDeferredThisWave.length > 0) {
    waveVerdict = 'WAVE_PAUSED_QUOTA'
  } else {
    waveVerdict = 'WAVE_COMPLETE_AWAITING_RELEASE'  // nothing returned — benign
  }

  return {
    campaign: campaignSlug,
    completed: false,
    verdict: waveVerdict,
    certifiedHunts: certifiedThisWave,
    complianceReviewHunts: complianceReviewThisWave.map(r => r.slug),
    parkedHunts: parkedThisWave.map(r => ({ slug: r.slug, status: r.status || r.verdict, reason: r.reason })),
    quotaDeferredHunts: quotaDeferredThisWave.map(r => r.slug),
    failedHunts: failedThisWave.map(r => r.slug),
    completedWave: wave.number,
  }
}

log(`Campaign ${campaignSlug} execution complete`)

return {
  campaign: campaignSlug,
  completed: true,
  verdict: 'CAMPAIGN_COMPLETE',
}
