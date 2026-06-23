export const meta = {
// REFERENCE — ported from PawPIMS; this orchestration layer is slated for DevDen reimplementation (deterministic Python). NOT de-PawPIMS-genericized. See wolfpack-lab/DEVDEN-ARCHITECTURE.md section 14.
  name: 'hunt-pipeline',
  description: 'Run a full Wolfpack hunt pipeline: scaffold through certification',
  phases: [
    { title: 'Scaffold', detail: 'Create hunt directory, metadata, worktree' },
    { title: 'Spec', detail: 'Capture intent as acceptance.md; confidence gate (build vs park)' },
    { title: 'Plan', detail: 'Alpha writes implementation plan' },
    { title: 'Review', detail: 'Bloodhound reviews via Gemini, Alpha revises' },
    { title: 'Debrief', detail: 'Alpha synthesizes plan-final' },
    { title: 'Implement', detail: 'Shepherd implements code in worktree' },
    { title: 'Code Review', detail: 'Pointer reviews diff via Gemini' },
    { title: 'Test', detail: 'Tracker writes and runs tests' },
    { title: 'Certify', detail: 'Watchdog certifies via Gemini' },
    { title: 'Verify', detail: 'Deploy feat branch to dev, smoke test before merge' },
  ],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    findings: { type: 'number' },
    status: { type: 'string' },
    tier: { type: 'string' },
    bloodhoundRounds: { type: 'number' },
    pointerRounds: { type: 'number' },
    trackerRounds: { type: 'number' },
    bloodhoundModel: { type: 'string' },
    worktreePath: { type: 'string' },
  },
  required: ['verdict'],
}

// [03] Part A — structured verdict contract. The reviewer now emits a hard
// <verdict>{...}</verdict> block; the shim extracts-and-validates rather than
// interpreting prose. Each finding carries the fields the grounding check needs
// (`file` + `line`) plus `claim`/`evidence` (the defect statement + what proves
// it). `grounded`/`dropped` report the post-hoc file-existence check. (Finding
// fingerprints for convergence detection are a later [03] Part B layer.)
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    findings: { type: 'number' },
    status: { type: 'string' },
    provider: { type: 'string' },
    grounded: { type: 'number' },   // file-bearing findings that grounded out (file exists)
    dropped: {                       // findings dropped as ungrounded (file not found)
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          file: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    findingsList: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          severity: { type: 'string' },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          claim: { type: 'string' },     // one-sentence defect statement
          evidence: { type: 'string' },  // what in the diff/file shows it
          // [03] Part B — coarse semantic key the shim computes from file+claim
          // (normalize(file) + ":" + defectClass(claim)). Convergence reasons over
          // these: the SAME underlying defect across rounds must yield the SAME key.
          fingerprint: { type: 'string' },
        },
        required: ['id', 'severity', 'title'],
      },
    },
  },
  required: ['verdict', 'findingsList'],
}

const REVISION_SCHEMA = {
  type: 'object',
  properties: {
    findingsAddressed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          severity: { type: 'string' },
          title: { type: 'string' },
          disposition: { type: 'string' },
          justification: { type: 'string' },
        },
        required: ['id', 'disposition', 'justification'],
      },
    },
    allAddressed: { type: 'boolean' },
  },
  required: ['findingsAddressed', 'allAddressed'],
}

const RESUME_SCHEMA = {
  type: 'object',
  properties: {
    fresh: { type: 'boolean' },
    status: { type: 'string' },
    resumePhase: { type: 'string' },
    tier: { type: 'string' },
    bloodhoundRounds: { type: 'number' },
    pointerRounds: { type: 'number' },
    trackerRounds: { type: 'number' },
    worktreePath: { type: 'string' },
    planDir: { type: 'string' },
    worktreeExists: { type: 'boolean' },
    branchExists: { type: 'boolean' },
    bloodhoundModel: { type: 'string' },
    // [02] park awareness — populated when status is `parked:<reason>`
    parkReason: { type: 'string' },       // the <reason> suffix, or null
    parkResumePhase: { type: 'string' },  // metadata.park.resume_phase, or null
    parkTier: { type: 'string' },         // metadata.park.tier (fail-closed tier carry), or null
    resolutionType: { type: 'string' },   // metadata.park.resolution_type, or null
    humanNotesPresent: { type: 'boolean' },// human-notes.md exists (a /resolve answer landed)
    driftWarning: { type: 'string' },      // [Fix 3] diagnostic: main/worktree divergence one-liner, else null
  },
  required: ['fresh'],
}

// [02] Park / resolve / resume. A hunt that can't safely proceed halts CLEANLY:
// it writes a structured park record (parked.md + a metadata `park` block + a
// `parked:<reason>` status) so the human can answer in seconds via /resolve
// without opening the worktree, and so the next cron tick can resume it
// autonomously once answered. The PARK_SCHEMA is what the park-writer agent
// returns to confirm it stamped the record (parked_at is agent-stamped — the
// workflow JS has no clock; new Date()/Date.now() throw in scripts).
const PARK_SCHEMA = {
  type: 'object',
  properties: {
    parked: { type: 'boolean' },
    reason: { type: 'string' },
    parkedAt: { type: 'string' },   // ISO8601 the agent wrote (date -u)
  },
  required: ['parked'],
}

// [02] Compliance-review gate (AC5). After Watchdog PASS, a small agent computes
// the touched paths and decides whether the diff hits a compliance risk surface.
// `determined` lets the JS fail closed: if the agent could NOT compute the diff,
// it parks anyway. `alreadySignedOff` short-circuits the gate after a human has
// signed off via /resolve (else the post-sign-off resume would re-park forever).
const COMPLIANCE_GATE_SCHEMA = {
  type: 'object',
  properties: {
    complianceTouched: { type: 'boolean' },
    determined: { type: 'boolean' },        // false ⇒ git diff failed ⇒ fail closed (park)
    alreadySignedOff: { type: 'boolean' },  // metadata.park.compliance_signed_off === true
    touchedPaths: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  // `determined` is required so the agent always states it; the JS ALSO fails closed
  // on a non-true value (belt-and-suspenders — an omitted/undefined determined parks).
  required: ['complianceTouched', 'determined'],
}

// [01] Spec-driven hunts — the autonomous Spec phase (Phase 0, between Scaffold
// and Plan) writes acceptance.md (the Definition-of-Done contract) and returns a
// confidence verdict. mode_for_build is the gate: `autonomous` proceeds, `flagged`
// proceeds with surfaced assumptions, `parked` halts the hunt as needs_spec (no
// build until a human resolves it — full /resolve plumbing is [02]). Headless runs
// can't AskUserQuestion, so anything that would need a question parks rather than
// silently defaulting (per docs/wolfpack-autonomy/01 § interview interface).
const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    confidence: { type: 'string', enum: ['high', 'med', 'low'] },
    // enum-constrained so a typo'd/empty verdict is rejected at the schema layer
    // (the agent retries); the JS gate below ALSO fails closed on any non-build
    // value — belt-and-suspenders, never a fall-through to a build.
    modeForBuild: { type: 'string', enum: ['autonomous', 'flagged', 'parked'] },
    ambiguityOpen: { type: 'boolean' },     // a load-bearing question is unanswered
    complianceCritical: { type: 'boolean' },// touches controlled_substances / billing
    complianceReviewRequired: { type: 'boolean' }, // pre-merge compliance checkpoint flag
    acceptanceWritten: { type: 'boolean' }, // acceptance.md exists at the plan dir
    questionCount: { type: 'number' },      // ranked load-bearing ambiguity questions raised
    summary: { type: 'string' },            // one-line verdict for the log / notification
  },
  required: ['confidence', 'modeForBuild'],
}

// ─── [03] Part B — TIER CONFIG (single source of truth) + convergence ─────────
// Round-counts previously lived in 4 disagreeing places (wolfpack/SKILL.md round-caps
// block, the Pipeline-Shapes table, the Math.max floors in this file, and Alpha's
// metadata). After convergence detection (below), "rounds" is no longer a CAP — it's a
// FLOOR plus a few thresholds — so one aligned block is simpler to keep honest. The
// wolfpack SKILL round-caps table is documented-as matching this.
//   • baseRounds    — per-tier review FLOOR (minimum rounds before the noisy STALL
//                     signal engages; Alpha may RAISE it, the pipeline never lowers it).
//   • planSmellBound — cumulative DISTINCT criticals across rounds that routes to
//                     FLAWED_PLAN (the plan/spec is wrong, not the code) → kick to Alpha.
//   • critPersist   — a CRITICAL fingerprint surviving this many CONSECUTIVE rounds
//                     parks open_critical (never implement past a stuck critical).
//   • maxRounds     — hard CIRCUIT BREAKER (runaway guard, NOT a quality knob): hitting
//                     it PARKS non_convergence, never proceeds.
//   • reviewLenses  — review fan-out units for ONE round (workflow-orchestrated). A
//                     single comprehensive single-pass lens is the validated default for
//                     every tier; splitting Red into parallel correctness/compliance/
//                     security lenses is a config flip pending a calibration run — the
//                     fan-out machinery + n-1 degradation already support N>1 units.
const SINGLE_LENS = [{ key: 'full', focus: '' }]
const TIER_CONFIG = {
  Green:  { baseRounds: 1, planSmellBound: 12, critPersist: 3, maxRounds: 4, reviewLenses: SINGLE_LENS },
  Blue:   { baseRounds: 1, planSmellBound: 12, critPersist: 3, maxRounds: 4, reviewLenses: SINGLE_LENS },
  Yellow: { baseRounds: 2, planSmellBound: 12, critPersist: 3, maxRounds: 6, reviewLenses: SINGLE_LENS },
  Orange: { baseRounds: 2, planSmellBound: 12, critPersist: 3, maxRounds: 6, reviewLenses: SINGLE_LENS },
  Red:    { baseRounds: 3, planSmellBound: 12, critPersist: 3, maxRounds: 8, reviewLenses: SINGLE_LENS },
}
// Fail-closed: an unknown/missing tier gets Red depth (over-review is cheap; under-
// reviewing a compliance/arch hunt ships suspect code). Mirrors the resume tier default.
const tierCfg = (t) => TIER_CONFIG[t] || TIER_CONFIG.Red

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 }
const isCriticalSev = (s) => String(s || '').toLowerCase().includes('critical')

// [03] Part B — CONVERGENCE CLASSIFIER. Replaces the count-based severity ceiling
// (CRIT_CEILING/HIGH_CEILING/roundCap++). On cron, round COUNT is a noisy proxy; what
// distinguishes a healthy-but-slow review ("fix critical A → reveal a DIFFERENT critical
// B") from a pathological one (oscillation, whack-a-mole, hallucinated criticals) is
// PROGRESS, reasoned over finding FINGERPRINTS. Pure function — no agent/clock/fs — so
// it is deterministic and resume-safe. It NEVER returns "proceed past an open finding":
// the only proceed is APPROVED (handled by the caller). Returns one action:
//   continue            — keep reviewing (no fixed cap)
//   park_open_critical  — a CRITICAL fingerprint is stuck (≥ critPersist rounds)
//   park_non_convergence— oscillation / stall / circuit-breaker
//   flawed_plan         — cumulative distinct criticals ≥ planSmellBound → kick to Alpha
//
// `history` holds PRIOR rounds only (this round not yet committed):
//   { fpRounds: Array<Set<fp>>, counts: number[], cumulativeCritFps: Set<fp>,
//     critStreak: Map<fp,int> }
// `findings` is THIS ISSUES_FOUND round's grounded findingsList (each {fingerprint,severity}).
function classifyConvergence({ round, findings, history, cfg, floor }) {
  const thisFps = findings.map(f => f.fingerprint).filter(Boolean)
  const thisFpSet = new Set(thisFps)
  const thisCount = findings.length
  const critFps = [...new Set(findings.filter(f => isCriticalSev(f.severity)).map(f => f.fingerprint).filter(Boolean))]

  // cumulative distinct criticals if we commit this round (caller commits after).
  const cumulativeCrit = new Set(history.cumulativeCritFps)
  critFps.forEach(fp => cumulativeCrit.add(fp))

  // (1) CRITICAL STUCK — a critical fingerprint present for critPersist CONSECUTIVE
  // rounds (counting this one). Ungated by floor: a stuck critical must halt ASAP. (AC5)
  for (const fp of critFps) {
    if ((history.critStreak.get(fp) || 0) + 1 >= cfg.critPersist) {
      return { action: 'park_open_critical', detail: `critical fingerprint "${fp}" stuck ${cfg.critPersist} rounds`, cumulativeCrit }
    }
  }
  // (2) PLAN SMELL — cumulative DISTINCT criticals ≥ bound: the plan/spec is wrong, not
  // the code → FLAWED_PLAN (Alpha re-plans), NOT a Shepherd rewrite. Ungated. (AC4)
  if (cumulativeCrit.size >= cfg.planSmellBound) {
    return { action: 'flawed_plan', detail: `${cumulativeCrit.size} cumulative distinct criticals ≥ ${cfg.planSmellBound}`, cumulativeCrit }
  }
  // (3) CIRCUIT BREAKER — the hard runaway guard. Checked BEFORE the converging green
  // light: "continue past the BASE cap" is the goal (AC3), "run forever" is not. Hitting
  // maxRounds PARKS (never proceeds) even if this round looks healthy — N rounds without
  // a clean APPROVED is itself the signal to hand a human a tight diff.
  if (round >= cfg.maxRounds) {
    return { action: 'park_non_convergence', detail: `MAX_ROUNDS (${cfg.maxRounds}) reached without convergence`, cumulativeCrit }
  }
  // (4) CONVERGING — all this-round fingerprints are NEW (unseen in ANY prior round) AND
  // count not growing. The healthy case: the pack keeps surfacing genuinely distinct
  // defects without re-breaking old ones → CONTINUE (no fixed cap). Checked BEFORE
  // oscillation/stall so "new distinct critical each round" never trips the stall on a
  // flat count (AC3 first clause; the runaway is bounded by plan-smell + the breaker).
  const allSeen = new Set()
  history.fpRounds.forEach(s => s.forEach(fp => allSeen.add(fp)))
  const allNew = thisFps.length > 0 && thisFps.every(fp => !allSeen.has(fp))
  const prevCount = history.counts.length ? history.counts[history.counts.length - 1] : Infinity
  if (allNew && thisCount <= prevCount) {
    return { action: 'continue', detail: 'converging (all-new fingerprints, count not growing)', cumulativeCrit }
  }
  // (5) OSCILLATING — a fingerprint last seen in round ≤ N-2 (then ABSENT in N-1 =
  // "fixed") reappears now: the pack is fighting itself. Ungated: a fixed-then-returned
  // defect is unambiguously pathological the moment it returns (AC3 second clause).
  const prevRound = history.fpRounds.length ? history.fpRounds[history.fpRounds.length - 1] : new Set()
  const earlierRounds = history.fpRounds.slice(0, -1) // rounds 1 .. N-2
  for (const fp of thisFpSet) {
    if (!prevRound.has(fp) && earlierRounds.some(s => s.has(fp))) {
      return { action: 'park_non_convergence', detail: `oscillation: fingerprint "${fp}" returned after being fixed`, cumulativeCrit }
    }
  }
  // (6) STALLED — finding count not strictly decreasing over the last 2 transitions.
  // Floor-gated: give the pack its baseline rounds before declaring a stall (a transient
  // up-tick during the floor rounds is not yet pathological). Needs 2 prior counts.
  if (round > floor && history.counts.length >= 2) {
    const prev = history.counts[history.counts.length - 1]
    const prev2 = history.counts[history.counts.length - 2]
    if (thisCount >= prev && prev >= prev2) {
      return { action: 'park_non_convergence', detail: `stall: counts ${prev2}→${prev}→${thisCount} not strictly decreasing`, cumulativeCrit }
    }
  }
  // (7) Still making progress (e.g. count dropping while some N-1 findings carry over) —
  // continue. Bounded by the circuit breaker (check 3) above.
  return { action: 'continue', detail: 'making progress', cumulativeCrit }
}

// Commit a classified round into the running history (mutates `history`). Critical
// streaks rebuild from THIS round's criticals so an absent critical resets to 0.
function commitRound(history, findings, cumulativeCrit) {
  const thisFpSet = new Set(findings.map(f => f.fingerprint).filter(Boolean))
  const critFps = new Set(findings.filter(f => isCriticalSev(f.severity)).map(f => f.fingerprint).filter(Boolean))
  history.fpRounds.push(thisFpSet)
  history.counts.push(findings.length)
  history.cumulativeCritFps = cumulativeCrit
  const next = new Map()
  for (const fp of critFps) next.set(fp, (history.critStreak.get(fp) || 0) + 1)
  history.critStreak = next
}

// The ledger row-set for one round: a coarse {fp, severity, id, title} per finding —
// the model-grading substrate ([06] queries it; here we just record it). Bare keys
// widened to rows per docs/wolfpack-autonomy/03 § the ledger as model-grading substrate.
const ledgerRows = (findings) => (findings || []).map(f => ({
  fp: f.fingerprint || null, severity: f.severity || null, id: f.id, title: f.title || null,
}))

// [06] AC3 — a role-keyed, disposition-bearing ledger round entry. The grounding
// check (review step 7) already splits a reviewer's findings into GROUNDED (real
// files) vs DROPPED (hallucinated / ungrounded), so per round we have the
// signal/noise the routing meter needs WITHOUT any cross-round bookkeeping:
//   raised = grounded + dropped ; signal = grounded/raised ; noise = dropped/raised.
// role keys the entry so Bloodhound and Pointer rounds never collide at the same
// array index (they each run their own round counter from 1) — review_fingerprints
// is an OBJECT { "<role>": [perRound...] }, not the old role-blind array-of-arrays.
const ledgerEntry = (role, round, findings, droppedCount) => {
  const grounded = (findings || []).length
  const dropped = Number.isFinite(droppedCount) ? droppedCount : 0
  return { role, round, raised: grounded + dropped, grounded, dropped, findings: ledgerRows(findings) }
}

// Prompt fragment injected into the agent that runs NEXT after an ISSUES_FOUND round
// (Alpha/Shepherd revision, parkHunt, or the flawed-plan stamp) so a SINGLE agent
// records the round — the review-shim agents must NOT write metadata concurrently
// (fan-out would race metadata.json). Idempotent: sets review_fingerprints[round-1].
const convergenceMetaInstruction = (planDirArg, entry, classification, cumulativeCriticals) => `

CONVERGENCE LEDGER (record only — do NOT act on these findings): update ${planDirArg}/metadata.json:
- ensure top-level "review_fingerprints" is an OBJECT keyed by role; ensure review_fingerprints["${entry.role}"] is an array; SET index [${entry.round - 1}] (round ${entry.round}) to:
  ${JSON.stringify(entry)}
  (one entry per review round, per role — preserve every other index AND the other role's array. If review_fingerprints is currently an array from an older run, replace it with { "${entry.role}": [<that array's entries>] } keyed by role first.)
- set top-level "convergence" = { "classification": "${classification}", "cumulative_distinct_criticals": ${cumulativeCriticals}, "rounds": ${entry.round} }
Preserve every other field. (The worktree plan dir is the single source of truth — do NOT mirror to any main-repo plan dir; /merge handles that.)`

const _args = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const { slug, description, campaign, tier: campaignTier, mode: campaignMode,
        ticketRefs, todoItemsCleared, migrationRisk, rationale } = _args

// Which non-Claude model is THIS hunt's primary cross-examiner. The campaign
// runner alternates it per hunt (mistral / gemini) so two parallel hunts never
// stack their reviews on the same model — that round-robin is the DEFAULT/spread
// baseline. Once Alpha runs, its pedigree-driven model_assignments.bloodhound
// OVERRIDES this (see below): Alpha picks, the runner's alternation only
// rebalances when Alpha left it unset. Both Vibe/Mistral and Agy/Gemini can
// perform every review/certification phase; the only invariant is that the
// examiner is never Claude (adversarial cross-model review is mandatory).
// AUTONOMOUS = Gemini-only for cross-model review/cert. Mistral/Vibe is stripped from
// the auto-pipeline — its API tier (25K tokens/min) can't carry real agentic reviews, so
// it only ever fell over to Gemini anyway. The MANUAL slash-command path and podman-vibe.sh
// are untouched (opt-in Mistral still works there). Set WOLFPACK_ENABLE_MISTRAL_AUTO=1 to
// restore Mistral in autonomous runs.
const AUTO_GEMINI_ONLY = !(typeof process !== 'undefined' && process.env && process.env.WOLFPACK_ENABLE_MISTRAL_AUTO)
let crossExaminer = AUTO_GEMINI_ONLY ? 'gemini' : ((_args.crossExaminer === 'gemini') ? 'gemini' : 'mistral')
let otherExaminer = AUTO_GEMINI_ONLY ? 'gemini' : (crossExaminer === 'mistral' ? 'gemini' : 'mistral')
const EXAMINER_LABEL = { mistral: 'Vibe/Mistral', gemini: 'Agy/Gemini' }

// Map a model-assignment string ("gemini:flash-3.5", "mistral:medium",
// "Agy/Gemini", "Vibe/Mistral") to its provider family, or null if unrecognized
// / Claude (Claude can never be an examiner). Used to honor Alpha's reviewer
// assignment and to pin the examiner that actually answered (stickiness).
const providerOf = (m) => {
  if (!m) return null
  const s = String(m).toLowerCase()
  if (s.includes('gemini') || s.includes('agy')) return 'gemini'
  if (s.includes('mistral') || s.includes('vibe')) return 'mistral'
  return null
}
// Pin the primary examiner (and derive the fallback). Idempotent; ignores
// unrecognized/Claude inputs so a bad value never blanks the examiner.
const setExaminer = (provider, why) => {
  // Gemini-only autonomous mode: ignore any Mistral assignment, stay on Gemini.
  if (AUTO_GEMINI_ONLY) { crossExaminer = 'gemini'; otherExaminer = 'gemini'; return }
  const p = providerOf(provider)
  if (!p || p === crossExaminer) return
  crossExaminer = p
  otherExaminer = p === 'mistral' ? 'gemini' : 'mistral'
  log(`Cross-examiner → ${EXAMINER_LABEL[crossExaminer]} (${why})`)
}

const campaignContext = [
  campaignTier ? `Campaign tier: ${campaignTier} (DO NOT downgrade)` : '',
  campaignMode ? `Campaign mode: ${campaignMode}` : '',
  ticketRefs ? `Ticket refs: ${ticketRefs}` : '',
  todoItemsCleared ? `TODO items to clear: ${todoItemsCleared}` : '',
  migrationRisk ? `Migration risk: ${migrationRisk}` : '',
  rationale ? `Rationale: ${rationale}` : '',
].filter(Boolean).join('\n')

// Heartbeat + timing: every agent writes a status file as its first action,
// AND brackets its phase with start/end markers in an append-only timing log.
// One heartbeat file PER HUNT (keyed by slug) so parallel hunts don't clobber a
// shared file — the host can see every concurrent hunt at once via the glob:
//   watch -n 10 'for f in .wolfpack/heartbeats/*.json; do echo "$(basename "$f" .json): $(cat "$f")"; done'
//
// [05] TIMING — the markers feed the limit gate's "fits the window?" decision.
// The clock lives in the AGENT (real bash `date -Iseconds`), never in this JS:
// Date.now()/new Date() throw in the workflow harness (they'd break resume), so
// every timestamp is agent-authored and read back by the host-side aggregator
// (scripts/wolfpack-timing.mjs). timing.jsonl is append-only and is written
// worktree-absolute (${worktreePath}/.wolfpack/plans/${slug}/timing.jsonl — the
// worktree plan dir is the single source of truth), so concurrent phases never
// clobber it and a resumed hunt simply appends a fresh start/end pair (the
// aggregator sums sequential pairs per phase, so re-runs add real time rather
// than corrupting the record).
// Each agent gets this instruction appended to its prompt.
//
// Scaffold is EXCLUDED from timing markers: it runs from the MAIN repo before the
// worktree exists, so its markers would land in a timing.jsonl the worktree never
// adopts (and /merge's `cp -r` later overwrites) — and its duration (worktree
// creation, seconds) is bookkeeping the metadata created→completed_at window
// already covers. detail is deliberately NOT interpolated into the marker (it's
// already in the heartbeat JSON) so a detail containing a single quote can never
// break the single-quoted printf format string. Paths are quoted defensively.
const heartbeat = (phaseName, detail) => {
  const timed = phaseName !== 'Scaffold'
  const startMarker = timed ? `
then append a START marker to the timing log using the REAL clock (do not guess the time):
printf '{"phase":"${phaseName}","event":"start","ts":"%s"}\\n' "$(date -Iseconds)" >> "${worktreePath}/.wolfpack/plans/${slug}/timing.jsonl"` : ''
  const endMarker = timed ? ` AND append an END marker:
printf '{"phase":"${phaseName}","event":"end","ts":"%s"}\\n' "$(date -Iseconds)" >> "${worktreePath}/.wolfpack/plans/${slug}/timing.jsonl"` : ''
  // Scaffold runs before the worktree exists and writes NO timing markers, so it only
  // needs .wolfpack/heartbeats; timed phases (all after the worktree exists) also mkdir
  // the worktree-absolute plan dir for the timing log.
  const planDirMk = timed ? ` "${worktreePath}/.wolfpack/plans/${slug}"` : ''
  return `
HEARTBEAT + TIMING: Before doing anything else, run \`mkdir -p .wolfpack/heartbeats${planDirMk}\`, write this JSON to .wolfpack/heartbeats/${slug}.json:
{"hunt":"${slug}","phase":"${phaseName}","detail":"${detail}","agent":"starting"}${startMarker}
Update the heartbeat "agent" field to "working" after you begin. When you finish this phase, set the heartbeat "agent" field to "done"${endMarker}

TOOLING POLICY (every phase): Do NOT use the chrome-devtools MCP or any browser automation
(new_page / navigate_page / take_snapshot / etc.). This is a headless BUILD pipeline — there
is no local server to drive, and the deployed dev environment runs the OLD code (this hunt is
unmerged), so browsing it verifies nothing and just spawns a browser on the operator's screen.
Tests run ONLY via \`./scripts/run_tests.sh\` (the Django suite). Browser/UI smoke is a SEPARATE,
post-deploy, user-driven \`/smoke-wave\` step — never part of a build phase.`
}

// ─── Resume gate ───────────────────────────────────────────────
// A crashed or limited-out hunt leaves durable state on disk (metadata.json +
// plan artifacts, which survive the crash). The Workflow script has NO
// filesystem access, so a read-only probe agent reports the last checkpoint;
// we map its status to the phase to resume at and skip everything already done
// — no re-planning, no re-review, no Scaffold collision. Skipped phases are safe
// because every later phase re-reads its inputs (plan.md, plan-final.md, the git
// diff) from disk rather than from the in-memory results of earlier phases.
const PHASE_ORDER = ['Scaffold', 'Spec', 'Plan', 'Review', 'Debrief', 'Implement', 'Code Review', 'Test', 'Certify', 'Verify']
// Fallback only — the probe's artifact-derived resumePhase is preferred. Covers
// the agent-authored status strings seen in real runs (the first live validation
// parked at `code_reviewed`, which the original map missed entirely → it would
// have wrongly restarted from Scaffold).
const STATUS_RESUME = {
  needs_spec:        'Spec',
  ready_for_alpha:   'Plan',
  reviewing:         'Review',
  reviewed:          'Debrief',
  ready:             'Implement',
  implementing_done: 'Code Review',
  code_reviewed:     'Test',
  tested:            'Certify',
  rework_needed:     'Implement',
  code_rewrite_needed: 'Implement',  // Pointer bounced the diff back → Shepherd re-implements
  test_rewrite_needed: 'Implement',  // Tracker bounced the diff back → Shepherd re-implements
  flawed_plan:       'Plan',
  certified:         'Verify',
}

// Backward "the work is wrong, redo it" signals. Unlike forward statuses (which an
// agent might optimistically write before actually finishing — hence the artifact-
// preference below), these are DELIBERATE bounces from a reviewer (Pointer/Tracker/
// Watchdog) or a failed plan. The artifact-derived resumePhase is FORWARD-biased: it
// keys on the furthest artifact on disk, so a `test_rewrite_needed` hunt with a
// `pointer-review-*.md` present resolves to "Test" and re-runs the SAME review against
// UNCHANGED code — an infinite rewrite loop (observed: duplicate-client-warning,
// v1-push-3 W3, 2026-06-11). For these statuses the status MUST override artifacts.
const BACKWARD_AUTHORITATIVE = new Set([
  'rework_needed', 'flawed_plan', 'code_rewrite_needed', 'test_rewrite_needed',
])

phase('Scaffold')
const resumeProbe = await agent(`
Read-only resume probe. Report the durable state of this hunt so the pipeline
can resume where a prior (crashed or limited-out) run left off. Do NOT modify,
create, or delete anything — read only.

Hunt slug: ${slug}

Steps:
1. Run \`pwd\` to get the repo root (call it REPO). The worktree is
   REPO/.agents/worktrees/${slug}; its plan dir is
   REPO/.agents/worktrees/${slug}/.wolfpack/plans/${slug}; the main plan dir is
   REPO/.wolfpack/plans/${slug}.
2. The WORKTREE plan dir is the single source of truth. If the worktree dir EXISTS,
   read metadata.json from the WORKTREE plan dir ONLY. If the worktree dir does NOT
   exist (the --no-worktree path), fall back to the main plan dir. If NEITHER the
   worktree metadata.json nor (when there's no worktree) the main metadata.json
   exists, this is a brand-new hunt: return { fresh: true }.
3. Use that single metadata.json as authoritative — do NOT cross-compare a main and a
   worktree copy. (flawed_plan means the plan failed
   certification — treat it as needing a replan; needs_spec means the Spec phase
   parked the hunt for a human — treat it as needing re-spec.)
   A status that STARTS WITH "parked:" ([02] — e.g. "parked:open_critical",
   "parked:compliance_review", "parked:non_convergence") means the hunt HALTED for a
   human and has NOT yet been answered. Report it verbatim (do not normalize it away,
   do not treat it as resumable) and fill the park fields in step 5.
4. Compute resumePhase = the phase that comes AFTER the FURTHEST-completed
   artifact (an artifact in the authoritative plan dir from step 2 — the worktree
   plan dir, or the main plan dir only when there is no worktree). Check MOST-COMPLETE
   FIRST; the first match wins. This is robust even
   when an intermediate artifact (e.g. review-*.md) was never persisted — a later
   artifact proves the earlier phase ran:
   - status "rework_needed" → "Implement"   (Watchdog asked for a redo)
   - status "flawed_plan" → "Plan"           (the plan itself was rejected)
   - status "needs_spec" → "Spec"            (Spec parked it — re-spec/re-gate)
   - status "awaiting_user_deploy" → "DONE"
   - certification.md present → "Verify"
   - pointer-review-*.md present → "Test"
   - shepherd-log.md present OR commits on feat/${slug} (git log main..feat/${slug}) → "Code Review"
   - plan-final.md present → "Implement"
   - review-*.md present → "Debrief"
   - plan.md present → "Review"
   - acceptance.md present → "Plan"          (Spec done, planning not started)
   - else (only metadata.json) → "Spec"
4.5 DRIFT CHECK [Fix 3] — DIAGNOSTIC ONLY; does NOT change the authoritative read
   above. The worktree plan dir is the single source of truth, so once a worktree
   exists NOTHING should write the main plan dir during the hunt's life (only /merge
   writes main, at copy-back). IF a worktree exists AND the main plan dir's
   metadata.json (REPO/.wolfpack/plans/${slug}/metadata.json) ALSO exists, compare them:
   if main's "status" differs from the worktree's authoritative status, OR the main plan
   dir holds plan artifacts (acceptance.md / plan.md / plan-final.md / review-*.md) the
   worktree lacks, set driftWarning to a one-line description (e.g. "main status=needs_spec
   vs worktree ready_for_alpha; main has acceptance.md"). Else driftWarning = null. Do
   NOT act on it — only report it.
5. Return:
   - fresh: false
   - status: the authoritative status string
   - resumePhase: the phase computed in step 4
   - tier: metadata.tier (or null)
   - bloodhoundRounds: metadata.bloodhound_rounds (or 0)
   - pointerRounds: metadata.pointer_rounds (or 0)
   - trackerRounds: metadata.tracker_rounds (or 0)
   - bloodhoundModel: metadata.model_assignments.bloodhound provider family ("gemini" or "mistral"), or null if unset
   - worktreePath: absolute REPO/.agents/worktrees/${slug}
   - planDir: absolute worktree plan dir
   - worktreeExists: true if the worktree directory exists (ls it)
   - branchExists: true if \`git branch --list feat/${slug}\` is non-empty
   - parkReason: if status starts with "parked:", the part AFTER the colon (e.g.
     "open_critical"); else null. ([02])
   - parkResumePhase: metadata.park.resume_phase if a "park" block exists, else null.
   - parkTier: metadata.park.tier if a "park" block exists, else null (carried so
     resume never guesses a downgraded tier).
   - resolutionType: metadata.park.resolution_type if present, else null.
   - humanNotesPresent: true if human-notes.md exists in the authoritative plan dir
     from step 2 (the worktree plan dir, or the main plan dir only when there is no
     worktree) — a /resolve answer has landed and the hunt is ready to resume.
   - driftWarning: the one-line string from the DRIFT CHECK (step 4.5), or null.
Return ONLY these fields.
`, { label: `resume-probe:${slug}`, phase: 'Scaffold', schema: RESUME_SCHEMA })

// [Fix 3] Drift detection. Post worktree-canonical refactor, the main plan dir must NOT
// be written during a hunt's life (only /merge writes it, at copy-back). The probe reads
// the worktree authoritatively but also peeks at main; ANY divergence means either Fix 2
// regressed (a phase wrote main again) or a legacy pre-refactor split survives. Surface it
// LOUDLY — it never changes resume behavior, but it must never pass silently.
if (resumeProbe.driftWarning) {
  log(`⚠️ DRIFT [${slug}]: main plan dir diverges from the worktree — ${resumeProbe.driftWarning}. Worktree is authoritative (resume unaffected), but main should NOT be written mid-hunt; investigate a phase writing main, or a legacy split.`)
}

const fresh = resumeProbe.fresh !== false
let resumeFrom = 'Scaffold'
if (!fresh) {
  const status = resumeProbe.status || ''
  // [05] AC3 — `parked:model_quota` is the ONE auto-resumable park: it parked because
  // BOTH cross-models were rate-limited (transient), not because a human decision is
  // owed. So it is exempt from the human-gating guard below — the driver re-runs it and
  // we resume from park.resume_phase. The exemption keys ONLY on the machine-generated
  // reason being exactly `model_quota`; it does NOT relax the guard for any other reason
  // (and does NOT use humanNotesPresent, the bypass R2 caught), so the guard-bypass
  // hardening still holds for every human park.
  const isQuotaPark = status === 'parked:model_quota'
  const isParked = status.startsWith('parked:') && !isQuotaPark
  // [02] PARK GUARD. A `parked:<reason>` status means UNRESOLVED, by definition:
  // /resolve always flips the status to a normal resumable rung (and writes
  // human-notes.md) as part of answering, so a status still reading `parked:*`
  // proves no answer has landed for THIS park. Refuse to build — proceeding would
  // re-run the phase that already decided it couldn't safely continue (on cron
  // there's no session to unblock; park is free). NOTE: we deliberately do NOT
  // also gate on `humanNotesPresent` — that file is append-only and persists across
  // a hunt's later parks, so a hunt parking a SECOND time (after a first resolve)
  // would have notes present and wrongly bypass the guard. Status is the only sound
  // signal. The campaign runner filters parked:* out of the actionable set; this
  // guards a direct /run-hunt on a parked slug.
  if (isParked) {
    log(`⏸ ${slug} is ${status} — awaiting a human. Run \`/resolve ${slug}\` to answer and re-arm; the next runner pass then resumes it. Not building past a park.`)
    return { slug, verdict: 'PARKED', status, reason: resumeProbe.parkReason || status,
             tier: resumeProbe.parkTier || resumeProbe.tier || 'Red', worktreePath: resumeProbe.worktreePath }
  }
  if (isQuotaPark) {
    // Resume from where the quota outage parked it (park.resume_phase), falling back to
    // the artifact-derived phase. (Tier is carried from park.tier later, where `tier` is
    // assigned on the resume path — line ~1197 — so we don't touch it here.)
    log(`⏳ ${slug} is ${status} — transient model-quota park; auto-resuming (no /resolve needed).`)
    resumeFrom = (resumeProbe.parkResumePhase && PHASE_ORDER.includes(resumeProbe.parkResumePhase))
      ? resumeProbe.parkResumePhase
      : (resumeProbe.resumePhase && PHASE_ORDER.includes(resumeProbe.resumePhase) ? resumeProbe.resumePhase : 'Review')
    // Skip the human-notes/status-map block below — we've set resumeFrom directly.
    if (!resumeProbe.worktreeExists) {
      log(`⚠ ${slug} model-quota park but worktree is missing — re-scaffolding`)
      resumeFrom = 'Scaffold'
    } else {
      log(`▶ Resuming ${slug} from model-quota park → ${resumeFrom} phase`)
    }
  } else {
  // Already all the way through (artifact-derived) — hand back, nothing to redo.
  if (resumeProbe.resumePhase === 'DONE') {
    log(`Hunt ${slug} already complete (probe: DONE). Nothing to resume.`)
    return { slug, verdict: 'CERTIFIED_AWAITING_DEPLOY', tier: resumeProbe.tier || 'Yellow', worktreePath: resumeProbe.worktreePath }
  }
  // [02] For a /resolve-driven resume (human-notes.md present), the status that
  // /resolve DELIBERATELY set is AUTHORITATIVE — it must override the artifact-
  // derived resumePhase. A redirect flips status to `ready_for_alpha` (→ Plan) and
  // a clarify flips it to a specific rung; but the pre-park run left stale artifacts
  // on disk (plan-final.md, certification.md, …) that artifact detection would read
  // as a FAR-LATER phase (e.g. Verify), silently defeating the human's redirect/
  // clarify. So when an answer has landed, trust the human-set status map. For a
  // crash resume (no answer), keep preferring the artifact-derived phase — agent-
  // authored status strings were historically unreliable there.
  // (Past the guard above, status is never `parked:*` — a parked hunt already
  // returned. So this only ever sees normal/resolved rungs.)
  const statusPhase = STATUS_RESUME[status]
  if (statusPhase && BACKWARD_AUTHORITATIVE.has(status)) {
    // Deliberate reviewer/plan bounce — the status wins over the forward-biased
    // artifact phase (with or without human notes), so the redo actually re-enters
    // at the Shepherd/Plan instead of looping on the review that rejected the code.
    resumeFrom = statusPhase
  } else if (resumeProbe.humanNotesPresent && statusPhase) {
    resumeFrom = statusPhase
  } else {
    resumeFrom = (resumeProbe.resumePhase && PHASE_ORDER.includes(resumeProbe.resumePhase))
      ? resumeProbe.resumePhase
      : (statusPhase || 'Scaffold')
  }
  // Metadata claims progress but the worktree is gone → can't resume in place.
  if (resumeFrom !== 'Scaffold' && !resumeProbe.worktreeExists) {
    log(`⚠ metadata says "${resumeProbe.status}" but worktree is missing — re-scaffolding`)
    resumeFrom = 'Scaffold'
  }
  // Already all the way through — hand back to the user, nothing to redo.
  if (resumeProbe.status === 'awaiting_user_deploy') {
    log(`Hunt ${slug} already certified + verified (awaiting user deploy). Nothing to resume.`)
    return { slug, verdict: 'CERTIFIED_AWAITING_DEPLOY', tier: resumeProbe.tier || 'Yellow', worktreePath: resumeProbe.worktreePath }
  }
  if (resumeFrom !== 'Scaffold') {
    log(`▶ Resuming ${slug} from status "${resumeProbe.status}" → ${resumeFrom} phase (skipping earlier phases)`)
  }
  } // end else (non-quota resume path)
}
const at = (p) => PHASE_ORDER.indexOf(p) >= PHASE_ORDER.indexOf(resumeFrom)

// ─── Phase 0: Scaffold (skipped on resume) ─────────────────────
let worktreePath, planDir, adcValid = true
let tier, bloodhoundRounds, pointerRounds, trackerRounds
if (at('Scaffold')) {
log(`Scaffolding hunt: ${slug}`)

const scaffold = await agent(`
You are scaffolding a Wolfpack hunt. Do NOT run any planning phases — only create the directory structure and metadata.

Hunt slug: ${slug}
Description: ${description}
Campaign: ${campaign || 'none'}

Steps:
1. Verify you are on the main branch. Existing .agents/worktrees/ and .wolfpack/plans/ entries from other or prior hunts are EXPECTED — ignore them. Only stop if there are uncommitted changes to TRACKED source files.
2. Create directory: .wolfpack/plans/${slug}/
3. Write metadata.json to .wolfpack/plans/${slug}/metadata.json with these fields:
   - feature: "${slug}"
   - description: the description above
   - created: current ISO8601 timestamp
   - status: "ready_for_alpha"
   - phase: "scaffold"
   - review_round: 0
   - pointer_round: 0
   - tracker_round: 0
   - branch: "feat/${slug}"
   - is_worktree: true
   - worktree_path: will be set after worktree creation
   - scope: parse from the description (target_surface, out_of_scope, mode_guess)
   - predicted_dimensions: leave as empty object (Alpha will fill)
   - tier: null (Alpha will set)
   - mode: null (Alpha will set)
   - models: {} (Alpha will fill)
   - model_assignments: {} (Debrief will fill)
   - spec: { confidence: null, mode_for_build: null, ambiguity_open: false, compliance_critical: false, compliance_review_required: false } (the Spec phase will fill)
   - proposed_version: { bump: null, tag: null }
4. Create (or ADOPT) the git worktree — idempotent so a resumed/retried hunt never collides:
   - If .agents/worktrees/${slug} already EXISTS, do NOT recreate it — adopt it as-is and skip to step 5.
   - Else if branch feat/${slug} exists but the dir does not: git worktree add .agents/worktrees/${slug} feat/${slug}
   - Else create fresh: git worktree add .agents/worktrees/${slug} -b feat/${slug}
5. Copy .wolfpack/plans/${slug}/ into the worktree:
   mkdir -p .agents/worktrees/${slug}/.wolfpack/plans/${slug}/
   cp .wolfpack/plans/${slug}/metadata.json .agents/worktrees/${slug}/.wolfpack/plans/${slug}/
6. Update metadata.json worktree_path to the absolute path of the worktree
7. Create convenience symlinks in the worktree if paw_env and .env exist in main repo

8. GCP preflight (non-blocking): run gcloud auth application-default print-access-token
   If it succeeds, return adcValid: true
   If it fails, return adcValid: false — do NOT stop, just report

9. SAFETY TAG — Create a rollback point on main BEFORE any work begins:
   git tag -f pre-hunt-${slug} main   # -f so a resumed hunt re-tags cleanly
   This tag marks the exact state of main before the hunt. If anything goes wrong:
   - git worktree remove --force .agents/worktrees/${slug}
   - git branch -D feat/${slug}
   - main is unchanged (the tag proves it)

Return the worktree absolute path, tier (null at this stage), and adcValid boolean.
Do NOT ask questions. Do NOT run Alpha or any planning.
${heartbeat('Scaffold', 'creating worktree and metadata')}
`, { label: `scaffold:${slug}`, phase: 'Scaffold', schema: {
  type: 'object',
  properties: {
    worktreePath: { type: 'string' },
    planDir: { type: 'string' },
    adcValid: { type: 'boolean' },
  },
  required: ['worktreePath'],
}})

  worktreePath = scaffold.worktreePath
  planDir = scaffold.planDir || `${worktreePath}/.wolfpack/plans/${slug}`
  adcValid = scaffold.adcValid !== false
} else {
  worktreePath = resumeProbe.worktreePath
  planDir = resumeProbe.planDir || `${worktreePath}/.wolfpack/plans/${slug}`
  log(`Adopted existing worktree (resume): ${worktreePath}`)
}
log(`Worktree: ${worktreePath}`)
log(`Cross-examiner for this hunt: ${EXAMINER_LABEL[crossExaminer]} (fallback: ${EXAMINER_LABEL[otherExaminer]})`)

// ALWAYS invoke the cross-model shims from the MAIN repo root, never the
// worktree's `./scripts/`. Worktrees fork from main and can carry a STALE/drifted
// copy of the shim in their working tree (v1-push-3 unfinalize re-runs: the
// worktree's podman-vibe.sh was the pre-fix comma version even though the branch
// commit + main both had the fix, so the reviewer ran blind anyway). The shim
// takes the worktree path as an ARG, so the root copy operates on the worktree
// correctly while always being the current/fixed version. Derive the repo root by
// stripping the worktree suffix; fall back to the path itself for non-worktree runs.
const repoRoot = worktreePath.includes('/.agents/worktrees/')
  ? worktreePath.split('/.agents/worktrees/')[0]
  : worktreePath
log(`Shim root (always current): ${repoRoot}/scripts/`)

// [07 §6] Mistral review turn budget. CORRECTED 2026-06-08: the disconnect was NOT turn
// accumulation against a 25K-TPM cap (that theory is disproven — Medium is 200K context).
// It was a server-side request-SIZE/gateway limit, fixed by the LEAN request config in
// podman-vibe.sh (strips Vibe's ~43K default per-request overhead). With the bloat gone,
// the turn budget no longer needs to be tiny — and 5 demonstrably STARVED a tool-read review
// ("Turn limit reached" → empty output via --output text). Restored to a workable budget so
// the agent can read the diff + skill + analyze + emit a verdict. Env-tunable to re-find the
// sweet spot (too few starves; too many accumulates context toward the --max-tokens guard).
const MISTRAL_REVIEW_TURNS = (typeof process !== 'undefined' && process.env && process.env.WOLFPACK_MISTRAL_REVIEW_TURNS) || '15'

// Read-only review command for a given model. `vibeAgent` is the Vibe agent
// name used when the model is Mistral (ignored for Gemini/Agy --review).
const reviewCmd = (who, vibeAgent, promptFile) =>
  who === 'mistral'
    ? `${repoRoot}/scripts/podman-vibe.sh ${vibeAgent} "${worktreePath}" ${promptFile} ${MISTRAL_REVIEW_TURNS}`
    // Agy/Gemini (agy 1.0.6) has NO --max-price/--max-tokens/--max-turns equivalent, only
    // --print-timeout (env WOLFPACK_AGY_REVIEW_TIMEOUT in the shim). So the Gemini side
    // keeps the generous wall-clock bound + prompt read-discipline (doc 05 § B1: "where
    // one CLI lacks it, keep the generous turn cap + read-discipline for that side").
    : `${repoRoot}/scripts/podman-agy.sh --review "${worktreePath}" ${promptFile}`
// (ADC no longer gates anything — Tracker tests run against a local PostgreSQL.)
void adcValid

// [03] Part A — the verdict contract appended to every reviewer prompt
// (Bloodhound + Pointer). The non-Claude reviewer MUST end with this hard,
// machine-parseable block; the shim's job shrinks from interpret → extract +
// validate. No block = the review is discarded (ERROR), never prose-rescued
// into a false APPROVED. `file`+`line` are mandated so the grounding check can
// run test -f against the worktree.
const VERDICT_CONTRACT = `

MANDATORY VERDICT CONTRACT — your response MUST end with exactly ONE machine-parseable block, and NOTHING after it:
<verdict>
{
  "verdict": "APPROVED" | "ISSUES_FOUND",
  "findings": [
    { "id": 1, "severity": "CRITICAL|HIGH|MEDIUM|LOW", "title": "short title",
      "file": "billing/services/payments.py", "line": 142,
      "claim": "one-sentence defect statement",
      "evidence": "what in the diff or file shows it" }
  ]
}
</verdict>
Rules:
- verdict APPROVED ⇒ findings MAY be [] (empty). verdict ISSUES_FOUND ⇒ findings MUST be non-empty (an ISSUES_FOUND with no findings is a contradiction and will be discarded).
- Every "file" MUST be repo-root-relative (e.g. billing/models.py) — never absolute, never a container mount path like /workspace/... — so the pipeline can ground it with test -f against the worktree.
- Put "file" and "line" on every finding that points at code; "claim" and "evidence" are required on each finding.
- Emitting NO <verdict> block, malformed JSON, or paths the grounding check cannot find means your review is DISCARDED (counts as no review at all).`

// [05] Part B — the rate-limit signal contract between the shims and this orchestrator.
// The shims (podman-vibe.sh / podman-agy.sh) now detect a throttle (HTTP 429 / "Server
// disconnected" / "Network error" / a tripped circuit breaker) and surface it as exit
// code 75 with a `WOLFPACK_RATE_LIMITED:<model>` line on stderr — distinct from a real
// review failure (missing verdict / hallucinated findings). The orchestrator agent must
// treat that signal as "this model is napping," prefer the OTHER model immediately
// (no wasted retry), and ONLY when BOTH models are rate-limited return status
// `model_quota`. The JS then parks `model_quota` (a transient outage the host driver
// reschedules past the window — doc 05 § A3) instead of `review_error` (broken plumbing
// a human must fix). Appended to every review/certify shim prompt.
const RATE_LIMIT_SIGNAL_NOTE = `
RATE-LIMIT SIGNAL (read carefully): a cross-model shim that exits with code 75 OR prints
a line starting with "WOLFPACK_RATE_LIMITED:" is RATE-LIMITED / cooling down — NOT broken.
Do NOT retry that model; go STRAIGHT to the other (fallback) model. The shim already did
its own backoff + circuit-breaking internally, so a 75 means "stop asking this endpoint."
If the PRIMARY is rate-limited but the FALLBACK answers, proceed normally with the
fallback's verdict. If BOTH the primary AND the fallback are rate-limited (both exit 75 /
print WOLFPACK_RATE_LIMITED, or both fail with throttle/network/disconnect errors), do NOT
return missing_verdict_block — return verdict "ERROR" with status EXACTLY "model_quota".
That tells the pipeline this is a quota outage to reschedule, not a plumbing failure.`

// [06] AC2 — record WHY a primary fell back, and CLASSIFY the reason so a
// tool-box failure is graded differently from a capability failure (the spec's
// "un-confound the metrics": you can't grade a model that was starved of tools).
// A silent fallback nearly hid that Mistral never worked in run #5 — so every
// primary→fallback MUST leave a logged, classified row + a LOUD log line (a buried
// log isn't disclosure, CLAUDE.md). Appended to every review/certify shim prompt.
const FALLBACK_LOG_NOTE = `
FALLBACK LOGGING (mandatory when you fall back from the primary model to the other):
When the PRIMARY model fails and you use the FALLBACK, you MUST (a) print a LOUD log line
"WOLFPACK_FALLBACK: <role> r<round> <primary>→<fallback> reason=<reason>" to stdout, and
(b) append a row to metadata.json's "fallback_log" array (create it if absent):
  { "role": "<bloodhound|pointer|watchdog>", "round": <n>, "primary": "<gemini|mistral>",
    "fallback": "<gemini|mistral>", "reason": "<reason>", "evidence": "<short stderr/exit excerpt>" }
CLASSIFY reason as EXACTLY one of — this drives whether the failure counts against the
model's capability grade:
  • "rate_limited"  — primary exited 75 / printed WOLFPACK_RATE_LIMITED / threw a
        429/disconnect/network/timeout. A QUOTA outage, NOT a model weakness — does NOT
        count against the model's capability grade.
  • "tool_starved"  — primary ran but its tools failed: no successful tool calls, "Unknown
        tool" errors, or it grounded 0/N findings (blind/hallucinating from a re-boxed
        toolset). A TOOL-BOX artifact, NOT a capability signal — does NOT count against the
        grade; instead flag it for the toolcheck guard (the set may have re-boxed).
  • "capability"    — primary produced a malformed/missing verdict, an empty-findings
        contradiction, or empty output with tools WORKING and no rate-limit signal. A REAL
        model failure — this one DOES count against the model's grade.
  • "error"         — plumbing broke (shim crashed, file-not-found, container error). Neither
        a model nor a quota signal; surface for a human.
Pick the HIGHEST-priority reason that applies in the order rate_limited → tool_starved →
error → capability (don't grade a model down for a failure a tool box or quota caused).`

// [06] AC1 tail — diff-catch: reviewers are read-only BY ROLE, enforced by
// DETECTION not a tool fence ([06] § "un-box, enforce by role + diff-catch"). The
// reviewer's worktree mounts read-only so a source write physically fails today,
// but detect-and-flag is the durable boundary if that ever changes — a reviewer
// that edits app source is violating its role, so DETECT it loudly rather than
// letting it pass. Appended to every review shim prompt.
const DIFF_CATCH_NOTE = `
DIFF-CATCH (mandatory, run AFTER capturing the review): a reviewer must touch ONLY its own
review artifact + metadata.json, never app source. Run \`git -C <worktree> status --porcelain\`
(or \`git -C <worktree> diff --name-only\`). If ANY changed path is OUTSIDE the plan dir
(.wolfpack/plans/<slug>/) — i.e. it touches app source (billing/, records/,
controlled_substances/, scheduler/, templates, JS, etc.) — the reviewer VIOLATED its
read-only role: print a LOUD log line "WOLFPACK_REVIEWER_DIFF_VIOLATION: <files>" and append
{ "round": <n>, "role": "<role>", "files": [<paths>] } to metadata.json's
"reviewer_diff_violations" array. Do NOT silently ignore it. (Clean tree = nothing to do.)`

// [05] Part B — classify an ERROR review/certify result: a model_quota outage (both
// cross-models throttled) parks differently from a review_error (plumbing broken). Match
// the agent-set status defensively (exact "model_quota" plus throttle-ish synonyms).
const isQuotaStatus = (s) => /model_quota|quota|rate[_\s-]?limit|both.*(rate|throttl)|throttl/i.test(String(s || ''))

// [02] Compliance-review risk-surface allowlist. The post-PASS compliance gate
// (AC5) parks any hunt whose diff touches one of these surfaces for human
// sign-off BEFORE the release queue. This is a NARROW allowlist of genuinely
// risk-bearing modules, NOT a top-level `billing/` glob — billing is pervasive
// (it touches a large fraction of the app), so a directory match would park most
// hunts and turn the checkpoint into noise (docs/wolfpack-autonomy/02
// § compliance-review caveat). A UI tweak that merely imports from billing/ must
// NOT trip it. Maintain this as a REVIEWED list: a new money/tax/CS/retention
// surface is added deliberately, the same way a new migration is.
//   • controlled_substances/  — DEA receipt→disposition + retention (whole app is risk-bearing)
//   • billing/services/payments.py — Trinity/PayJunction PCI SAQ A-EP card flow
//   • billing/services/tax_engine.py — NM GRT / tax computation
//   • billing/models.py — invoice/tax-field + TaxBracket/PracticeSettings money models
//   • records/models.py — medical-record retention / soft-delete (NM 4-year rule)
const COMPLIANCE_PATHS = [
  'controlled_substances/',
  'billing/services/payments.py',
  'billing/services/tax_engine.py',
  'billing/models.py',
  'records/models.py',
]

// [02] Resumed-agent override channel. When /resolve has written human-notes.md,
// the resumed phase MUST read it first — it carries authoritative human direction
// that overrides prior plan assumptions where they conflict. Appended to every
// Claude-authored resumable phase (Spec, Alpha plan/revise, Debrief, Shepherd).
// Safe to inject unconditionally: the agent checks existence and no-ops if absent
// (the common fresh-run case), so it never invents direction that wasn't given.
const HUMAN_NOTES_DIRECTIVE = `

HUMAN DIRECTION CHANNEL: If ${planDir}/human-notes.md EXISTS, read it FIRST, before
anything else. It contains authoritative human answers written by /resolve that
OVERRIDE prior plan/spec assumptions wherever they conflict. It is append-only —
the LAST dated block is the current direction. If it does NOT exist (a normal
fresh run), ignore this and proceed; do NOT invent direction that was not given.`

// [02] Park helper. The Workflow JS cannot touch the filesystem or read a clock,
// so a tiny write-only agent stamps the park record: parked.md + the metadata
// `park` block + a `parked:<reason>` status, written ONLY to the worktree plan
// dir (the single source of truth — no main-repo mirror). /parked and /resolve
// now read the worktree plan dir directly (skill change handled separately). The
// caller then `return`s a PARKED verdict so the runner logs it and the wave
// barrier reports it. The agent ONLY writes park artifacts — it does not plan,
// fix, review, or commit. `resolutionTypeExpected` is the agent's best guess
// (clarify|redirect); /resolve can override it from the human's actual answer.
async function parkHunt({ reason, resumePhase, resolutionTypeExpected, needFromUser, context, options, phaseLabel, extraMeta }) {
  return await agent(`
You are writing a PARK record for a halted Wolfpack hunt. You ONLY write the two
park artifacts below — do NOT plan, implement, review, fix, or commit anything.

Hunt: ${slug}
Worktree: ${worktreePath}
Worktree plan dir: ${planDir}
Tier: ${tier || 'Red'}

cd to ${worktreePath}. Use ABSOLUTE paths for every write.

1. Get the timestamp YOU must stamp (the workflow JS has no clock):
   run \`date -u +%Y-%m-%dT%H:%M:%SZ\` — call the result NOW.

2. Write ${planDir}/parked.md EXACTLY in this structure (substitute NOW and fill
   the placeholders; keep the headings verbatim — /parked and /resolve parse them):

# PARKED — ${slug}

- reason: ${reason}
- parked_at: <NOW>
- resume_phase: ${resumePhase}
- resolution_type_expected: ${resolutionTypeExpected}
- tier: ${tier || 'Red'}

## What I need from you
${needFromUser}

## Context (enough to decide without opening the worktree)
${context}
${options ? `\n## Options (feeds AskUserQuestion)\n${options}\n` : ''}
3. Update ${planDir}/metadata.json:
   - set top-level "status" = "parked:${reason}"
   - add (or overwrite) a "park" block (initialize ALL fields so /resolve and the
     compliance gate never read undefined):
     { "reason": "${reason}", "parked_at": "<NOW>", "resume_phase": "${resumePhase}",
       "resolution_type": "${resolutionTypeExpected}", "tier": "${tier || 'Red'}",
       "human_notes_seen": false, "redirect_count": 0, "compliance_signed_off": false }
     EXCEPTION: if a "park" block already exists (a re-park), PRESERVE its existing
     "redirect_count" rather than resetting it to 0 — the redirect-loop guard counts
     across cycles. Preserve every other top-level field too.

${extraMeta || ''}
Do NOT commit. Do NOT push. Do NOT git add.
Return { parked: true, reason: "${reason}", parkedAt: "<NOW>" }.
${heartbeat('Park', reason)}
`, { label: `park:${slug}:${reason}`, phase: phaseLabel || 'Scaffold', schema: PARK_SCHEMA })
}

// [03] Part B — record the FLAWED_PLAN routing (plan smell) into metadata + the
// convergence ledger, then the caller returns FLAWED_PLAN so the next runner pass /
// resume re-plans (STATUS_RESUME.flawed_plan → Plan). A tiny write-only agent (the
// workflow JS has no fs); it does NOT plan, review, fix, or commit.
async function recordFlawedPlan({ phaseLabel, extraMeta }) {
  return await agent(`
You ONLY update metadata.json for Wolfpack hunt ${slug} — do NOT plan, review, fix, or commit.

cd to ${worktreePath}. Use absolute paths.

1. Edit ${planDir}/metadata.json: set top-level "status" = "flawed_plan", "phase" = "plan".
   Preserve every other field. (The worktree metadata is authoritative — do NOT
   mirror to any main-repo plan dir.)
${extraMeta || ''}
Do NOT commit. Do NOT push. Do NOT git add.
Return { ok: true }.
${heartbeat(phaseLabel || 'Review', 'recording FLAWED_PLAN (plan smell)')}
`, { label: `flawed-plan:${slug}`, phase: phaseLabel || 'Review',
     schema: { type: 'object', properties: { ok: { type: 'boolean' } } } })
}

// [03] Part B — merge the findings of N review-fanout units into one set. For the DEFAULT
// single-lens round this is a strict pass-through: the one unit's findingsList is returned
// verbatim, ids untouched, so the checklist still matches the shim's raw review-<n>.md. Only
// when ≥2 lenses actually ran does it dedup by fingerprint (keep the highest-severity
// instance), keep fingerprint-less (plan-level) findings as-is, and re-id sequentially
// (necessary because per-lens ids would otherwise collide).
function mergeFindings(done) {
  if (done.length <= 1) return (done[0] && done[0].r.findingsList) || []
  const byFp = new Map()
  const noFp = []
  const sevOf = x => SEV_RANK[String(x.severity || '').toLowerCase()] || 0
  for (const { r } of done) {
    for (const f of (r.findingsList || [])) {
      if (!f.fingerprint) { noFp.push(f); continue }
      const prev = byFp.get(f.fingerprint)
      if (!prev || sevOf(f) > sevOf(prev)) byFp.set(f.fingerprint, f)
    }
  }
  const merged = [...byFp.values(), ...noFp]
  merged.forEach((f, i) => { f.id = i + 1 })
  return merged
}

// [03] Part B — CAPPED, WORKFLOW-ORCHESTRATED PARALLEL REVIEW FAN-OUT.
// A review round MAY run multiple single-pass cross-model reviews in parallel (one per
// lens), but the fan-out is owned by THIS deterministic orchestrator — never by the
// cross-model CLI (the run-#5 failure mode: a headless reviewer spawning its own
// sub-agents timed out / blew turn limits / never emitted a verdict, silently). Each
// unit is itself single-pass (one shim, no nested fan-out) — one level only.
//
// FAILURE SURFACING + n-1 CONCURRENCY DEGRADATION: parallel() is a barrier returning
// null for any unit that throws/errors, so the orchestrator sees EXACTLY which units
// failed the moment the batch resolves — deterministically, no hang. Failed units
// re-run at a LOWER concurrency cap (3→2→1). This lowers CONCURRENCY, never coverage:
// every lens still runs, just fewer at once (failures are almost always contention /
// rate-limit, so dropping concurrency is the actual fix). Floor is cap=1 (proven-safe
// sequential single-pass); if even that fails, the caller PARKS (review_error) — never
// hang, never proceed. Each degradation step is logged with the failed unit's reason.
const REVIEW_FANOUT_CAP = 3
async function runReviewFanout({ lenses, buildPrompt, label, phaseLabel }) {
  let pending = lenses.map((l, i) => ({ ...l, idx: i }))
  let cap = Math.min(pending.length, REVIEW_FANOUT_CAP)
  const done = []
  const degradeLog = []
  let lastFailedStatuses = []   // statuses from the most recent failing iteration
  while (pending.length) {
    const results = []
    // chunk into groups of `cap` so at most `cap` units run concurrently
    for (let i = 0; i < pending.length; i += cap) {
      const chunk = pending.slice(i, i + cap)
      const res = await parallel(chunk.map(unit => () =>
        agent(buildPrompt(unit), { label: `${label}:${unit.key}`, phase: phaseLabel, schema: REVIEW_SCHEMA })))
      results.push(...res)
    }
    const failed = []
    const failedStatuses = []
    results.forEach((r, i) => {
      const unit = pending[i]
      if (r && r.verdict && r.verdict !== 'ERROR') {
        done.push({ unit, r })
      } else {
        failed.push(unit)
        const st = (r && r.status) || 'null/error'
        failedStatuses.push(st)
        degradeLog.push(`lens "${unit.key}" failed (${st})`)
      }
    })
    if (!failed.length) break
    lastFailedStatuses = failedStatuses
    if (cap <= 1) {
      // Floor reached and STILL failing — surface ERROR so the caller parks. [05] AC3:
      // PROPAGATE a quota outage so the caller parks model_quota (auto-resumable), not
      // review_error (human-gated). If ANY floored unit reported a quota/throttle status,
      // the failure was the model napping, not broken plumbing — say so. Otherwise
      // review_error (all died) / partial_review_error (some lenses succeeded).
      const quota = lastFailedStatuses.some(isQuotaStatus)
      const status = quota ? 'model_quota' : (done.length ? 'partial_review_error' : 'review_error')
      log(`⚠ review fan-out degraded to cap 1 and still failing (${status}): ${degradeLog.join('; ')}`)
      return { verdict: 'ERROR', status,
               findings: 0, findingsList: mergeFindings(done), grounded: 0, dropped: [],
               provider: null, degradeLog, unitsOk: done.length, unitsTotal: lenses.length }
    }
    cap -= 1
    log(`⚠ ${failed.length} review lens(es) failed — degrading concurrency → ${cap}, retrying the failed unit(s).`)
    pending = failed
  }
  const merged = mergeFindings(done)
  const verdict = done.some(d => d.r.verdict === 'ISSUES_FOUND') ? 'ISSUES_FOUND' : 'APPROVED'
  if (degradeLog.length) log(`Review fan-out completed after degradation: ${degradeLog.join('; ')}`)
  return {
    verdict,
    findings: merged.length,
    findingsList: merged,
    grounded: done.reduce((s, d) => s + (d.r.grounded || 0), 0),
    dropped: done.flatMap(d => d.r.dropped || []),
    provider: (done.find(d => d.r.provider) || {}).r?.provider || (done[0] && done[0].r.status) || null,
    status: (done.find(d => d.r.provider) || {}).r?.provider || null,
    degradeLog, unitsOk: done.length, unitsTotal: lenses.length,
  }
}

// ─── Phase 0.5: Spec — capture intent as acceptance.md + confidence gate ──
// [01] Spec-driven hunts. Runs between Scaffold and Plan so every downstream role
// (Alpha, Bloodhound, Tracker, Watchdog, smoke) measures against INTENT, captured
// as a checkable acceptance.md contract, rather than against Alpha's first
// interpretation — the one error the adversarial machinery is structurally blind to.
//
// Headless invariant: this workflow runs agents with NO user present, so the Spec
// agent CANNOT call AskUserQuestion. It rates confidence on the anchored checklist
// and PARKS anything that would need a load-bearing question answered — it never
// silently collapses a gap into a best-guess default. The interactive `/spec` slash
// command is where the questions actually get asked (front-loaded at batch kickoff).
// The mode_for_build verdict is the gate: autonomous/flagged proceed; parked halts
// the hunt as needs_spec (full /resolve plumbing is [02]).
let specVerdict = null
if (at('Spec')) {
phase('Spec')
log(`Spec (intent → acceptance.md): ${slug}`)

specVerdict = await agent(`
You are the Spec phase of the Wolfpack pipeline, running HEADLESSLY (no user
available — you CANNOT ask questions).

First, read your full instructions at .agents/skills/spec/SKILL.md — follow them
exactly, with this ONE headless adaptation: since no user is present you do NOT
call AskUserQuestion. Instead, rate confidence on the anchored checklist and PARK
(mode_for_build = parked) anything that would otherwise need a load-bearing
question answered. NEVER silently collapse an unanswered load-bearing gap into a
best-guess default.

Hunt slug: ${slug}
Worktree: ${worktreePath}
Plan directory: ${planDir}
Description / ticket (treat as the VERBATIM report — do NOT paraphrase it): ${description}
cd to ${worktreePath} before doing any work.

Steps:
1. Read ${planDir}/metadata.json scope fields, CLAUDE.md, and the touched app(s). Same
   read-discipline as Alpha (grep before read, targeted ranges).
2. Separate KNOWN (grounded in the report) from ASSUMED (invented to fill a gap).
3. Draft acceptance criteria — each a single checkable, user-observable statement,
   tagged [auto] / [manual] / [compliance]. Every [auto] MUST be concrete enough to
   actually run (exact URL/selector + expected DOM/network/response shape); if you
   cannot make it concrete, tag it [manual].
4. For bugs, attempt a repro test (best effort, written INSIDE the worktree).
   Record its path if it goes red, else record "NOT REPRODUCIBLE".
5. Rate each ASSUMED gap: confidence high|med|low and load_bearing yes|no.
6. Compute the confidence verdict on the anchored checklist — confidence is "high"
   ONLY IF ALL hold: ticket states the expected behavior explicitly (not just the
   symptom); (bugs) the repro test is red; NO load_bearing:yes assumption is
   confidence:low. Otherwise "med"; if the ticket is too vague to produce sharp
   questions or a load-bearing assumption is low → "low". Compliance-criticality
   does NOT lower the rating — it is a ROUTING modifier applied in step 8, not a
   confidence penalty (a clear, well-specified CS/billing ticket can still be high).
7. Determine compliance_critical = the hunt touches controlled_substances OR billing.
8. Compute mode_for_build from the routing table:
   - high + non-compliance → autonomous
   - high + compliance     → autonomous, AND set compliance_review_required = true
   - med  + non-compliance → flagged
   - med  + compliance     → parked
   - low  + any            → parked
   HARD INVARIANT (fail closed): a compliance-critical hunt may NEVER be autonomous
   without compliance_review_required = true. When the checklist is borderline, park.
9. Write acceptance.md to ${planDir}/acceptance.md using the skill's template
   (Source incl. the VERBATIM report, Intent, tagged criteria, Out of scope, rated
   Known assumptions, Repro). Keep the report verbatim.
10. Update ${planDir}/metadata.json: write the spec block
    { confidence, mode_for_build, ambiguity_open, compliance_critical,
    compliance_review_required }. If mode_for_build == "parked", ALSO set the
    top-level status to "needs_spec".

Do NOT plan, implement, or review. Do NOT commit.
${heartbeat('Spec', 'writing acceptance.md + confidence verdict')}${HUMAN_NOTES_DIRECTIVE}

Return: confidence (high|med|low), modeForBuild (autonomous|flagged|parked),
ambiguityOpen (bool), complianceCritical (bool), complianceReviewRequired (bool),
acceptanceWritten (bool — true if acceptance.md now exists), questionCount (number
of load-bearing questions a human would need to answer; 0 if fully clear), and a
one-line summary.
`, { label: `spec:${slug}`, phase: 'Spec', schema: SPEC_SCHEMA })

  // ── Confidence gate ───────────────────────────────────────────────────
  const specMode = specVerdict.modeForBuild
  // Fail closed for compliance-critical hunts: the ONLY autonomous-build path is
  // `autonomous` WITH compliance_review_required. ANYTHING else for a compliance
  // hunt — `flagged`, `autonomous` without the flag, or any unexpected value —
  // violates the routing table (med/low + compliance → parked) and MUST park.
  // (A `parked` verdict halts in the next block regardless.) This closes the
  // loophole where a mis-rated compliance hunt returning `flagged` would build
  // with no checkpoint (AC3 — compliance never reaches a no-checkpoint build).
  if (specVerdict.complianceCritical && specMode !== 'parked' &&
      !(specMode === 'autonomous' && specVerdict.complianceReviewRequired)) {
    log(`⛔ ${slug}: compliance-critical may only build as autonomous + compliance_review_required (got mode="${specMode}", flag=${!!specVerdict.complianceReviewRequired}) — failing closed → parked needs_spec`)
    return { slug, verdict: 'NEEDS_SPEC', status: 'needs_spec', tier: tier || 'Red',
             worktreePath, reason: 'compliance_without_checkpoint' }
  }
  // Fail closed: only the two known build modes proceed; `parked` AND any
  // unexpected/empty value (a malformed verdict) halt as needs_spec. Never let an
  // unrecognized mode fall through to a build (CLAUDE.md §Error Handling: ambiguous → park).
  if (specMode !== 'autonomous' && specMode !== 'flagged') {
    if (specMode !== 'parked') {
      log(`⛔ ${slug}: unexpected mode_for_build "${specMode}" — failing closed → parked needs_spec`)
    }
    log(`⏸ ${slug} PARKED needs_spec — confidence: ${specVerdict.confidence}${specVerdict.complianceCritical ? ', compliance-critical' : ''}. ${specVerdict.questionCount || 0} question(s) need a human. ${specVerdict.summary || ''}`)
    log(`   Answer the questions and re-run \`/spec ${slug}\` (or \`/resolve ${slug}\` once [02] lands). The pipeline will NOT build this hunt until it clears the gate.`)
    return { slug, verdict: 'NEEDS_SPEC', status: 'needs_spec',
             confidence: specVerdict.confidence, tier: tier || 'Yellow',
             worktreePath, questionCount: specVerdict.questionCount || 0,
             reason: specMode === 'parked' ? 'parked' : 'invalid_mode_for_build' }
  }
  if (specMode === 'flagged') {
    log(`▶ ${slug} building on FLAGGED assumptions (confidence med) — morning review surfaces them. ${specVerdict.summary || ''}`)
  } else {
    log(`▶ ${slug} spec confidence ${specVerdict.confidence} → building autonomously${specVerdict.complianceReviewRequired ? ' (compliance-review checkpoint required pre-merge)' : ''}. ${specVerdict.summary || ''}`)
  }
}

// ─── Phase 1: Alpha Planning (skipped on resume) ──────────────
if (at('Plan')) {
phase('Plan')
log(`Alpha planning: ${slug}`)

const alphaPlan = await agent(`
You are the Alpha planner in the Wolfpack pipeline, running headlessly (no user available).

First, read your full instructions at .agents/skills/alpha/SKILL.md — follow them exactly.

READ acceptance.md FIRST (at ${planDir}/acceptance.md) — it is the Spec phase's
checkable Definition of Done (Intent + tagged acceptance criteria + Out of scope +
rated Known assumptions). Your plan MUST be built to satisfy every acceptance
criterion. If the plan CANNOT satisfy a criterion, that is a FLAG to surface in
plan.md (§ Assumptions or § Proposed Deferrals), never a silent drop. Do NOT widen
scope past the criteria + their downstream consequences. (If acceptance.md is
absent — an older hunt scaffolded before the Spec phase — proceed normally but note
it in plan.md § Assumptions.)

Hunt slug: ${slug}
Worktree: ${worktreePath}
Plan directory: ${planDir}
${campaignContext ? `\n--- CAMPAIGN CONTEXT (from expedition scoping) ---\n${campaignContext}\n--- END CAMPAIGN CONTEXT ---\n` : ''}
cd to ${worktreePath} before doing any work.

Execute Phase 1 (Initial Plan):
- Read acceptance.md (the Spec contract) — plan to satisfy its criteria
- Read ${planDir}/metadata.json scope fields
- Read CLAUDE.md, AGENTS.md, TODO.md for project context
- Read .wolfpack/pedigree/index.md and .wolfpack/pedigree/lessons.md for model selection data
- [06] ROUTING — base ALL model_assignments on the data-driven router, not folklore: run
  \`node ${repoRoot}/scripts/wolfpack-routing.mjs "${planDir}"\` AFTER you've written
  predicted_dimensions + tier to ${planDir}/metadata.json. It reads those + the per-model meter
  (.wolfpack/pedigree/model-stats.json, [06] AC3) and returns the work-horse/judgment tier
  defaults overridden by capability×economics + domain (frontend→Gemini review/thorough
  verify; backend→Mistral review + thin Gemini verify), honoring the HARD constraints (Alpha
  always Opus; reviewers NEVER Claude; Pointer/Watchdog cross-family from Shepherd; never
  explore on Red/compliance). Adopt its assignments into metadata.json model_assignments
  unless you have a specific documented reason to override (note it in the Debrief). The
  meter is thin until a calibration batch accrues, so today it returns the tier defaults —
  that is correct, not a bug. Follow .agents/skills/alpha/SKILL.md § Model Pool Selection.
- Read .wolfpack/cross-cutting-debt.md for known infra issues
- Explore relevant source files based on the scope
- Write plan.md to ${planDir}/plan.md with the full Alpha plan structure
- Score predicted_dimensions (7 dimensions, 0-4 each)
- Compute tier and mode — IF the campaign specifies a tier, use it. Do NOT downgrade.
- Set bloodhound_rounds, pointer_rounds, tracker_rounds based on tier. These are a FLOOR (minimum rounds), NOT a cap: under the automated pipeline ([03] Part B convergence detection) the review loop continues past the floor while it makes progress and parks when it stalls — round COUNT no longer caps it. The per-tier floors are the single source of truth in TIER_CONFIG (Red bloodhound base=3); you may RAISE a floor for an unusually risky plan, never lower it below the tier base.
- Select the Bloodhound cross-examiner model (non-Claude — "gemini" or "mistral") using the pedigree/lessons performance + quota data; write it to ${planDir}/metadata.json model_assignments.bloodhound. This pick is binding for the whole Review phase (the runtime sticks with it), so choose deliberately — e.g. prefer Gemini for large/complex Red plans (Mistral's API drops oversized-context reviews), Mistral for smaller surfaces to spread load.
- Set review_strategy based on tier
- Update ${planDir}/metadata.json with all computed fields
- If campaign provided ticket refs, include them in the plan's scope section
- If campaign provided TODO items to clear, list them in the plan's changelog section

Pick reasonable defaults for any ambiguity. Document assumptions in plan.md.
Do NOT ask the user any questions — you are running autonomously.
${heartbeat('Plan', 'Alpha writing plan.md')}${HUMAN_NOTES_DIRECTIVE}

Return the tier, bloodhound_rounds, pointer_rounds, tracker_rounds, the chosen
Bloodhound reviewer model family as bloodhoundModel ("gemini" or "mistral" — never Claude),
and worktree path.
`, { label: `alpha:${slug}`, phase: 'Plan', schema: VERDICT_SCHEMA })

  tier = alphaPlan.tier || 'Yellow'

  // Honor Alpha's pedigree-driven reviewer pick over the campaign round-robin.
  // (unfinalize-inventory-restore stalled because the runtime ignored Alpha's
  // gemini assignment and forced blind Mistral; this is the fix.)
  setExaminer(alphaPlan.bloodhoundModel, 'Alpha pedigree assignment')

// AUTOMATED PIPELINE MINIMUM: every hunt gets at least 1 round of each review phase.
// Claude cannot be trusted without adversarial cross-model review. The tier system
// controls depth (how many rounds, how thorough) but zero rounds is never allowed
// in automated mode. Manual /hunt can still use Green fast lane.
  // [03] Part B — the per-tier base round count is the FLOOR (from TIER_CONFIG, the
  // single source of truth), not a cap: convergence detection extends past it with no
  // fixed ceiling while progress holds, and parks when it stalls. Alpha may RAISE the
  // floor; it can never lower it below the tier's base.
  bloodhoundRounds = Math.max(alphaPlan.bloodhoundRounds || 0, tierCfg(tier).baseRounds)
  pointerRounds = Math.max(alphaPlan.pointerRounds || 0, 1)
  trackerRounds = Math.max(alphaPlan.trackerRounds || 0, 1)

if ((alphaPlan.bloodhoundRounds || 0) === 0) {
  log(`⚠ Alpha set bloodhound_rounds=0 (tier: ${tier}) — overridden to 1. Automated pipeline requires adversarial review.`)
}
if ((alphaPlan.pointerRounds || 0) === 0) {
  log(`⚠ Alpha set pointer_rounds=0 — overridden to 1.`)
}
if ((alphaPlan.trackerRounds || 0) === 0) {
  log(`⚠ Alpha set tracker_rounds=0 — overridden to 1.`)
}

  log(`Tier: ${tier} | BH rounds: ${bloodhoundRounds} | Ptr rounds: ${pointerRounds} | Trk rounds: ${trackerRounds}`)
} else {
  // [02] FAIL-CLOSED tier on resume (edge case, docs/wolfpack-autonomy/02): a hunt
  // that lost its tier must NOT silently downgrade to a lighter ceremony. Prefer
  // the park-carried tier, then live metadata, then default to RED (most rounds,
  // full ceremony) rather than Yellow — over-reviewing a small hunt is cheap; under-
  // reviewing a compliance/arch hunt ships suspect code. (Was `|| 'Yellow'`.)
  tier = resumeProbe.parkTier || resumeProbe.tier || 'Red'
  bloodhoundRounds = Math.max(resumeProbe.bloodhoundRounds || 0, tierCfg(tier).baseRounds)
  pointerRounds = Math.max(resumeProbe.pointerRounds || 0, 1)
  trackerRounds = Math.max(resumeProbe.trackerRounds || 0, 1)
  setExaminer(resumeProbe.bloodhoundModel, 'resumed metadata assignment')
  log(`Resumed past Plan — tier ${tier}, rounds BH:${bloodhoundRounds} Ptr:${pointerRounds} Trk:${trackerRounds} (from metadata)`)
}

// [06 routing — BINDING] Bind the Shepherd (implementer) model deterministically from the
// work-horse/judgment tier (per scripts/wolfpack-routing.mjs: heavy = Red/Orange/compliance →
// Opus; else Sonnet). The Shepherd agent() previously spawned with NO model override, so it
// silently inherited the main-loop Opus regardless of metadata.model_assignments — Sonnet was
// never actually used. `tier` is the signal available on BOTH the fresh and resume paths;
// compliance hunts escalate to Red (→ Opus), and any non-Red compliance hunt is still gated by
// the pre-merge compliance checkpoint + cross-model Pointer/Watchdog (reviewers stay Gemini).
const shepherdModel = (tier === 'Red' || tier === 'Orange') ? 'opus' : 'sonnet'
log(`Shepherd model: ${shepherdModel} (tier ${tier}) — work-horse Sonnet on non-heavy, Opus on Red/Orange`)

// ─── Phase 2: Bloodhound Review Loop (skipped on resume) ───────
if (at('Review')) {
  phase('Review')

  let approved = false
  let round = 0
  // [03] Part B — CONVERGENCE-GATED review loop. Replaces the count-based severity
  // ceiling (CRIT_CEILING/HIGH_CEILING/roundCap++ and the "proceed-anyway-at-cap with
  // ≤HIGH open" branch are GONE — that branch is the seam [02] left open). The base
  // round count is a FLOOR; beyond it the loop CONTINUES while the review makes progress
  // (new distinct findings, count not growing) and PARKS the moment it stops —
  // oscillation, stall, a stuck critical, or the MAX_ROUNDS circuit breaker. No path
  // proceeds past an open real finding; the ONLY proceed is a clean APPROVED (AC3/AC5).
  const cfg = tierCfg(tier)
  const floor = bloodhoundRounds            // tier base (Alpha may have raised it)
  const history = { fpRounds: [], counts: [], cumulativeCritFps: new Set(), critStreak: new Map() }
  let lastFindings = []
  let lastCriticalFindings = []

  while (!approved) {
    round++
    log(`Bloodhound round ${round} (floor ${floor}, breaker ${cfg.maxRounds} rounds, plan-smell ≥${cfg.planSmellBound} distinct criticals, crit-persist ${cfg.critPersist})`)

    const planFile = round === 1 ? 'plan.md' : `plan-revised-${round - 1}.md`

    // One shim per review lens. The DEFAULT is a single comprehensive lens (current,
    // validated behavior). buildPrompt(unit) closes over the round; runReviewFanout owns
    // the fan-out + n-1 concurrency degradation (workflow-orchestrated, never CLI self-
    // orchestration). For the 'full' lens the raw file is review-${round}.md (Alpha-revise
    // + the resume probe read it); extra lenses get review-${round}-<lens>.md.
    const buildBloodhoundPrompt = (unit) => {
      const rawFile = unit.key === 'full' ? `review-${round}.md` : `review-${round}-${unit.key}.md`
      const tmpFile = unit.key === 'full' ? `/tmp/bloodhound-${slug}-r${round}.txt` : `/tmp/bloodhound-${slug}-r${round}-${unit.key}.txt`
      return `
You are a shim agent orchestrating a Bloodhound review${unit.focus ? ` (FOCUS LENS: ${unit.key})` : ''}. This hunt's assigned
cross-examiner is ${EXAMINER_LABEL[crossExaminer]}; you try it first, then
${EXAMINER_LABEL[otherExaminer]} as fallback. (Both are non-Claude — never
review with Claude.)

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
Round: ${round}
Tier: ${tier}
Plan file to review: ${planFile}

Steps:
1. cd to ${worktreePath}

2. Write the review prompt to a temp file (avoids shell escaping issues):
   Write to ${tmpFile}:
   "You are reviewing Wolfpack hunt '${slug}', round ${round}, tier ${tier}. Read the plan at ${planDir}/${planFile}. Also read TODO.md, CLAUDE.md, and .wolfpack/pedigree/index.md for context. Read metadata.json at ${planDir}/metadata.json for tier and scope. Read .agents/skills/bloodhound/SKILL.md and follow it. Produce your adversarial review following your system prompt instructions.${unit.focus ? ` ${unit.focus}` : ''} EFFICIENCY (mandatory): do NOT read whole large files — grep for the relevant symbols/lines first, then read only those ranges with a line offset/limit. Scope every grep to the relevant app directory (e.g. billing/, records/, controlled_substances/), never the repo root, or it times out. Reading entire 1000+ line files (models.py, views.py) bloats context and can crash the request mid-review.${tier === 'Red' ? ' SINGLE-PASS REVIEW (mandatory, all models): do NOT spawn sub-agents or use the task tool. Produce ONE comprehensive adversarial review covering every lens (correctness, compliance/DEA, multi-tenancy, security, edge-case/repro) in a single response, then emit the verdict block. The headless cross-model roster fan-out is disabled — the pipeline handles orchestration, not you.' : ''}${VERDICT_CONTRACT}"

3. Try PRIMARY (${EXAMINER_LABEL[crossExaminer]}) with retry:
   Attempt 1: ${reviewCmd(crossExaminer, 'wolfpack-bloodhound', tmpFile)}
   The wrapper enforces a read-only adversarial review and caps concurrent
   calls on this model at 2 (flock) to avoid rate limits. Run it EXACTLY as
   given — do not add flags or spawn it multiple times in parallel.
   An attempt FAILS if ANY of: non-zero exit, empty output, no parseable
   <verdict> block (step 6), or — for an ISSUES_FOUND verdict — every
   file-bearing finding fails the grounding check (step 7, the blind/hallucinating
   reviewer signal). On failure, wait 5 seconds and retry attempt 1 ONCE.

4. If BOTH primary attempts fail, try FALLBACK (${EXAMINER_LABEL[otherExaminer]}):
   ${reviewCmd(otherExaminer, 'wolfpack-bloodhound', tmpFile)}
   Strip ANSI escape codes from the output.

5. Write the raw output (from whichever CLI ran) to ${planDir}/${rawFile}.
6. EXTRACT THE VERDICT — strict extract-and-validate, NO prose-rescue. The
   reviewer was instructed to end with exactly one <verdict>{...}</verdict> block:
   - NO <verdict> block in the output → this attempt FAILED. Do NOT scrape a
     "## Status:" line or any prose for a verdict — that fallback ladder is REMOVED
     (it is how an ambiguous review became a false APPROVED). Move to the retry /
     fallback. If no attempt EVER yields a block, return verdict "ERROR", status
     "missing_verdict_block".
   - <verdict> block present but its JSON is malformed/unparseable → attempt FAILED;
     retry/fallback. If none parse, return "ERROR", status "malformed_verdict".
   - verdict == "ISSUES_FOUND" but findings is empty/missing → contradiction;
     attempt FAILED; retry/fallback. If unresolved, return "ERROR", status
     "empty_findings_contradiction".
   Otherwise normalize verdict to APPROVED or ISSUES_FOUND. The block's findings
   array IS findingsList — each item carries id, severity, title, file, line,
   claim, evidence (pass them through; do not re-scrape markdown headings).
7. GROUNDING CHECK — run for every finding that names a "file" (catches the
   blind/hallucinating reviewer: a finding citing a non-existent file is noise):
   a. Normalize the path: strip a leading "/workspace/" if present, then strip any
      remaining leading "/", yielding a repo-root-relative path. (A containerized
      reviewer emits /workspace/... under its mount; the shim runs on the host
      where that prefix does not exist, so without stripping every finding would be
      wrongly dropped.)
   b. test -f "${worktreePath}/<normalized-path>". Exists → GROUNDED (keep, and
      rewrite finding.file to the normalized path). Missing → DROP the finding:
      add { id, file, reason: "file_not_found" } to a \`dropped\` array and EXCLUDE
      it from findingsList.
   c. A finding with NO "file" is kept as-is (plan-level/general — nothing to ground).
   d. If verdict == ISSUES_FOUND AND at least one finding named a file AND EVERY
      file-bearing finding was dropped (0 grounded) → the whole review is suspect.
      This attempt FAILED: go to the FALLBACK model. If the fallback is ALSO 0/N
      grounded, return "ERROR", status "ungrounded_review".
   e. Prepend a grounding line to the ${planDir}/${rawFile} header:
      "grounded: <G>/<N> findings, <D> dropped" (N = file-bearing findings seen,
      G = grounded, D = dropped). List the dropped findings beneath it.
6.5 FINGERPRINT — for every GROUNDED finding compute a coarse \`fingerprint\`:
   <normalized repo-relative file path, or "plan" if the finding has no file> + ":" +
   <defect-class>. The defect-class is a 2-4 word lowercase-kebab slug naming the
   UNDERLYING defect bucket, derived from the claim/title — e.g. "missing-related-name",
   "tenant-leak", "unrounded-tax", "cs-retention-short", "pci-scope-downgrade",
   "null-deref", "missing-migration", "missing-test". CRUCIAL: the SAME underlying defect
   in the SAME file across DIFFERENT rounds MUST yield the SAME fingerprint — bucket by
   the DEFECT, not by wording or line number (the pipeline uses these to detect
   convergence vs oscillation; a defect re-described differently each round must still
   match). Put \`fingerprint\` on every finding in findingsList.
8. Update ${planDir}/metadata.json: review_round=${round}, status="reviewed",
   phase="review-${round}", and record grounded/dropped counts. Do NOT write
   review_fingerprints or convergence here — the orchestrator records those once per
   round (concurrent shim writes would race).
9. Clean up temp files: rm -f ${tmpFile}
10. Return: verdict, findings (count of GROUNDED findingsList items), findingsList
    (grounded only, each with id/severity/title/file/line/claim/evidence/FINGERPRINT),
    grounded (count), dropped (the array from step 7), and the provider that produced the
    ACCEPTED review as \`provider\` ("gemini" or "mistral"). Also set \`status\`
    to that provider.

If NO model produced an acceptable review — both CLIs failed to run, OR every run
lacked a parseable <verdict> block / was malformed / was an empty-findings
contradiction / grounded 0/N — return verdict "ERROR" with the MOST SPECIFIC status
above (missing_verdict_block | malformed_verdict | empty_findings_contradiction |
ungrounded_review). There is NO path that turns a block-less or ungrounded review
into APPROVED.
${RATE_LIMIT_SIGNAL_NOTE}
${FALLBACK_LOG_NOTE}
${DIFF_CATCH_NOTE}
${heartbeat('Review', `Bloodhound round ${round}${unit.key !== 'full' ? ' ' + unit.key : ''}`)}
`
    }

    const reviewResult = await runReviewFanout({
      lenses: cfg.reviewLenses,
      buildPrompt: buildBloodhoundPrompt,
      label: `bloodhound:${slug}:r${round}`,
      phaseLabel: 'Review',
    })

    // Stickiness: pin whichever examiner actually answered so later rounds try it
    // first (don't re-roll the primary→fallback order every round — that's how a
    // fabricating fallback slipped in on round 2 of unfinalize-inventory-restore).
    setExaminer(reviewResult.provider, `sticky: answered review round ${round}`)

    if (reviewResult.verdict === 'APPROVED') {
      approved = true
      log(`Bloodhound APPROVED at round ${round}`)
      break
    }
    if (reviewResult.verdict === 'ERROR') {
      // [03] Part B — review fan-out floored at concurrency 1 and STILL failing → PARK.
      // [05] AC3 — distinguish a QUOTA outage (both cross-models rate-limited; status
      // "model_quota") from broken PLUMBING (review_error). Quota is transient: the host
      // driver reschedules past the window reset (A3); plumbing needs a human to fix.
      // Neither hangs and neither proceeds past an open review.
      const quota = isQuotaStatus(reviewResult.status)
      const reason = quota ? 'model_quota' : 'review_error'
      log(`⏸ ${slug}: Bloodhound review failed at the concurrency floor (${reviewResult.status}). Parking ${reason}.`)
      await parkHunt({
        reason,
        resumePhase: 'Review',
        resolutionTypeExpected: 'clarify',
        phaseLabel: 'Review',
        needFromUser: quota
          ? `Both cross-model reviewers (Vibe/Mistral AND Agy/Gemini) are rate-limited / quota-exhausted, so the plan review could not run. This is transient: re-run the campaign after the window resets (the host gate auto-resumes overnight runs) — clarify to resume, or redirect if you suspect the reviewer plumbing.`
          : `Both cross-model reviewers failed to produce a usable verdict for the plan review even at sequential concurrency (cap 1) — likely a model outage or quota exhaustion. Decide: retry later (clarify → resume the review), or investigate the reviewer plumbing (redirect).`,
        context: `Review fan-out degradation log:\n${(reviewResult.degradeLog || []).map(l => `- ${l}`).join('\n') || '- (no detail captured)'}\nFinal status: ${reviewResult.status}`,
        options: quota
          ? `- A (clarify): transient quota — resume the review after the window resets.\n- B (redirect): not actually quota — fix the reviewer plumbing, then resume.`
          : `- A (clarify): transient — resume the review on the next runner pass.\n- B (redirect): reviewer plumbing is broken — fix it, then resume.`,
      })
      return { slug, verdict: 'PARKED', status: `parked:${reason}`, reason, tier, worktreePath, degradeLog: reviewResult.degradeLog }
    }

    // ── ISSUES_FOUND → classify convergence ──────────────────────────────────
    const findings = reviewResult.findingsList || []
    lastFindings = findings
    lastCriticalFindings = findings.filter(f => isCriticalSev(f.severity))
    log(`Bloodhound ISSUES_FOUND: ${findings.length} grounded finding(s)`)

    const verdictC = classifyConvergence({ round, findings, history, cfg, floor })
    commitRound(history, findings, verdictC.cumulativeCrit)
    // [06] AC3 — role-keyed ledger entry (signal/noise from grounded vs dropped).
    const bhEntry = ledgerEntry('bloodhound', round, findings, (reviewResult.dropped || []).length)
    const cumCrit = verdictC.cumulativeCrit.size

    if (verdictC.action === 'park_open_critical') {
      log(`⛔ ${slug}: ${verdictC.detail}. Parking open_critical — not implementing past a stuck critical.`)
      const critContext = lastCriticalFindings.length
        ? lastCriticalFindings.map(f =>
            `- [CRITICAL] ${f.title || '(untitled)'}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n` +
            `  claim: ${f.claim || '(none)'}\n  evidence: ${f.evidence || '(none)'}\n  fingerprint: ${f.fingerprint || '(none)'}`).join('\n')
        : `- A CRITICAL finding was open at round ${round} but its details were not captured; open ${planDir}/review-${round}.md.`
      await parkHunt({
        reason: 'open_critical',
        resumePhase: 'Review',       // clarify resumes the review loop; redirect rewinds to Plan
        resolutionTypeExpected: 'clarify',
        phaseLabel: 'Review',
        needFromUser: `A CRITICAL finding persisted across ${cfg.critPersist} consecutive review rounds — Bloodhound and Alpha could not resolve it. Decide: real and must be fixed (redirect → re-plan), out of scope / a false positive (clarify → proceed), or intent was misread (redirect → re-spec)?`,
        context: `${verdictC.detail}. Open CRITICAL finding(s) from Bloodhound round ${round} (full review: ${planDir}/review-${round}.md):\n${critContext}`,
        options: `- A (clarify): the finding is out of scope or a false positive — proceed to Debrief/Implement.\n- B (redirect): the finding is real — re-plan to address it.\n- C (redirect): intent was misread — re-spec with corrected acceptance.md.`,
        extraMeta: convergenceMetaInstruction(planDir, bhEntry, 'open_critical', cumCrit),
      })
      return { slug, verdict: 'PARKED', status: 'parked:open_critical', reason: 'open_critical', tier, worktreePath }
    }

    if (verdictC.action === 'flawed_plan') {
      // PLAN SMELL — the spec/plan is wrong, not the code: kick back to Alpha (re-plan),
      // NOT a downstream rewrite. Resume re-enters at Plan (STATUS_RESUME.flawed_plan).
      log(`⛔ ${slug}: plan smell — ${verdictC.detail}. Routing to FLAWED_PLAN (Alpha re-plans).`)
      await recordFlawedPlan({
        phaseLabel: 'Review',
        extraMeta: convergenceMetaInstruction(planDir, bhEntry, 'flawed_plan', cumCrit),
      })
      return { slug, verdict: 'FLAWED_PLAN', status: 'flawed_plan', reason: 'plan_smell', tier, worktreePath, findings: findings.length }
    }

    if (verdictC.action === 'park_non_convergence') {
      log(`⏸ ${slug}: ${verdictC.detail}. Parking non_convergence — the review is not converging.`)
      const resContext = lastFindings.length
        ? lastFindings.map(f =>
            `- [${f.severity || '?'}] ${f.title || '(untitled)'}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n` +
            `  claim: ${f.claim || '(none)'}\n  fingerprint: ${f.fingerprint || '(none)'}`).join('\n')
        : `- No findings captured from the final round; open ${planDir}/review-${round}.md.`
      await parkHunt({
        reason: 'non_convergence',
        resumePhase: 'Review',       // clarify resumes/skips review; redirect rewinds to Plan
        resolutionTypeExpected: 'clarify',
        phaseLabel: 'Review',
        needFromUser: `The plan review stopped converging (${verdictC.detail}) after ${round} rounds — Bloodhound and Alpha are not closing on agreement. Decide: are the residual findings acceptable (clarify → proceed to Debrief), or does the plan need rework (redirect → re-plan)?`,
        context: `${verdictC.detail}. Residual findings from Bloodhound round ${round} (full review: ${planDir}/review-${round}.md):\n${resContext}`,
        options: `- A (clarify): residual findings are out of scope / acceptable — proceed to Debrief.\n- B (redirect): findings are real — re-plan to address them.`,
        extraMeta: convergenceMetaInstruction(planDir, bhEntry, 'non_convergence', cumCrit),
      })
      return { slug, verdict: 'PARKED', status: 'parked:non_convergence', reason: 'non_convergence', tier, worktreePath }
    }

    // action === 'continue' → Alpha revises this round's findings, then loop.
    log(`Convergence: ${verdictC.detail} (round ${round}; cumulative distinct criticals ${cumCrit}). Alpha revising — ${findings.length} finding(s) to address.`)
    const checklist = findings
      .map(f => `[ ] Finding ${f.id} [${f.severity}]: ${f.title}${f.file ? ` (${f.file})` : ''}`)
      .join('\n')

    const revisionResult = await agent(`
You are the Alpha planner running a Phase 2 revision, headlessly.

First, read your full instructions at .agents/skills/alpha/SKILL.md — follow the Phase 2 (Revision) section.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

cd to ${worktreePath} before doing any work.

Read:
- ${planDir}/review-${round}.md (Bloodhound findings for this round)
- ${planDir}/${planFile} (the current plan)

MANDATORY: Address EVERY finding below. For each, mark ACCEPTED (explain what you changed in
the revised plan) or REJECTED (explain specifically why the finding is incorrect or out of scope).
Skipping a finding is NOT allowed — every line must have a disposition.

--- FINDINGS CHECKLIST (from Bloodhound round ${round}) ---
${checklist}
--- END CHECKLIST ---

Write ${planDir}/plan-revised-${round}.md as the complete revised plan.
Include a "## Bloodhound Response" section in the revised plan listing each finding with its disposition.
Update ${planDir}/metadata.json.

Return the findingsAddressed array with disposition (ACCEPTED or REJECTED) and justification for each.
Set allAddressed to true only if every finding has a disposition.

Do NOT ask the user. Pick reasonable defaults.
${heartbeat('Review', `Alpha revision round ${round}`)}${HUMAN_NOTES_DIRECTIVE}${convergenceMetaInstruction(planDir, bhEntry, verdictC.detail.startsWith('converging') ? 'converging' : 'continue', cumCrit)}
`, { label: `alpha-revise:${slug}:r${round}`, phase: 'Review', schema: REVISION_SCHEMA })

    const totalFindings = findings.length
    const addressed = revisionResult.findingsAddressed?.length || 0
    if (addressed < totalFindings) {
      log(`⚠ Alpha addressed ${addressed}/${totalFindings} findings — ${totalFindings - addressed} skipped`)
    } else {
      log(`Alpha addressed all ${totalFindings} findings`)
    }
  }
}

// ─── Phase 3: Debrief (skipped on resume) ─────────────────────
if (at('Debrief')) {
phase('Debrief')
log(`Alpha debrief: ${slug}`)

await agent(`
You are the Alpha running the Debrief phase (Phase 2.5), headlessly.

First, read your full instructions at .agents/skills/alpha/SKILL.md — follow the Phase 2.5 (Debrief) section.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

cd to ${worktreePath} before doing any work.

Read all review rounds and the final plan version.

Execute:
- Write ${planDir}/debrief.md summarizing accepted/rejected findings
- Write ${planDir}/plan-final.md (copy of the last accepted plan version)
- Compute and write all 6 model_assignments to ${planDir}/metadata.json
- Update ${planDir}/metadata.json: phase="implement", status="ready"

FINAL-ROUND SKIP-CHECK (mandatory — this is the safety gate for proceeding without
an explicit Bloodhound approval): open the LAST Bloodhound review round
(review-<highest N>.md). For EVERY finding in it, confirm it is either (a)
incorporated into plan-final.md, or (b) explicitly justified in debrief.md as
not-applicable/out-of-scope. There should be NO open CRITICAL here (the pipeline
hard-halts on a lingering critical before reaching Debrief) — if you somehow find
an unaddressed CRITICAL, STOP: do NOT write status="ready"; set status="flawed_plan"
and explain in debrief.md. HIGH findings must be folded into plan-final as concrete
Shepherd tasks; MEDIUM/LOW may be folded in or explicitly deferred with a reason.
List the disposition of every final-round finding in debrief.md under a
"## Final-Round Skip-Check" heading.

For model selection, use pedigree-driven algorithm from your skill.
Do NOT ask the user.
${heartbeat('Debrief', 'synthesizing plan-final')}${HUMAN_NOTES_DIRECTIVE}
`, { label: `debrief:${slug}`, phase: 'Debrief' })
}

// ─── Phase 4: Shepherd Implementation (skipped on resume) ──────
if (at('Implement')) {
phase('Implement')
log(`Shepherd implementing: ${slug}`)

// On a reviewer-bounce resume the Shepherd MUST address the specific findings, not
// blind-reimplement plan-final: a Tracker-found defect is usually test-discovered and
// absent from the plan, so a generic "implement all plan items" pass would see the code
// already present, change nothing, and re-fail the same test → loop. Point it at the
// exact report for the round that bounced it. (Pairs with BACKWARD_AUTHORITATIVE routing.)
const resumeStatus = (resumeProbe && resumeProbe.fresh === false) ? (resumeProbe.status || '') : ''
let rewriteDirective = ''
if (resumeStatus === 'test_rewrite_needed') {
  const n = resumeProbe.trackerRounds || 1
  rewriteDirective = `
REWRITE ENTRY — Tracker round ${n} (NOT a fresh build): the code is already implemented and
committed on feat/${slug}; the Tracker bounced it back. Read ${planDir}/tracker-report-${n}.md
and fix EVERY finding it lists (all severities) — do not re-scaffold or re-implement settled
plan items. After fixing, re-run your self-check (git diff main..HEAD) and commit on feat/${slug}.
`
} else if (resumeStatus === 'code_rewrite_needed') {
  const n = resumeProbe.pointerRounds || 1
  rewriteDirective = `
REWRITE ENTRY — Pointer round ${n} (NOT a fresh build): the code is already implemented and
committed on feat/${slug}; the Pointer bounced it back. Read ${planDir}/pointer-review-${n}.md
and fix EVERY finding it lists (all severities) — do not re-scaffold or re-implement settled
plan items. After fixing, re-run your self-check (git diff main..HEAD) and commit on feat/${slug}.
`
}

await agent(`
You are the Shepherd implementing a Wolfpack hunt, running headlessly.

First, read your full instructions at .agents/skills/shepherd/SKILL.md — follow them exactly.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
${rewriteDirective}
cd to ${worktreePath} before doing any work.

CRITICAL FIRST STEP: Rebase onto main to avoid worktree drift.
  cd ${worktreePath} && git fetch origin && git rebase origin/main
  If the rebase FAILS (conflict, diverged history, etc.):
  - Run: git rebase --abort
  - Return verdict "REBASE_CONFLICT" immediately — do NOT proceed with implementation
  - The user must resolve the conflict manually

Only if rebase succeeds, execute ALL Shepherd instructions:
- Read ${planDir}/plan-final.md and ${planDir}/debrief.md
- Implement all plan items
- Write ${planDir}/shepherd-log.md documenting what was done, any deviations
- Self-check: git diff main..HEAD vs plan items
- Commit on feat/${slug} with conventional commit messages
- Stage files by name only — NEVER git add . or git add -A

SAFETY RULES:
- Do NOT git push
- Do NOT deploy
- Do NOT run the test suite. Running tests is the TRACKER phase's job, not yours (your SKILL.md says this too). To confirm your code loads, the MOST you may do is a fast syntax/import check or "python manage.py check <app>" / "showmigrations <app>". NEVER invoke scripts/run_tests.sh — the full suite (especially against Cloud SQL via the proxy) can hang 30+ minutes and livelock the whole pipeline. Tracker runs the suite, scoped, in its own phase.
- Do NOT modify files outside the worktree
- Do NOT run git add . or git add -A

Do NOT ask the user. If you need to deviate from the plan, document it in shepherd-log.md.
${heartbeat('Implement', 'Shepherd coding')}${HUMAN_NOTES_DIRECTIVE}
`, { label: `shepherd:${slug}`, phase: 'Implement', model: shepherdModel })
}

// ─── Phase 5: Pointer Code Review Loop (skipped on resume) ─────
if (at('Code Review') && pointerRounds > 0) {
  phase('Code Review')

  let pointerApproved = false
  let pRound = 0
  // [03] Part B — CONVERGENCE-GATED code-review loop (same machinery as the Bloodhound
  // loop). pointerRounds is the FLOOR; convergence detection extends/parks past it.
  const pcfg = tierCfg(tier)
  const pFloor = pointerRounds
  const pHistory = { fpRounds: [], counts: [], cumulativeCritFps: new Set(), critStreak: new Map() }
  let lastPointerFindings = []

  while (!pointerApproved) {
    pRound++
    log(`Pointer round ${pRound} (floor ${pFloor}, breaker ${pcfg.maxRounds} rounds, plan-smell ≥${pcfg.planSmellBound} distinct criticals, crit-persist ${pcfg.critPersist})`)

    const buildPointerPrompt = (unit) => {
      const rawFile = unit.key === 'full' ? `pointer-review-${pRound}.md` : `pointer-review-${pRound}-${unit.key}.md`
      const tmpFile = unit.key === 'full' ? `/tmp/pointer-${slug}-r${pRound}.txt` : `/tmp/pointer-${slug}-r${pRound}-${unit.key}.txt`
      return `
You are a shim agent orchestrating a Pointer code review${unit.focus ? ` (FOCUS LENS: ${unit.key})` : ''}. This hunt's assigned
cross-examiner is ${EXAMINER_LABEL[crossExaminer]}; try it first, then
${EXAMINER_LABEL[otherExaminer]} as fallback. (Both non-Claude.)

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
Round: ${pRound}
Tier: ${tier}

Steps:
1. cd to ${worktreePath}

2. Write the review prompt to a temp file:
   Write to ${tmpFile}:
   "You are reviewing code for Wolfpack hunt '${slug}', Pointer round ${pRound}, tier ${tier}. Read plan-final.md at ${planDir}/plan-final.md and shepherd-log.md at ${planDir}/shepherd-log.md. Run 'git diff main..HEAD' to see the code changes. Read .agents/skills/pointer/SKILL.md and follow it. Produce your adversarial code review following your system prompt instructions.${unit.focus ? ` ${unit.focus}` : ''} EFFICIENCY (mandatory): work from the diff plus targeted greps — do NOT read whole large files; grep for a symbol then read only the relevant line range, and scope greps to the changed app directory (never the repo root) so they don't time out. Whole-file reads of large modules bloat context and can crash the request.${tier === 'Red' ? ' SINGLE-PASS REVIEW (mandatory, all models): do NOT spawn sub-agents or use the task tool. Produce ONE comprehensive code review covering every lens (correctness, compliance, multi-tenancy, security, edge-case/repro) in a single response, then emit the verdict block. Cross-model sub-agent fan-out is disabled — the pipeline handles orchestration.' : ''}${VERDICT_CONTRACT}"

3. Try PRIMARY (${EXAMINER_LABEL[crossExaminer]}) with retry:
   Attempt 1: ${reviewCmd(crossExaminer, 'wolfpack-pointer', tmpFile)}
   The wrapper enforces a read-only review and caps concurrent calls on this
   model at 2 (flock). Run it EXACTLY as given — no extra flags, no parallel spawns.
   An attempt FAILS if ANY of: non-zero exit, empty output, no parseable
   <verdict> block (step 6), or — for an ISSUES_FOUND verdict — every file-bearing
   finding fails the grounding check (step 7). On failure, wait 5 seconds and retry
   attempt 1 ONCE.

4. If BOTH primary attempts fail, try FALLBACK (${EXAMINER_LABEL[otherExaminer]}):
   ${reviewCmd(otherExaminer, 'wolfpack-pointer', tmpFile)}

5. Write the raw output (from whichever CLI ran) to ${planDir}/${rawFile}.
6. EXTRACT THE VERDICT — strict extract-and-validate, NO prose-rescue. The reviewer
   was instructed to end with exactly one <verdict>{...}</verdict> block:
   - NO <verdict> block → attempt FAILED. Do NOT scrape a "## Status:" line or prose
     (that fallback ladder is REMOVED). Retry/fallback; if none ever yields a block,
     return verdict "ERROR", status "missing_verdict_block".
   - block present but JSON malformed → attempt FAILED; retry/fallback; if none parse,
     "ERROR", status "malformed_verdict".
   - verdict == "ISSUES_FOUND" with empty/missing findings → contradiction; attempt
     FAILED; retry/fallback; if unresolved, "ERROR", status "empty_findings_contradiction".
   Otherwise normalize verdict to APPROVED or ISSUES_FOUND. The block's findings array
   IS findingsList (id, severity, title, file, line, claim, evidence) — pass through;
   do not re-scrape markdown headings.
7. GROUNDING CHECK — for every finding that names a "file":
   a. Normalize: strip a leading "/workspace/" then any remaining leading "/" →
      repo-root-relative (the containerized reviewer emits /workspace/... under its
      mount; the host shim has no such path, so unstripped paths would all be dropped).
   b. test -f "${worktreePath}/<normalized-path>". Exists → GROUNDED (keep, rewrite
      finding.file to the normalized path). Missing → DROP: add
      { id, file, reason: "file_not_found" } to a \`dropped\` array, EXCLUDE from findingsList.
   c. A finding with no "file" is kept as-is (plan-level/general).
   d. If verdict == ISSUES_FOUND AND ≥1 finding named a file AND every file-bearing
      finding was dropped (0 grounded) → review is suspect: this attempt FAILED, go to
      the FALLBACK model. If the fallback is also 0/N grounded, "ERROR", status
      "ungrounded_review".
   e. Prepend a grounding line to the ${planDir}/${rawFile} header:
      "grounded: <G>/<N> findings, <D> dropped"; list the dropped findings beneath it.
6.5 FINGERPRINT — for every GROUNDED finding compute a coarse \`fingerprint\`:
   <normalized repo-relative file path, or "plan" if no file> + ":" + <defect-class>.
   The defect-class is a 2-4 word lowercase-kebab slug naming the UNDERLYING defect
   bucket from the claim/title — e.g. "missing-related-name", "tenant-leak",
   "unrounded-tax", "cs-retention-short", "null-deref", "missing-test". CRUCIAL: the SAME
   underlying defect in the SAME file across DIFFERENT rounds MUST yield the SAME
   fingerprint — bucket by the DEFECT, not by wording or line number. Put \`fingerprint\`
   on every finding in findingsList.
8. Update ${planDir}/metadata.json: pointer_round=${pRound}, status per verdict, record
   grounded/dropped counts. Do NOT write review_fingerprints or convergence here — the
   orchestrator records those once per round (concurrent shim writes would race).
9. Clean up temp files: rm -f ${tmpFile}
10. Return: verdict, findings (count of GROUNDED items), findingsList (grounded only,
    each with id/severity/title/file/line/claim/evidence/FINGERPRINT), grounded (count),
    dropped (array), provider used.

If NO model produced an acceptable review — both CLIs failed, OR every run lacked a
parseable <verdict> block / was malformed / was an empty-findings contradiction /
grounded 0/N — return verdict "ERROR" with the MOST SPECIFIC status
(missing_verdict_block | malformed_verdict | empty_findings_contradiction |
ungrounded_review). No block-less or ungrounded review becomes APPROVED.
${RATE_LIMIT_SIGNAL_NOTE}
${FALLBACK_LOG_NOTE}
${DIFF_CATCH_NOTE}
${heartbeat('Code Review', `Pointer round ${pRound}${unit.key !== 'full' ? ' ' + unit.key : ''}`)}
`
    }

    const pointerResult = await runReviewFanout({
      lenses: pcfg.reviewLenses,
      buildPrompt: buildPointerPrompt,
      label: `pointer:${slug}:r${pRound}`,
      phaseLabel: 'Code Review',
    })

    setExaminer(pointerResult.provider, `sticky: answered pointer round ${pRound}`)

    if (pointerResult.verdict === 'APPROVED') {
      pointerApproved = true
      log(`Pointer APPROVED at round ${pRound}`)
      break
    }
    if (pointerResult.verdict === 'ERROR') {
      // [03] Part B — code-review fan-out floored at cap 1 and STILL failing → PARK.
      // [05] AC3 — quota outage (both cross-models throttled) parks model_quota (host
      // driver reschedules past reset); broken plumbing parks review_error.
      const quota = isQuotaStatus(pointerResult.status)
      const reason = quota ? 'model_quota' : 'review_error'
      log(`⏸ ${slug}: Pointer review failed at the concurrency floor (${pointerResult.status}). Parking ${reason}.`)
      await parkHunt({
        reason,
        resumePhase: 'Code Review',
        resolutionTypeExpected: 'clarify',
        phaseLabel: 'Code Review',
        needFromUser: quota
          ? `Both cross-model reviewers (Vibe/Mistral AND Agy/Gemini) are rate-limited / quota-exhausted, so the code review could not run. Transient: re-run after the window resets (clarify), or redirect if you suspect the reviewer plumbing.`
          : `Both cross-model reviewers failed to produce a usable verdict for the code review even at sequential concurrency (cap 1) — likely a model outage or quota exhaustion. Decide: retry later (clarify → resume the code review), or investigate the reviewer plumbing (redirect).`,
        context: `Code-review fan-out degradation log:\n${(pointerResult.degradeLog || []).map(l => `- ${l}`).join('\n') || '- (no detail captured)'}\nFinal status: ${pointerResult.status}`,
        options: quota
          ? `- A (clarify): transient quota — resume the code review after the window resets.\n- B (redirect): not actually quota — fix the reviewer plumbing, then resume.`
          : `- A (clarify): transient — resume the code review on the next runner pass.\n- B (redirect): reviewer plumbing is broken — fix it, then resume.`,
      })
      return { slug, verdict: 'PARKED', status: `parked:${reason}`, reason, tier, worktreePath, degradeLog: pointerResult.degradeLog }
    }

    // ── ISSUES_FOUND → classify convergence ──────────────────────────────────
    const pFindings = pointerResult.findingsList || []
    lastPointerFindings = pFindings
    const pCriticals = pFindings.filter(f => isCriticalSev(f.severity))
    log(`Pointer REWRITE_NEEDED: ${pFindings.length} grounded finding(s)`)

    const pv = classifyConvergence({ round: pRound, findings: pFindings, history: pHistory, cfg: pcfg, floor: pFloor })
    commitRound(pHistory, pFindings, pv.cumulativeCrit)
    const pEntry = ledgerEntry('pointer', pRound, pFindings, (pointerResult.dropped || []).length)
    const pCumCrit = pv.cumulativeCrit.size

    if (pv.action === 'park_open_critical') {
      log(`⛔ ${slug}: ${pv.detail}. Parking open_critical — not shipping past a stuck critical in the diff.`)
      const critContext = pCriticals.length
        ? pCriticals.map(f =>
            `- [CRITICAL] ${f.title || '(untitled)'}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n` +
            `  claim: ${f.claim || '(none)'}\n  evidence: ${f.evidence || '(none)'}\n  fingerprint: ${f.fingerprint || '(none)'}`).join('\n')
        : `- A CRITICAL was open at round ${pRound} but its details were not captured; open ${planDir}/pointer-review-${pRound}.md.`
      await parkHunt({
        reason: 'open_critical',
        resumePhase: 'Code Review',  // clarify resumes review; redirect → Implement rework
        resolutionTypeExpected: 'clarify',
        phaseLabel: 'Code Review',
        needFromUser: `A CRITICAL code-review finding persisted across ${pcfg.critPersist} consecutive rounds — Pointer and the Shepherd could not resolve it. Decide: real and must be fixed (redirect → Shepherd rework), out of scope / a false positive (clarify → proceed to tests), or intent was misread (redirect → re-plan)?`,
        context: `${pv.detail}. Open CRITICAL finding(s) from Pointer round ${pRound} (full review: ${planDir}/pointer-review-${pRound}.md):\n${critContext}`,
        options: `- A (clarify): out of scope / a false positive — proceed to Tracker tests.\n- B (redirect): real — send back to the Shepherd to rework.`,
        extraMeta: convergenceMetaInstruction(planDir, pEntry, 'open_critical', pCumCrit),
      })
      return { slug, verdict: 'PARKED', status: 'parked:open_critical', reason: 'open_critical', tier, worktreePath }
    }

    if (pv.action === 'flawed_plan') {
      // PLAN SMELL during CODE review — the plan/spec is wrong, not just the diff:
      // kick to Alpha (re-plan), not an endless Shepherd rewrite cycle.
      log(`⛔ ${slug}: plan smell in code review — ${pv.detail}. Routing to FLAWED_PLAN (Alpha re-plans).`)
      await recordFlawedPlan({
        phaseLabel: 'Code Review',
        extraMeta: convergenceMetaInstruction(planDir, pEntry, 'flawed_plan', pCumCrit),
      })
      return { slug, verdict: 'FLAWED_PLAN', status: 'flawed_plan', reason: 'plan_smell', tier, worktreePath, findings: pFindings.length }
    }

    if (pv.action === 'park_non_convergence') {
      log(`⏸ ${slug}: ${pv.detail}. Parking non_convergence — the diff and the reviewer are not converging.`)
      const ptrContext = lastPointerFindings.length
        ? lastPointerFindings.map(f =>
            `- [${f.severity || '?'}] ${f.title || '(untitled)'}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n` +
            `  claim: ${f.claim || '(none)'}\n  fingerprint: ${f.fingerprint || '(none)'}`).join('\n')
        : `- No findings captured from the final round; open ${planDir}/pointer-review-${pRound}.md.`
      await parkHunt({
        reason: 'non_convergence',
        resumePhase: 'Code Review',  // clarify resumes/skips review; redirect → Implement rework
        resolutionTypeExpected: 'clarify',
        phaseLabel: 'Code Review',
        needFromUser: `Pointer never converged after ${pRound} code-review rounds (${pv.detail}) — the diff and the reviewer are not closing on agreement. Decide: are the residual findings acceptable (clarify → proceed to tests), or must the Shepherd fix them (redirect → rework)?`,
        context: `${pv.detail}. Residual Pointer findings from round ${pRound} (full review: ${planDir}/pointer-review-${pRound}.md):\n${ptrContext}`,
        options: `- A (clarify): residual findings are out of scope / acceptable — proceed to Tracker tests.\n- B (redirect): findings are real — send back to the Shepherd to rework.`,
        extraMeta: convergenceMetaInstruction(planDir, pEntry, 'non_convergence', pCumCrit),
      })
      return { slug, verdict: 'PARKED', status: 'parked:non_convergence', reason: 'non_convergence', tier, worktreePath }
    }

    // pv.action === 'continue' → Shepherd reworks this round's findings, then loop.
    log(`Convergence: ${pv.detail} (round ${pRound}; cumulative distinct criticals ${pCumCrit}). Shepherd reworking — ${pFindings.length} finding(s) to address.`)
    const pointerChecklist = pFindings
      .map(f => `[ ] Finding ${f.id} [${f.severity}]: ${f.title}${f.file ? ` (${f.file})` : ''}`)
      .join('\n')

    const rewriteResult = await agent(`
You are the Shepherd addressing Pointer code review findings, running headlessly.

Read .agents/skills/shepherd/SKILL.md for your instructions.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

cd to ${worktreePath}.

Read ${planDir}/pointer-review-${pRound}.md for full context on each finding.

MANDATORY: Address EVERY finding below. For each, mark ACCEPTED (explain what code you changed)
or REJECTED (explain specifically why the finding is incorrect). Skipping a finding is NOT allowed.

--- FINDINGS CHECKLIST (from Pointer round ${pRound}) ---
${pointerChecklist}
--- END CHECKLIST ---

Commit fixes on feat/${slug}. Update ${planDir}/shepherd-log.md with the disposition of each finding.

Return the findingsAddressed array with disposition (ACCEPTED or REJECTED) and justification for each.
Set allAddressed to true only if every finding has a disposition.

SAFETY: No git push, no deploy, no git add .
${heartbeat('Code Review', `Shepherd rewrite round ${pRound}`)}${HUMAN_NOTES_DIRECTIVE}${convergenceMetaInstruction(planDir, pEntry, pv.detail.startsWith('converging') ? 'converging' : 'continue', pCumCrit)}
`, { label: `shepherd-rewrite:${slug}:r${pRound}`, phase: 'Code Review', schema: REVISION_SCHEMA, model: shepherdModel })

    const totalPtrFindings = pFindings.length
    const ptrAddressed = rewriteResult.findingsAddressed?.length || 0
    if (ptrAddressed < totalPtrFindings) {
      log(`⚠ Shepherd addressed ${ptrAddressed}/${totalPtrFindings} Pointer findings — ${totalPtrFindings - ptrAddressed} skipped`)
    } else {
      log(`Shepherd addressed all ${totalPtrFindings} Pointer findings`)
    }
  }
}

// ─── Phase 6: Tracker Tests (skipped on resume) ───────────────
// Tracker always runs in automated mode (minimums enforced above)
if (at('Test')) {
  phase('Test')
  log(`Tracker testing: ${slug}`)

  const trackerResult = await agent(`
You are the Tracker writing and running tests, headlessly.

First, read your full instructions at .agents/skills/tracker/SKILL.md — follow them exactly.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

cd to ${worktreePath} before doing any work.

Execute ALL Tracker instructions:
- Read plan-final.md, shepherd-log.md, pointer reviews, code diff
- Write tests per the tier strategy
- Run tests using: ./scripts/run_tests.sh --local
  (--local runs against the sandbox's baked-in local PostgreSQL — the script
  auto-bootstraps the cluster on first use. NO Cloud SQL, gcloud, or ADC needed.)
- Classify failures (baseline/transient/pre-existing/legitimate)
- Write ${planDir}/tracker-log.md and ${planDir}/tracker-report-1.md if needed
- Update ${planDir}/metadata.json
- Commit test files on feat/${slug}

Return verdict: "TESTS_PASS" if all tests pass, "TESTS_FAIL" if legitimate failures,
"REWRITE_NEEDED" if Shepherd needs to fix code.

SAFETY: No git push, no deploy, no git add .
Do NOT ask the user.
${heartbeat('Test', 'Tracker writing and running tests')}
`, { label: `tracker:${slug}`, phase: 'Test', schema: VERDICT_SCHEMA })

  // Gate on Tracker results — do NOT proceed to Watchdog if tests fail
  if (trackerResult.verdict === 'TESTS_FAIL' || trackerResult.verdict === 'REWRITE_NEEDED') {
    log(`Tracker: ${trackerResult.verdict}. Tests did not pass.`)
    return { slug, verdict: trackerResult.verdict, tier, findings: trackerResult.findings, worktreePath }
  }
  log(`Tracker: ${trackerResult.verdict}`)
}

// ─── Phase 7: Watchdog Certification (skipped on resume) ──────
// Declared OUTSIDE the block: the final Verify return references it, and on a
// resume-to-Verify (status already 'certified') this block is skipped — so it
// must exist at outer scope or the return throws ReferenceError.
let watchdogResult
if (at('Certify')) {
phase('Certify')
log(`Watchdog certifying: ${slug}`)

// Certification writes files (certification.md, pedigree.json). Two mechanics:
//  - Agy (--certify): full tool access in -p mode, writes directly.
//  - Vibe: read-only (--enabled-tools), so the shim writes the files from its output.
// Primary follows this hunt's assigned cross-examiner; the other is the fallback.
const agyCertifyStep = `${repoRoot}/scripts/podman-agy.sh --certify "${worktreePath}" "${planDir}" /tmp/watchdog-${slug}.txt`
// [07 §6] Cert turn budget (same correction as the review step above: disconnect was
// request-SIZE/gateway, fixed by the LEAN config — not a turn/TPM cap). A cert reads MORE
// (diff + tests + plan), so it needs at least as much room as a review; 8 was too few once
// 5 starved review. Restored to a workable budget. If a cert's content can't fit the gateway
// ceiling it should scope its reads, or it routes to Gemini (the heavier judgment role, no
// gateway ceiling here). Env-tunable.
const MISTRAL_CERTIFY_TURNS = (typeof process !== 'undefined' && process.env && process.env.WOLFPACK_MISTRAL_CERTIFY_TURNS) || '15'
const vibeCertifyStep = `${repoRoot}/scripts/podman-vibe.sh wolfpack-pointer "${worktreePath}" /tmp/watchdog-${slug}.txt ${MISTRAL_CERTIFY_TURNS}`
const watchdogPrimaryIsAgy = crossExaminer === 'gemini'
const watchdogPrimaryStep = watchdogPrimaryIsAgy ? agyCertifyStep : vibeCertifyStep
// Gemini-only autonomous mode: never fall back to Vibe/Mistral for certification.
const watchdogFallbackStep = AUTO_GEMINI_ONLY ? agyCertifyStep : (watchdogPrimaryIsAgy ? vibeCertifyStep : agyCertifyStep)

watchdogResult = await agent(`
You are a shim agent orchestrating Watchdog certification. This hunt's assigned
certifier is ${EXAMINER_LABEL[crossExaminer]} (fallback: ${EXAMINER_LABEL[otherExaminer]}).
Both are non-Claude — certification must be cross-model. Watchdog must produce
certification.md and pedigree.json:
 - If the running model is Agy/Gemini (--certify), it has full tool access and
   writes those files directly.
 - If the running model is Vibe/Mistral, it is read-only (--enabled-tools), so
   YOU (the shim) must write the files from its stdout output.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
Tier: ${tier}

Steps:
1. cd to ${worktreePath}

2. Write the Watchdog prompt to /tmp/watchdog-${slug}.txt:
   Read .agents/skills/watchdog/SKILL.md for the full Watchdog instructions.
   Build the prompt: "You are the Watchdog certifier for hunt '${slug}', tier ${tier}.
   Follow the Watchdog skill instructions.${tier === 'Red' ? ' SINGLE-PASS CERTIFICATION (mandatory, all models): do NOT spawn sub-agents or use the task tool. Run all certification lenses in ONE comprehensive pass, then emit the verdict block. Cross-model sub-agent fan-out is disabled.' : ''}
   Read plan-final.md at ${planDir}/plan-final.md,
   shepherd-log.md, debrief.md, metadata.json. Run git diff main..HEAD for the code diff.
   Read .wolfpack/known-broken-tests.md and .wolfpack/cross-cutting-debt.md.
   EFFICIENCY (mandatory): certify from the diff plus targeted greps — do NOT read whole large files; grep for a symbol then read only the relevant range, and scope greps to the changed app directory (never the repo root) so they don't time out. Whole-file reads of large modules bloat context and can crash the certification request.
   Write certification.md to ${planDir}/certification.md.
   Write pedigree.json to ${planDir}/pedigree.json.
   If PASS: append to .wolfpack/pedigree/index.md, run ./scripts/wolfpack-lessons.sh,
   commit wolfpack artifacts (git add by name, git commit).
   Update ${planDir}/metadata.json with verdict.
   SAFETY: No git push. No deploy commands.
   End your response with a <verdict> block: {verdict, plan_adherence, code_quality, test_result}"

3. Run PRIMARY certifier (${EXAMINER_LABEL[crossExaminer]}). The wrapper caps
   concurrent calls on this model at 2 (flock). Run it EXACTLY as given:
   ${watchdogPrimaryStep}
   Capture stdout for verdict parsing.
   ${watchdogPrimaryIsAgy
      ? 'Agy writes certification.md / pedigree.json directly; git restricted to diff/add/commit.'
      : 'Vibe is read-only — capture its stdout and YOU write certification.md / pedigree.json from it.'}

4. Extract the verdict from the primary, in PRIORITY ORDER:
   - If ${planDir}/certification.md exists (the model wrote it), read the verdict from the file
   - Else if stdout has a <verdict> block, parse it
   - Else if stdout has a "## Status: <VERDICT>" line or a clear PASS / REWORK / FLAWED_PLAN statement, use that
   - If none of these are present, the primary failed — go to step 5

5. If the primary failed, try FALLBACK (${EXAMINER_LABEL[otherExaminer]}):
   ${watchdogFallbackStep}
   ${watchdogPrimaryIsAgy
      ? 'Vibe fallback is read-only — capture stdout and write the certification files yourself.'
      : 'Agy fallback writes the files directly; capture stdout for the verdict.'}

6. Clean up: rm -f /tmp/watchdog-${slug}.txt

7. Update ${planDir}/metadata.json based on verdict:
   PASS: phase="done", status="certified", completed_at=$(date -Iseconds) (the REAL clock — the t_end marker; "created" is t0)
   REWORK: phase="implement", status="rework_needed"
   FLAWED_PLAN: phase="plan", status="flawed_plan"

8. On PASS only — fold timing into the scorecard (non-blocking, like the lessons
   aggregator). Run this YOURSELF on the host AFTER the certifier returns (node is
   NOT in the sandbox container — do not put this in the certifier prompt):
   \`node ${repoRoot}/scripts/wolfpack-timing.mjs "${planDir}"\`.
   It reads ${planDir}/timing.jsonl + metadata.json, writes a "timing" block into
   ${planDir}/pedigree.json, and prints a "DURATION=<…>" line plus an
   "INCOMPLETE" warning if any phase is missing a start/end. Capture the DURATION
   value and put it in the Duration column of the .wolfpack/pedigree/index.md row
   you append. If the script fails, log it and continue — timing is telemetry, not
   a gate.

8b. On PASS only — refresh the [06] per-model routing meter (host-side, non-blocking,
   same rules as step 8: run YOURSELF on the host after the certifier returns, node is
   NOT in the sandbox; pass the agent clock since the script has no Date):
   \`node ${repoRoot}/scripts/wolfpack-model-stats.mjs --stamp "$(date -Iseconds)"\`.
   It re-aggregates every .wolfpack/plans/*/pedigree.json (this hunt's now folded in:
   model_assignments, execution_scores, predicted_dimensions, and timing/review_fingerprints
   if present) into .wolfpack/pedigree/model-stats.json — per-model signal/noise/miss/spend
   sliced by domain, the substrate Alpha's router (scripts/wolfpack-routing.mjs) reads next
   run. Metrics with no source data yet are NULL (honest thinness), and the file is
   gitignored (regenerated, fail-safes to tier defaults on a fresh clone). If it fails, log
   and continue — the meter is telemetry, not a gate.

Return the verdict and which provider ran (status field).

SAFETY: No git push, no deploy.
${RATE_LIMIT_SIGNAL_NOTE}
${FALLBACK_LOG_NOTE}
${heartbeat('Certify', 'Watchdog certification')}
`, { label: `watchdog:${slug}`, phase: 'Certify', schema: VERDICT_SCHEMA })

log(`Watchdog verdict: ${watchdogResult.verdict}`)

// [05] AC3 — both certifiers rate-limited → PARK model_quota, NOT a non-PASS that
// masks a quota outage as a quality failure (REWORK/FLAWED_PLAN would wrongly send the
// hunt back to Shepherd/Alpha). Transient: the host driver reschedules past the window.
if (watchdogResult.verdict === 'ERROR' && isQuotaStatus(watchdogResult.status)) {
  log(`⏸ ${slug}: both certifiers rate-limited (${watchdogResult.status}). Parking model_quota.`)
  await parkHunt({
    reason: 'model_quota',
    resumePhase: 'Certify',
    resolutionTypeExpected: 'clarify',
    phaseLabel: 'Certify',
    needFromUser: `Both cross-model certifiers (Agy/Gemini AND Vibe/Mistral) are rate-limited / quota-exhausted, so certification could not run. Transient: re-run after the window resets (clarify), or redirect if you suspect the certifier plumbing.`,
    context: `Watchdog certify status: ${watchdogResult.status}. The code is implemented + tested; only certification is blocked on model quota.`,
    options: `- A (clarify): transient quota — resume certification after the window resets.\n- B (redirect): not actually quota — fix the certifier plumbing, then resume.`,
  })
  return { slug, verdict: 'PARKED', status: 'parked:model_quota', reason: 'model_quota', tier, worktreePath }
}

// If not PASS, stop here — user handles rework/replan
if (watchdogResult.verdict !== 'PASS') {
  return {
    slug,
    verdict: watchdogResult.verdict,
    tier,
    findings: watchdogResult.findings,
    worktreePath,
  }
}
}

// ─── Phase 7.5: Compliance-review checkpoint (AC5) ─────────────
// [02] A NARROW, policy-driven park — not triggered by a finding, but by WHAT the
// hunt touched. Runs on the path INTO Verify (whether Certify just PASSed this run
// or we resumed straight to Verify). If the diff touches a compliance risk surface
// (COMPLIANCE_PATHS) the hunt parks `compliance_review` for human sign-off BEFORE
// the release queue — honoring "PawPIMS must be RIGHT" without taxing cosmetic
// hunts. Fail-closed: if path detection is uncertain, park anyway. A prior /resolve
// sign-off (park.compliance_signed_off) short-circuits the gate so resume proceeds.
if (at('Verify')) {
  const complianceGate = await agent(`
You are the compliance-review gate for a certified Wolfpack hunt. You ONLY inspect
which paths the diff touched and whether a human already signed off — you do NOT
review, fix, certify, or commit.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

cd to ${worktreePath}.

1. Check for a prior sign-off: read ${planDir}/metadata.json. If a "park" block
   exists with "compliance_signed_off": true, return { complianceTouched:false,
   determined:true, alreadySignedOff:true, summary:"signed off by human" } — STOP.

1b. Spec-flag override (authoritative): in that same metadata.json, read
   \`spec.compliance_review_required\`. If it is true, the Spec phase ALREADY
   classified this hunt compliance-critical (e.g. it touches billing or
   controlled_substances broadly, beyond the narrow path allowlist below). Return
   { complianceTouched:true, determined:true, alreadySignedOff:false,
   touchedPaths:["spec.compliance_review_required"], summary:"Spec flagged
   compliance_review_required" } — STOP. The path allowlist in step 3 only ADDS
   to this signal; it never overrides a Spec compliance flag. (This closes the gap
   where a Spec-flagged hunt whose diff misses the narrow allowlist — e.g. an
   invoice-email feature touching billing/views.py — certified without sign-off.)

2. Compute the touched files: \`git diff --name-only main..HEAD\` (run from the
   worktree). If that fails for any reason, return determined:false (the pipeline
   fails closed and parks). Otherwise determined:true.

3. A path is COMPLIANCE-TOUCHED if it matches ANY entry of this risk-surface
   allowlist (prefix match for the directory entry, exact match for files):
${COMPLIANCE_PATHS.map(p => `   - ${p}`).join('\n')}
   This is intentionally NARROW: a file merely UNDER billing/ that is NOT one of the
   listed files does NOT count (billing is pervasive; only the listed money/tax/PCI
   surfaces are risk-bearing). controlled_substances/ counts as a whole (prefix).

4. If any touched file matches, set complianceTouched:true and write a tight
   ${planDir}/compliance-summary.md: list the matched files, quote the relevant diff
   hunks (\`git diff main..HEAD -- <file>\`, trimmed to the risk-bearing lines), and
   note each against the [compliance] criteria in ${planDir}/acceptance.md (if present).
   Keep it readable in under a minute. Do NOT commit it.

Return { complianceTouched, determined, alreadySignedOff:false, touchedPaths (the
matched files), summary (one line) }.
${heartbeat('Certify', 'compliance-review gate: scanning touched paths')}
`, { label: `compliance-gate:${slug}`, phase: 'Certify', schema: COMPLIANCE_GATE_SCHEMA })

  // Fail closed: review unless the gate EXPLICITLY determined the diff and found no
  // compliance surface. `determined !== true` (covers false AND undefined) forces a
  // park — an inconclusive or malformed gate result never silently proceeds.
  const mustReview = complianceGate.determined !== true || complianceGate.complianceTouched === true
  if (!complianceGate.alreadySignedOff && mustReview) {
    const why = complianceGate.determined === false
      ? 'path detection was inconclusive — failing closed'
      : `touches compliance risk surfaces: ${(complianceGate.touchedPaths || []).join(', ') || 'see compliance-summary.md'}`
    log(`⛔ ${slug}: compliance-review checkpoint (${why}). Parking compliance_review before the release queue.`)
    await parkHunt({
      reason: 'compliance_review',
      resumePhase: 'Verify',          // sign-off resumes straight into deploy/verify
      resolutionTypeExpected: 'clarify',
      phaseLabel: 'Certify',
      needFromUser: `This certified hunt's diff ${why}. Read the compliance summary and sign off (or send it back). DEA: CS records ≥2yr, exact unit flow. NM: medical records ≥4yr, no hard-delete. PCI: card flow is SAQ A-EP.`,
      context: `Compliance summary: ${planDir}/compliance-summary.md\nMatched surfaces: ${(complianceGate.touchedPaths || []).join(', ') || '(detection inconclusive — failing closed)'}\nFull diff: \`git -C ${worktreePath} diff main..HEAD\``,
      options: `- A (clarify): compliant — sign off, proceed to deploy + smoke.\n- B (redirect): a compliance defect — send back to re-plan/rework.`,
    })
    return { slug, verdict: 'PARKED', status: 'parked:compliance_review', reason: 'compliance_review', tier, worktreePath }
  }
  if (complianceGate.alreadySignedOff) {
    log(`✓ ${slug}: compliance review already signed off by a human — proceeding to deploy/verify.`)
  }
}

// ─── Phase 8: Deploy-Before-Merge Verification ────────────────
// Deploy the FEATURE BRANCH to dev (not main). Smoke test there.
// Main stays clean until the user manually runs /merge after verification.
phase('Verify')
log(`Deploying feat/${slug} to dev for pre-merge verification`)

const verifyResult = await agent(`
You are orchestrating pre-merge verification: deploy the feature branch to dev and run smoke tests.
This happens BEFORE merge — main stays untouched. If smoke tests fail, fixes go into the worktree
and redeploy, NOT into main.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
Tier: ${tier}

The pipeline is CERTIFIED and ready for pre-merge verification.
The user needs to deploy the feature branch to dev and smoke test before merging to main.

Steps:

1. READ SMOKE TESTS:
   Read ${planDir}/smoke-tests.md (written by Watchdog).
   If no smoke-tests.md exists, note that no smoke tests were defined.
   Summarize the smoke test steps that need to be run after deploy.

2. SURFACE THE DEPLOY COMMAND:
   The user needs to deploy the feature branch from the worktree. The deploy-dev shell
   function is hard-coded to deploy from the main repo, so for feature-branch verification
   the user should run these commands manually:

   cd ${worktreePath}
   VERSION=$(git describe --tags --always 2>/dev/null || echo "dev-${slug}")
   timeout 600s gcloud run deploy pawpims-dev --source . --region us-central1 --update-env-vars "APP_VERSION=$VERSION,APP_ENVIRONMENT=dev"
   IMAGE=$(gcloud run services describe pawpims-dev --region us-central1 --format="value(spec.template.spec.containers[0].image)")
   gcloud run jobs update migrate-dev --image "$IMAGE" --region us-central1
   gcloud run jobs execute migrate-dev --region us-central1 --wait

   NOTE: These deploy commands are INTENTIONALLY user-only. The PreToolUse hook
   blocks 'gcloud run deploy pawpims-*' to enforce the image-invariant rule.
   Do NOT attempt to run these — surface them for the user to copy-paste.

3. PREPARE SMOKE TEST EXECUTION:
   If Chrome DevTools MCP tools are available, prepare to run smoke tests automatically
   after the user confirms the deploy completed:
   - List each smoke test step with the URL, actions, and expected outcomes
   - Note which tests can be automated (navigate, click, screenshot) vs manual

4. REPORT READINESS:
   Return verdict "READY_FOR_DEPLOY" with:
   - The deploy commands the user needs to run
   - The smoke test summary
   - The worktree path for reference
   - status: "awaiting_user_deploy"

The pipeline PAUSES here. The user will:
1. Run the deploy commands
2. Confirm deploy completed
3. The user (or a follow-up agent) runs smoke tests
4. If smoke tests pass → /merge
5. If smoke tests fail → fix in worktree, redeploy, retest

SAFETY:
- Do NOT run gcloud deploy commands (hook-blocked, user-only)
- Do NOT merge to main
- Do NOT git push
${heartbeat('Verify', 'preparing deploy commands and smoke steps')}
`, { label: `verify:${slug}`, phase: 'Verify', schema: VERDICT_SCHEMA })

log(`Verification phase: ${verifyResult.verdict}`)
log(`Pipeline complete for ${slug}. Awaiting user deploy + smoke + /merge.`)

return {
  slug,
  verdict: 'CERTIFIED_AWAITING_DEPLOY',
  tier,
  findings: watchdogResult?.findings,
  worktreePath,
  status: verifyResult.status,
}
