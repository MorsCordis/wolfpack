export const meta = {
// Wolfpack hunt pipeline — the canonical, durable orchestrator. Consuming projects run a GENERATED, stamped copy (`bash <pack>/install.sh --consumer <repo>`), checked at run start; wolfpack itself runs this file via its .claude/workflows link. Project specifics come from the consuming repo's wolfpack-config.md (scripts/wolfpack-config.mjs) — never hard-code one project's values here. Execution shims resolve from WOLFPACK_HOME (env, else wolfpack-config.md → Wolfpack home), never the consuming repo.
  name: 'hunt-pipeline',
  description: 'Run a full Wolfpack hunt pipeline: scaffold through certification',
  phases: [
    { title: 'Scaffold', detail: 'Create hunt directory, metadata, worktree' },
    { title: 'Spec', detail: 'Capture intent as acceptance.md; confidence gate (build vs park)' },
    { title: 'Plan', detail: 'Alpha writes implementation plan' },
    { title: 'Review', detail: 'Bloodhound reviews via the cross-family examiner chain (GLM → Mistral), Alpha revises' },
    { title: 'Debrief', detail: 'Alpha synthesizes plan-final' },
    { title: 'Implement', detail: 'Shepherd implements code in worktree' },
    { title: 'Code Review', detail: 'Pointer reviews diff via the cross-family examiner chain' },
    { title: 'Test', detail: 'Tracker writes and runs tests' },
    { title: 'Certify', detail: 'Watchdog certifies via the cross-family examiner chain' },
    { title: 'Verify', detail: 'Deploy feat branch to dev, smoke test before merge' },
  ],
}
// pack-install-model: THIS script's own stamp. The canonical carries the null form; the pack's
// generator (scripts/wolfpack-workflows.mjs, run by install.sh) replaces exactly this one line in
// a consumer's copy with {workflow, commit, version, source}. Keep it unique and on one line.
const WOLFPACK_STAMP = null // wolfpack-stamp — generated copies carry {workflow, commit, version, source}; see scripts/wolfpack-workflows.mjs

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
    // Watchdog: the examiner family that actually certified (glm | mistral | claude last-resort) —
    // checked against the code writer's family by the cross-family runtime invariant.
    provider: { type: 'string' },
    // seat-profiles-into-pack: tool-access evidence for the accepted link. deniedTools = the
    // fixed TOOL_DENIAL_PATTERN grep over the shim's .out/.err (claude link: []); toolAccess =
    // the seat's own <verdict> "tool_access" self-report, passed through verbatim. The JS
    // derives audit_only from these (auditEvidence) — the shim agent never decides it.
    auditOnly: { type: 'boolean' },
    deniedTools: { type: 'array', items: { type: 'string' } },
    toolAccess: {
      type: 'object',
      properties: {
        shell: { type: 'string' },
        denied_tools: { type: 'array', items: { type: 'string' } },
      },
    },
    // seat-handoff-writes: the artifact(s) the shim delivered for the accepted link
    // (WOLFPACK_ARTIFACT_DELIVERED lines); [] when the claude link wrote them itself.
    artifacts: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, sha256: { type: 'string' } } } },
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
    // The examiner family that produced the ACCEPTED review: "glm" | "mistral" | "claude"
    // (the last-resort link). The orchestrator asserts it is NOT the reviewed artifact's
    // writer family and IS inside this seat's chain (cross-family runtime invariant), and
    // parks loud if it is a writer family, outside the chain, or unresolvable.
    provider: { type: 'string' },
    // seat-profiles-into-pack: tool-access evidence for the accepted link. deniedTools = the
    // fixed TOOL_DENIAL_PATTERN grep over the shim's .out/.err (claude link: []); toolAccess =
    // the seat's own <verdict> "tool_access" self-report, passed through verbatim. The JS
    // derives audit_only from these (auditEvidence) — the shim agent never decides it.
    auditOnly: { type: 'boolean' },
    deniedTools: { type: 'array', items: { type: 'string' } },
    toolAccess: {
      type: 'object',
      properties: {
        shell: { type: 'string' },
        denied_tools: { type: 'array', items: { type: 'string' } },
      },
    },
    grounded: { type: 'number' },   // file-bearing findings that grounded out (file exists)
    // seat-handoff-writes: the artifact(s) the shim delivered for the accepted link
    // (WOLFPACK_ARTIFACT_DELIVERED lines); [] when the claude link wrote them itself.
    artifacts: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, sha256: { type: 'string' } } } },
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
    trackerModel: { type: 'string' },   // P9/AC22: the Tracker WRITES tests, so its family is a writer
    // [02] park awareness — populated when status is `parked:<reason>`
    parkReason: { type: 'string' },       // the <reason> suffix, or null
    parkResumePhase: { type: 'string' },  // metadata.park.resume_phase, or null
    parkTier: { type: 'string' },         // metadata.park.tier (fail-closed tier carry), or null
    resolutionType: { type: 'string' },   // metadata.park.resolution_type, or null
    humanNotesPresent: { type: 'boolean' },// human-notes.md exists (a /resolve answer landed)
    driftWarning: { type: 'string' },      // [Fix 3] diagnostic: main/worktree divergence one-liner, else null
    latestRevisedPlan: { type: 'number' }, // highest K of plan-revised-K.md in the plan dir, else 0
    baseBranch: { type: 'string' },        // chain mode: metadata.base_branch, else "" (campaign-chain-mode)
  },
  // latestRevisedPlan is REQUIRED: as an optional field the probe silently dropped it and a
  // resumed review restarted at round 1 (wave 2, second relaunch). baseBranch is REQUIRED for
  // the same reason: a dropped field would silently diff a chain-mode hunt against main.
  required: ['fresh', 'latestRevisedPlan', 'baseBranch'],
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
    complianceCritical: { type: 'boolean' },// touches a declared compliance area (wolfpack-config.md)
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
// Shared read-modify-write clause for every prompt that tells an agent to update
// metadata.json — the heartbeat stamp writes usage fields there between phases, and a
// whole-file rewrite would clobber them (e.g. the Plan phase's usage_delta.start).
const META_PRESERVE_NOTE = '(read-modify-write: preserve every field you did not compute, including `usage_delta`, `usage_offload` and `mistral_rate_limits`)'
const convergenceMetaInstruction = (planDirArg, entry, classification, cumulativeCriticals) => `

CONVERGENCE LEDGER (record only — do NOT act on these findings): update ${planDirArg}/metadata.json ${META_PRESERVE_NOTE}:
- ensure top-level "review_fingerprints" is an OBJECT keyed by role; ensure review_fingerprints["${entry.role}"] is an array; SET index [${entry.round - 1}] (round ${entry.round}) to:
  ${JSON.stringify(entry)}
  (one entry per review round, per role — preserve every other index AND the other role's array. If review_fingerprints is currently an array from an older run, replace it with { "${entry.role}": [<that array's entries>] } keyed by role first.)
- set top-level "convergence" = { "classification": "${classification}", "cumulative_distinct_criticals": ${cumulativeCriticals}, "rounds": ${entry.round} }
Preserve every other field. (The worktree plan dir is the single source of truth — do NOT mirror to any main-repo plan dir; /merge handles that.)`

// Accept an args OBJECT (campaign-runner, /run-hunt-local), its JSON string (the container
// launcher's -p prompt), or a BARE SLUG string — the Workflow tool's auto-generated
// "Run the hunt-pipeline workflow" invocation passes the slug alone, and JSON.parse on it used
// to crash the run before any phase started. A bare slug can only RESUME an already-scaffolded
// hunt; scaffolding a new one without a description fails loud below.
const _parseArgs = (a) => {
  if (typeof a !== 'string') return a || {}
  const t = a.trim()
  return t.startsWith('{') ? JSON.parse(t) : { slug: t }
}
const _args = _parseArgs(args)
const { slug, campaign, tier: campaignTier, mode: campaignMode,
        ticketRefs, todoItemsCleared, migrationRisk, rationale, usageOffload, baseBranch: argBase } = _args
const descriptionPassed = typeof _args.description === 'string' && _args.description.trim() !== ''
const description = descriptionPassed
  ? _args.description
  : '(not passed in args — read the hunt\'s metadata.json "description" field and use it VERBATIM)'

// The slug is interpolated into worktree paths, branch names, /tmp files and shell
// commands. Fail LOUD at hunt start on anything outside the safe charset rather than
// quoting our way around a hostile/garbled value later.
if (!/^[a-z0-9][a-z0-9-]*$/.test(String(slug || ''))) {
  throw new Error(`hunt-pipeline: invalid slug ${JSON.stringify(slug)} — must match ^[a-z0-9][a-z0-9-]*$ (it is used in shell commands and paths)`)
}

// Chain mode (campaign-chain-mode): the campaign runner passes baseBranch "campaign/<slug>" — a
// LOCAL integration branch the hunt forks from, rebases onto and diffs against (never pushed).
// Validated like the slug: it is interpolated into git commands.
if (!(argBase == null || /^campaign\/[a-z0-9][a-z0-9-]*$/.test(argBase))) {
  throw new Error(`hunt-pipeline: invalid baseBranch ${JSON.stringify(argBase)} — must be campaign/<slug> (^campaign\\/[a-z0-9][a-z0-9-]*$) or absent`)
}

// POSIX single-quote a value for a shell command string: 'it'\''s' form. Every path /
// prompt-file / agent name interpolated into a command the shim agents run goes through
// this (defense in depth on top of the slug charset check).
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

// Capability marker read by campaign-runner (via its preflight) to detect a STALE
// generated runtime copy. protocol 2 = examiner chain + glm family (the FLOOR the runner
// still accepts); protocol 3 = gemini retired, chain glm -> mistral -> claude(last resort).
// A consumer copy below LATEST degrades loudly (STALE PIPELINE warning), below the FLOOR
// it fails loud — see campaign-runner.js.
// WOLFPACK_EXAMINER_PROTOCOL=3
// usage-limit-gate: usage protocol 1 = honors args.usageOffload (records metadata.usage_offload,
// GLM Shepherd on every tier + Claude final review on Red/compliance) and stamps usage into
// every host-side heartbeat + metadata.usage_delta. campaign-runner warns when it is absent.
// WOLFPACK_USAGE_PROTOCOL=1
// campaign-chain-mode: chain protocol 1 = honors args.baseBranch (fork from / rebase onto / diff
// against campaign/<slug>, merge-and-await compliance, no per-hunt Verify). campaign-runner's
// chain mode refuses to start without it (a stale copy would fork from main).
// WOLFPACK_CHAIN_PROTOCOL=1
// seat-profiles-into-pack: seats protocol 1 = the seat toolcheck runs as a preflight (profile ×
// shim parity, park toolcheck_failed) and review/certify seats record audit_only (an Orange/Red
// audit-only certification parks audit_only_certification). Documentation only.
// WOLFPACK_SEATS_PROTOCOL=1 — toolcheck preflight + audit_only
const EXAMINER_PROTOCOL = 3
void EXAMINER_PROTOCOL
const CHAIN_PROTOCOL = 1
void CHAIN_PROTOCOL

// Git trailer stamped on every Shepherd AND Tracker commit ("Wolfpack-Writer: glm|claude|
// mistral") — the DURABLE, git-side code-writer record. Tests are code on the branch, so the
// Tracker stamps it too (P9/AC22). The resume probe reads it back and unions it with
// metadata.shepherd_families / metadata.test_writer_families, so losing metadata can never let
// a family review its own code.
const WRITER_TRAILER = 'Wolfpack-Writer'

// ─── Examiner CHAIN (reviewer families, in fallback order) ───────────────────
// Every review seat (Bloodhound, Pointer, Watchdog) walks an ORDERED chain of examiner
// families and falls to the next link when one is rate-limited (shim exit 75 /
// WOLFPACK_RATE_LIMITED) or fails; chain exhausted by rate limits → park model_quota.
//   glm     — Vibe/GLM (GLM 5.3 via the Mistral API). On by default; WOLFPACK_ENABLE_GLM=0 off.
//   mistral — Vibe/Mistral Large 4. On by default; WOLFPACK_ENABLE_MISTRAL_AUTO=0 off.
//   claude  — LAST RESORT ONLY. Not a shim: the orchestrating agent IS Claude, so this link
//             means "review it yourself". Admitted purely by the cross-family rule — it is
//             filtered out whenever a Claude wrote the artifact, which is always true for
//             Bloodhound (Alpha is Claude). Never the preferred examiner; always last.
// gemini/agy is RETIRED (2026-10-15). familyOf() still recognizes the strings so historical
// metadata/pedigree rows resolve to a family, but gemini is never in EXAMINER_ORDER.
// CROSS-FAMILY RULE — THE GOLDEN RULE (never relaxes): the chain for a seat is the enabled
// order MINUS every family that WROTE the artifact under review — Bloodhound excludes the
// planner's family (Alpha = Claude), Pointer/Watchdog exclude every family that wrote code
// OR TESTS this hunt (codeWriterFamilies: the realized Shepherd, a Claude fallback that
// actually fired, and the Tracker). A seat never reviews its own family's work; an empty
// chain parks loud, it never falls back same-family.
// The campaign runner's per-hunt hint (_args.crossExaminer) and Alpha's pedigree pick
// only ROTATE an eligible family to the front (preferredExaminer); they can't re-admit
// an excluded or disabled one, and they can never rotate claude forward.
const _env = (k) => ((typeof process !== 'undefined' && process.env) ? process.env[k] : undefined)
// Shared unset/""/"1"/"true" gate so both family switches behave identically — and so a
// deliberate "=0" finally means OFF (the old `!!_env(...)` test made "0" truthy).
const _enabledGate = (k) => {
  const v = _env(k)
  if (v === undefined || v === null) return true
  const t = String(v).trim().toLowerCase()
  return t === '' || t === '1' || t === 'true'
}
const MISTRAL_AUTO = _enabledGate('WOLFPACK_ENABLE_MISTRAL_AUTO')   // default ON
const GLM_ENABLED  = _enabledGate('WOLFPACK_ENABLE_GLM')            // default ON
const EXAMINER_ORDER = ['glm', 'mistral', 'claude']
  .filter(f => (f === 'glm' && GLM_ENABLED) || (f === 'mistral' && MISTRAL_AUTO) || f === 'claude')
const EXAMINER_LABEL = { glm: 'Vibe/GLM', mistral: 'Vibe/Mistral Large 4', claude: 'Claude (last resort)' }

// Map a model-assignment string to its family, or null if unrecognized. glm is matched
// FIRST: GLM runs through Vibe on the Mistral API, so "Vibe/GLM", "glm:5.3", "glm-5.3",
// "zai-glm-5-3", "mistral:zai-glm-5-3" must never fall into the vibe/mistral branch.
// Claude strings resolve to 'claude' (a WRITER family, and a last-resort examiner only as
// the final chain link).
const familyOf = (m) => {
  if (!m) return null
  const s = String(m).toLowerCase()
  if (s.includes('glm')) return 'glm'
  // LEGACY-ONLY: recognized for historical metadata/pedigree rows, NEVER in EXAMINER_ORDER.
  if (s.includes('gemini') || s.includes('agy')) return 'gemini'
  if (s.includes('mistral') || s.includes('vibe')) return 'mistral'
  if (s.includes('claude') || s.includes('opus') || s.includes('sonnet') || s.includes('haiku')) return 'claude'
  return null
}
// Examiner family (non-Claude) or null. Used to honor Alpha's reviewer assignment and
// to pin the examiner that actually answered (stickiness).
const providerOf = (m) => { const f = familyOf(m); return f && f !== 'claude' ? f : null }

// The planner (Alpha) is always Claude — Bloodhound's excluded writer family.
const PLAN_WRITER_FAMILIES = new Set(['claude'])
// Families that have ACTUALLY written code on this hunt's branch (Pointer/Watchdog exclusions).
// Starts EMPTY: 'claude' is an examiner link now, so an unconditional claude seed would filter
// the last-resort link out of every code-review chain. Filled ONLY from the realized record —
// metadata.shepherd_families u metadata.test_writer_families u git Wolfpack-Writer trailers
// (the seat probe), noteGlmStep() when GLM wrote, noteClaudeWrote() when Claude (seat or
// fallback) wrote, noteTrackerWrote() when the Tracker wrote tests.
const codeWriterFamilies = new Set()

// Fail-safe (AC18): a CODE-review chain is about to be built and we have NO writer record at all —
// a crash before metadata/trailers persisted (resumed at OR past Implement), or a seat probe
// skipped because GLM is disabled. We cannot prove who wrote, so assume the Claude Shepherd did:
// the conservative reading, and exactly what the old unconditional seed asserted. Never silent.
let codeWriterFallbackWarned = false
const ensureCodeWriterRecord = () => {
  if (codeWriterFamilies.size > 0) return
  codeWriterFamilies.add('claude')
  if (codeWriterFallbackWarned) return
  codeWriterFallbackWarned = true
  log(`⚠ ${slug}: no code-writer record at code-review dispatch — assuming claude wrote the code; the claude examiner link is filtered from the code-review chains.`)
}

// P9/AC22 — THE TRACKER IS A CODE WRITER. wolfpack-config.md section Overrides permits a
// reviewer-b Tracker on Green/Blue, so the writer record must follow the SEAT, not a literal.
// Today the Test phase is an in-process Claude agent() with no Vibe/shim path, so this resolves
// to 'claude'; an unresolvable assignment stays 'claude', the conservative value (it can only
// REMOVE an examiner link, never add one). Resolved from metadata by the resume probe and
// refreshed by the Shepherd-seat probe; the realized provider on the Tracker's own result wins
// over both in noteTrackerWrote().
let trackerFamily = 'claude'
let testWriterRecorded = false   // set by noteTrackerWrote() or by the seat probe's union

// AC22 / Risk 6: reaching Certify does NOT prove a Test phase ran — Green tier skips Tracker
// entirely (docs/wolfpack.md tier table: "trust-Shepherd") yet still certifies. So this is a
// deliberate over-seed, not an inference: if neither channel recorded a test writer, assume the
// Tracker seat's family wrote. Worst case (Green) it REMOVES an examiner link that was
// legitimately live, and says so in the log; it can never ADD one. Over-seeding is the safe
// direction — do not "tighten" this into a claim that Certify implies Test.
const ensureTestWriterRecord = () => {
  if (testWriterRecorded) return
  testWriterRecorded = true
  codeWriterFamilies.add(trackerFamily)
  log(`⚠ ${slug}: no test-writer record at Certify dispatch — assuming ${trackerFamily} wrote the tests; that examiner link is filtered from the Watchdog chain.`)
}

let preferredExaminer = (() => {
  const p = providerOf(_args.crossExaminer)
  // AC16: claude is the last-resort link — a hint can never make it the preference.
  return p && p !== 'claude' && EXAMINER_ORDER.includes(p) ? p : 'glm'
})()

// The ordered chain for a seat whose artifact was written by `writers` (a Set/array of
// families). Preferred examiner rotated to the front when eligible.
const examinerChain = (writers) => {
  const ex = new Set([...writers].map(w => familyOf(w) || w))
  const base = EXAMINER_ORDER.filter(f => !ex.has(f))
  const rotated = base.includes(preferredExaminer)
    ? [preferredExaminer, ...base.filter(f => f !== preferredExaminer)] : base
  // AC16 — claude is last-resort ONLY. Re-append rather than trust ordering.
  return rotated.includes('claude')
    ? [...rotated.filter(f => f !== 'claude'), 'claude'] : rotated
}
const chainLabel = (chain) => chain.map(f => EXAMINER_LABEL[f]).join(' → ') || '(none)'

// Pin the preferred (first-tried) examiner. Idempotent; ignores unrecognized/Claude/
// disabled inputs so a bad value never blanks the chain. The chain filter still removes
// it for any seat reviewing its own family's work.
const setExaminer = (provider, why) => {
  const p = providerOf(provider)
  if (!p || p === preferredExaminer) return
  if (!EXAMINER_ORDER.includes(p)) {
    log(`Examiner ${p} ignored (${why}) — disabled by env gate (enabled: ${EXAMINER_ORDER.join(', ')})`)
    return
  }
  preferredExaminer = p
  log(`Preferred examiner → ${EXAMINER_LABEL[p]} (${why})`)
}

// RUNTIME CROSS-FAMILY INVARIANT. Called on every non-ERROR review/certify result: every
// family that produced an accepted unit must resolve, be in the seat's chain, and NOT be
// a writer family of the reviewed artifact. Returns null when sound,
// else a reason string — the caller PARKS (fail loud) instead of trusting a same-family
// (or unattributable) review.
// AC18: the blanket `f === 'claude'` rejection is GONE — the three checks below ARE the whole
// invariant now. A Claude answer is a violation exactly when a Claude wrote the artifact (the
// writer-family arm) or when the seat's chain never included claude (the in-chain arm). Do NOT
// weaken either: the in-chain check is what stops a shim improvising Claude on a seat whose
// chain excluded it.
const crossFamilyViolation = (result, writers, chain) => {
  const provs = (result && Array.isArray(result.providers) && result.providers.length)
    ? result.providers : [result && (result.provider || result.status)]
  for (const p of provs) {
    const f = familyOf(p)
    if (!f) return `reviewer family unresolvable (provider="${p || ''}") — cannot prove cross-family review`
    if ([...writers].includes(f)) return `review produced by ${f}, the SAME family that wrote the artifact (writers: ${[...writers].join(', ')})`
    if (!chain.includes(f)) return `review produced by ${f}, outside this seat's examiner chain [${chain.join(', ')}]`
  }
  return null
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
// usage-limit-gate (A-4): the usage meter CLI. Relative until repoRoot is known (Scaffold
// runs from the main repo root, where the relative path resolves); reassigned to the
// ABSOLUTE main-repo path right after repoRoot is computed, so a stale worktree lacking the
// script still stamps. (repoRoot is a later const — never reference it in heartbeat(): TDZ.)
let usageCli = 'scripts/wolfpack-usage.mjs'
// wolfpack-self-hosting (AC10): the consuming project's resolved wolfpack-config.md
// (scripts/wolfpack-config.mjs --json), loaded by the project-config probe right after
// phase('Scaffold'). Every project-specific value (test command, compliance surfaces,
// deploy step, worktree links) reads through cfg() — use-before-load throws.
let projectConfig = null
const cfg = () => {
  if (!projectConfig) throw new Error('hunt-pipeline: project config used before the project-config probe')
  return projectConfig
}
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
  // usage-limit-gate (AC7/AC8/AC9): stamp the live usage into the heartbeat (and, for timed
  // phases, metadata.usage_delta + mistral_rate_limits). GUARDED: containerized Vibe seats
  // have no main repo mounted and a read-only plan dir, so the guard skips them silently;
  // the end reading is therefore the last HOST-SIDE phase boundary.
  const stampGuard = timed
    ? `[ -f "${usageCli}" ] && [ -w "${worktreePath}/.wolfpack/plans/${slug}" ]`
    : `[ -f "${usageCli}" ]`
  const stampCmd = `if ${stampGuard}; then node "${usageCli}" stamp --heartbeat .wolfpack/heartbeats/${slug}.json${timed ? ` --plan-dir "${worktreePath}/.wolfpack/plans/${slug}"` : ''}; fi`
  return `
HEARTBEAT + TIMING: Before doing anything else, run \`mkdir -p .wolfpack/heartbeats${planDirMk}\`, write this JSON to .wolfpack/heartbeats/${slug}.json:
{"hunt":"${slug}","phase":"${phaseName}","detail":"${detail}","agent":"starting"}${startMarker}
then stamp the usage meter into it:
${stampCmd}
Update the heartbeat "agent" field to "working" after you begin (preserve every other heartbeat field when you update \`agent\`). When you finish this phase, set the heartbeat "agent" field to "done"${endMarker}
and run the usage stamp again:
${stampCmd}
USAGE STAMP: if the guard skips it, that is expected in a sandboxed seat — do not mention it. If the command itself fails, carry on and say so in your result: the usage meter is telemetry.

TOOLING POLICY (every phase): Do NOT use the chrome-devtools MCP or any browser automation
(new_page / navigate_page / take_snapshot / etc.). This is a headless BUILD pipeline — there
is no local server to drive, and the deployed dev environment runs the OLD code (this hunt is
unmerged), so browsing it verifies nothing and just spawns a browser on the operator's screen.
Tests run ONLY via \`${cfg().testCommand}\` (the project's test command — wolfpack-config.md → Project Identity → Test command). Browser/UI smoke is a SEPARATE,
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

// wolfpack-self-hosting (AC10) — PROJECT-CONFIG PROBE. The Workflow script has no
// filesystem access, so one read-only agent runs the deterministic reader and relays its
// JSON verbatim. Fail closed: a missing/incomplete config, a garbled relay or a dead seat
// THROWS (the hunt may not be scaffolded yet — nothing to park into). The pipeline never
// guesses a project value.
const PROJECT_CONFIG_SCHEMA = { type: 'object', properties: { exitCode: { type: 'number' }, output: { type: 'string' } }, required: ['exitCode', 'output'] }
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
const loadProjectConfig = async (who, consequence, label, phaseName) => {
  const pc = await agent(`You ONLY read this project's Wolfpack config — modify nothing. From the repo root (your starting directory), run exactly:
  node scripts/wolfpack-config.mjs --json wolfpack-config.md 2>&1; echo "CONFIG_RC=$?"
Return exitCode = the number after CONFIG_RC= and output = the command's stdout+stderr VERBATIM, minus the CONFIG_RC line.
If the command could not run at all, return exitCode 2 and the error text as output. Never create, fix or edit anything.`,
    { label, phase: phaseName, model: 'sonnet', schema: PROJECT_CONFIG_SCHEMA })
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
    throw new Error(`${who}: wolfpack-config.md is missing or incomplete — ${consequence}. ${why}: ${detail}. Fix: copy wolfpack-config.example.md to wolfpack-config.md and fill the required keys (Name, Test command, Compliance areas, Risk-surface paths, Model Pool judgment + reviewer-a); check with node scripts/wolfpack-config.mjs --json`)
  }
  if (!Array.isArray(parsed.worktreeLinks)) parsed.worktreeLinks = []
  return parsed
}
projectConfig = await loadProjectConfig(`hunt-pipeline: ${slug}`, 'the pipeline will not guess project values', `project-config:${slug}`, 'Scaffold')
log(`Project config: ${projectConfig.name} — tests: ${projectConfig.testCommand}; deploy: ${projectConfig.devDeployCommand || 'none'}; risk surfaces: ${projectConfig.compliancePaths.length}`)
// exec-layer-into-pack: the pack's execution layer (seat shim) resolves from WOLFPACK_HOME —
// env, else wolfpack-config.md → Project Identity → Wolfpack home, else STOP with the fix.
// Never the consuming repo. TRUST BOUNDARY: the key leg reads ONLY the projectConfig returned
// by the probe above, which runs from the main checkout's root BEFORE the resume probe and the
// scaffold — never the worktree — so a hunt branch cannot redirect its own seat shims. Do NOT
// move this call (or the probe) after the scaffold. Body identical in campaign-runner.js
// (apart from the env accessor).
const resolveWolfpackHome = (who) => {
  const env = _env('WOLFPACK_HOME'); const key = projectConfig && projectConfig.wolfpackHome
  const fix = 'Fix: export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add "- **Wolfpack home:** `<path>`" under ## Project Identity in wolfpack-config.md (check: node <pack>/scripts/wolfpack-config.mjs)'
  const raw = (typeof env === 'string' && env.trim()) ? env.trim() : (typeof key === 'string' && key.trim()) ? key.trim() : ''
  const source = (typeof env === 'string' && env.trim()) ? 'env WOLFPACK_HOME' : 'wolfpack-config.md → Project Identity → Wolfpack home'
  if (!raw) throw new Error(`${who}: WOLFPACK_HOME is not set and wolfpack-config.md has no Wolfpack home — the pack's execution shims are never looked up in the consuming repo. ${fix}`)
  if (!raw.startsWith('/')) throw new Error(`${who}: ${source} is not an absolute path ('${raw}'). ${fix}`)
  return { home: raw.replace(/\/+$/, '') || '/', source }
}
const wolfpackHome = resolveWolfpackHome(`hunt-pipeline: ${slug}`)
const shimPath = `${wolfpackHome.home}/scripts/podman-vibe.sh`
log(`Pack home (WOLFPACK_HOME): ${wolfpackHome.home} — from ${wolfpackHome.source}; seat shim ${shimPath}`)
// pack-install-model: where hunt worktrees live (wolfpack-config.md → Project Identity →
// Worktree root, repo-relative). Required — the pipeline never guesses it. Re-validated here
// with the reader's validWorktreeRoot rule (fail closed on a garbled relay). Body identical in
// hunt-pipeline.js and campaign-runner.js.
const requireWorktreeRoot = (who, value) => {
  const fix = 'Fix: add "- **Worktree root:** `<dir>`" under ## Project Identity, where <dir> is the repo-relative, gitignored directory this project\'s hunt worktrees live in (e.g. `.agents/worktrees` or `.claude/worktrees`); check: node scripts/wolfpack-config.mjs --json'
  if (typeof value !== 'string' || !value) throw new Error(`${who}: wolfpack-config.md has no Worktree root — the pipeline will not guess where hunt worktrees live. ${fix}`)
  const segs = value.split('/')
  const ok = !value.startsWith('/') && !value.startsWith('~') && segs[0] !== '.git' &&
    segs.every(seg => /^\.?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(seg))
  if (!ok) throw new Error(`${who}: wolfpack-config.md → Worktree root '${value}' is not a repo-relative path (no leading / or ~, no . or .. segments, no spaces or shell characters, not under .git). ${fix}`)
  return value
}
const worktreeRoot = requireWorktreeRoot(`hunt-pipeline: ${slug}`, cfg().worktreeRoot)
log(`Worktree root: ${worktreeRoot} (wolfpack-config.md → Project Identity)`)
// pack-install-model (D6): host-side seats read their role skill from the PACK, never a
// consumer path (a consuming project has no .agents/skills of its own).
const PACK_SKILLS = `${wolfpackHome.home}/.agents/skills`
// pack-install-model (AC5): the run-start stamp check. WOLFPACK_STAMP is THIS script's own
// stamp (null in the canonical). A read-only probe runs the pack's checker against the main
// checkout; fail closed on any malformed/absent result. Throws BEFORE any state is mutated.
// Body identical in hunt-pipeline.js and campaign-runner.js (apart from the call's args).
const STAMP_PROBE_SCHEMA = { type: 'object', properties: { exitCode: { type: 'number' }, output: { type: 'string' } }, required: ['exitCode', 'output'] }
const checkWorkflowStamp = async (who, label, phaseName) => {
  const self = `${meta.name}.js`
  const home = wolfpackHome.home
  if (home.includes("'")) throw new Error(`${who}: WOLFPACK_HOME contains a single quote — refusing to build the stamp probe`)
  const p = await agent(`READ-ONLY workflow stamp probe — modify nothing. From the repo root (your starting directory), run exactly:
  node '${home}/scripts/wolfpack-workflows.mjs' check --pack '${home}' --consumer "$(pwd)" --json 2>&1; echo "STAMP_RC=$?"
Return exitCode = the number after STAMP_RC= and output = the command's stdout+stderr VERBATIM, minus the STAMP_RC line.
If the command could not run at all, return exitCode 2 and the error text as output. Never create, fix, regenerate or edit anything.`,
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
await checkWorkflowStamp(`hunt-pipeline: ${slug}`, `workflow-stamp:${slug}`, 'Scaffold')

const resumeProbe = await agent(`
Read-only resume probe. Report the durable state of this hunt so the pipeline
can resume where a prior (crashed or limited-out) run left off. Do NOT modify,
create, or delete anything — read only.

Hunt slug: ${slug}

Steps:
1. Run \`pwd\` to get the repo root (call it REPO). The worktree is
   REPO/${worktreeRoot}/${slug}; its plan dir is
   REPO/${worktreeRoot}/${slug}/.wolfpack/plans/${slug}; the main plan dir is
   REPO/.wolfpack/plans/${slug}.
2. The WORKTREE plan dir is the single source of truth. If the worktree dir EXISTS,
   read metadata.json from the WORKTREE plan dir ONLY. If the worktree dir does NOT
   exist (the --no-worktree path), fall back to the main plan dir. If NEITHER the
   worktree metadata.json nor (when there's no worktree) the main metadata.json
   exists, this is a brand-new hunt: return { fresh: true, latestRevisedPlan: 0 }.
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
   - status "merged_to_campaign" / "merged_to_campaign_pending_compliance" / "certified_held_overlap" → "DONE"
   - certification.md present → "Verify"
   - pointer-review-*.md present → "Test"
   - shepherd-log.md present OR commits on feat/${slug} (git log ${argBase || 'main'}..feat/${slug}) → "Code Review"
     (use metadata.base_branch instead of main when it is set)
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
   - bloodhoundModel: metadata.model_assignments.bloodhound provider family ("glm" or "mistral"), or null if unset
   - trackerModel: metadata.model_assignments.tracker as a raw string if non-empty, else ""
     (the Tracker writes TESTS — code on the branch — so its family is a code-writer family)
   - worktreePath: absolute REPO/${worktreeRoot}/${slug}
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
   - latestRevisedPlan: the highest K among plan-revised-K.md files in the authoritative
     plan dir (ls it; K is an integer), or 0 if there are none.
   - baseBranch: ALWAYS return it — metadata.base_branch if a non-empty string, else ""
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

// Chain mode sticks PER HUNT: a hunt scaffolded on campaign/<slug> keeps diffing against it on
// every resume, even if a later invocation forgets the arg. A conflicting arg fails loud.
const storedBase = (resumeProbe && resumeProbe.baseBranch) || null   // "" → null; stubs without the field read as barrier
if (storedBase && !/^campaign\/[a-z0-9][a-z0-9-]*$/.test(storedBase)) throw new Error(`hunt-pipeline: ${slug} metadata.base_branch ${storedBase} is not a campaign branch`)
if (argBase && storedBase && argBase !== storedBase) throw new Error(`hunt-pipeline: ${slug} base_branch ${storedBase} ≠ args.baseBranch ${argBase} — refusing to rebase a hunt onto a different campaign`)
const baseBranch = argBase || storedBase || null        // chain sticks per hunt
const BASE = baseBranch || 'main'                       // every diff site
if (baseBranch) log(`⛓ ${slug}: chain mode — forks from, rebases onto and diffs against ${baseBranch} (local; never pushed)`)

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
// P9/AC22 channel 1: the Tracker's assignment as the durable metadata records it. The
// Shepherd-seat probe refreshes this within a run; the realized provider on the Tracker's own
// result wins over both. 'claude' stays the conservative default (it can only REMOVE a link).
trackerFamily = familyOf(resumeProbe && resumeProbe.trackerModel) || trackerFamily

// ─── Phase 0: Scaffold (skipped on resume) ─────────────────────
let worktreePath, planDir
let tier, bloodhoundRounds, pointerRounds, trackerRounds
if (at('Scaffold')) {
if (!descriptionPassed) {
  throw new Error(`hunt-pipeline: ${slug} has no scaffolded hunt to resume and no description was passed — scaffold needs one. Pass args { slug, description } (or run /hunt first, then /run-hunt-local ${slug}).`)
}
log(`Scaffolding hunt: ${slug}`)

const scaffold = await agent(`
You are scaffolding a Wolfpack hunt. Do NOT run any planning phases — only create the directory structure and metadata.

Hunt slug: ${slug}
Description: ${description}
Campaign: ${campaign || 'none'}

Steps:
1. Verify you are on the main branch. Existing ${worktreeRoot}/ and .wolfpack/plans/ entries from other or prior hunts are EXPECTED — ignore them. Only stop if there are uncommitted changes to TRACKED source files.
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
   - proposed_version: { bump: null, tag: null }${baseBranch ? `
   - base_branch: "${baseBranch}"   (chain mode: the LOCAL campaign integration branch this hunt forks from, rebases onto and diffs against)` : ''}
4. Create (or ADOPT) the git worktree — idempotent so a resumed/retried hunt never collides:
   - If ${worktreeRoot}/${slug} already EXISTS, do NOT recreate it — adopt it as-is and skip to step 5.
   - Else if branch feat/${slug} exists but the dir does not: git worktree add ${worktreeRoot}/${slug} feat/${slug}
   - Else create fresh: git worktree add ${worktreeRoot}/${slug} -b feat/${slug}${baseBranch ? ` ${baseBranch}` : ''}
5. Copy .wolfpack/plans/${slug}/ into the worktree:
   mkdir -p ${worktreeRoot}/${slug}/.wolfpack/plans/${slug}/
   cp .wolfpack/plans/${slug}/metadata.json ${worktreeRoot}/${slug}/.wolfpack/plans/${slug}/
6. Update metadata.json worktree_path to the absolute path of the worktree ${META_PRESERVE_NOTE}
7. Convenience links (wolfpack-config.md → Worktree links): for each of ${cfg().worktreeLinks.length ? cfg().worktreeLinks.map(l => `\`${l}\``).join(', ') : '(none configured — skip this step)'} that exists in the main repo, symlink it into the worktree at the same relative path (skip any that already exist).

8. SAFETY TAG — Create a rollback point on ${BASE} BEFORE any work begins:
   git tag -f pre-hunt-${slug} ${BASE}   # -f so a resumed hunt re-tags cleanly
   This tag marks the exact state of ${BASE} before the hunt. If anything goes wrong:
   - git worktree remove --force ${worktreeRoot}/${slug}
   - git branch -D feat/${slug}
   - ${BASE} is unchanged (the tag proves it)

Return the worktree absolute path and tier (null at this stage).
Do NOT ask questions. Do NOT run Alpha or any planning.
${heartbeat('Scaffold', 'creating worktree and metadata')}
`, { label: `scaffold:${slug}`, phase: 'Scaffold', schema: {
  type: 'object',
  properties: {
    worktreePath: { type: 'string' },
    planDir: { type: 'string' },
  },
  required: ['worktreePath'],
}})

  worktreePath = scaffold.worktreePath
  planDir = scaffold.planDir || `${worktreePath}/.wolfpack/plans/${slug}`
} else {
  worktreePath = resumeProbe.worktreePath
  planDir = resumeProbe.planDir || `${worktreePath}/.wolfpack/plans/${slug}`
  log(`Adopted existing worktree (resume): ${worktreePath}`)
}
log(`Worktree: ${worktreePath}`)
log(`Examiner chain for this hunt (reviews of Claude-written work): ${chainLabel(examinerChain(PLAN_WRITER_FAMILIES))} — enabled: ${EXAMINER_ORDER.join(', ')} (WOLFPACK_ENABLE_GLM ${GLM_ENABLED ? 'on' : 'off'}, WOLFPACK_ENABLE_MISTRAL_AUTO ${MISTRAL_AUTO ? 'on' : 'off'})`)

// The cross-model seat shims come from the PACK (shimPath = $WOLFPACK_HOME/scripts/
// podman-vibe.sh, resolved above): always the current pack checkout, never a worktree's
// copy (worktrees fork from main and can carry a STALE/drifted shim — v1-push-3: a
// pre-fix comma version made the reviewer run blind) and never the consuming repo. The
// shim takes the worktree path as an ARG. repoRoot is the MAIN checkout of the consuming
// repo (the worktree suffix stripped; the path itself for non-worktree runs) — it still
// serves the repo-local scripts (usage meter, toolcheck, routing, timing…). The suffix is
// /<Worktree root>/ from wolfpack-config.md (pack-install-model), never a hard-coded dir.
const wtMarker = `/${worktreeRoot}/`
const repoRoot = worktreePath.includes(wtMarker)
  ? worktreePath.split(wtMarker)[0]
  : worktreePath
log(`Repo root: ${repoRoot}`)
usageCli = `${repoRoot}/scripts/wolfpack-usage.mjs`

// usage-limit-gate (AC6): the campaign runner's usage gate asked for a usage offload
// (weekly pace too far ahead). Record it ONCE in metadata.usage_offload (first decision
// sticks) — the router and the Shepherd seat probe read it from there.
if (usageOffload && typeof usageOffload === 'object') {
  const rec = await agent(`
You ONLY record a usage offload for Wolfpack hunt ${slug} — modify nothing else. Run exactly:
  node ${shq(`${repoRoot}/scripts/wolfpack-usage.mjs`)} record-offload --plan-dir ${shq(planDir)} --reason ${shq(String(usageOffload.reason || 'weekly pace'))}
Return ok=true and the printed JSON's reason if it exits 0; otherwise ok=false and the first stderr line as error.
`, { label: `usage-offload:${slug}`, phase: 'Scaffold', model: 'sonnet', schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, error: { type: 'string' } },
    required: ['ok'],
  } })
  if (rec && rec.ok) log(`⚖ usage offload: ${rec.reason || usageOffload.reason} — GLM Shepherd on every tier for ${slug}`)
  else log(`⚠ usage offload NOT recorded for ${slug} (${(rec && rec.error) || 'no result'}) — the hunt routes as if no offload was requested`)
}

// seat-profiles-into-pack (AC5) — SEAT TOOLCHECK PREFLIGHT. A seat's real toolset is the
// shim's --enabled-tools list AND its Vibe profile's permissions; when they disagreed
// (profiles denied bash) every review/certification silently became a file-reading audit.
// Before the first shim-backed seat runs, assert profile × shim parity with the canonical
// toolcheck and STOP (park, loud) on any mismatch — never a silent continue. Fail closed: a
// missing or garbled result is a failure. Skipped only when no shim seat lies ahead (no Vibe
// family enabled, or a resume past Certify) — then there is nothing for it to guard.
const TOOLCHECK_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, exitCode: { type: 'number' }, output: { type: 'string' } },
  required: ['exitCode', 'output'],
}
if (at('Certify') && EXAMINER_ORDER.some(f => f !== 'claude')) {
  const tcShim = shimPath
  const tcProfiles = (cfg().exec && typeof cfg().exec.vibeAgentDir === 'string' && cfg().exec.vibeAgentDir)
    ? ` --profiles ${shq(cfg().exec.vibeAgentDir)}` : ''
  const tc = await agent(`You ONLY run the Wolfpack seat toolcheck for hunt ${slug} — modify nothing. Run exactly:
  node ${shq(`${repoRoot}/scripts/wolfpack-toolcheck.mjs`)} --shim ${shq(tcShim)}${tcProfiles} 2>&1; echo "TOOLCHECK_RC=$?"
Return exitCode = the number after TOOLCHECK_RC= (a number), ok = (exitCode == 0), and output = the
command's stdout+stderr VERBATIM (first 60 lines). If the command could not run at all, return
exitCode 2 and the error text as output. Never fix, install or edit anything.`,
    { label: `toolcheck-preflight:${slug}`, phase: 'Scaffold', model: 'sonnet', schema: TOOLCHECK_SCHEMA })
  if (!(tc && tc.exitCode === 0)) {
    const tcOut = (tc && tc.output) || '(no output)'
    const tcResume = PHASE_ORDER[Math.max(PHASE_ORDER.indexOf(resumeFrom), PHASE_ORDER.indexOf('Spec'))]
    // wolfpack-self-hosting (AC10): a MISSING seat shim gets its own loud park naming the
    // path — the pipeline never skips the cross-family seats or substitutes Claude for them.
    const shimMissing = /shim not found: (\S+)/.exec(tcOut)
    if (shimMissing) {
      log(`⛔ ${slug}: cross-family seat shim MISSING at ${shimMissing[1]} — non-Claude seats cannot run, and the pipeline will NOT substitute Claude. Stopping.`)
      await parkHunt({
        reason: 'shim_missing', resumePhase: tcResume, resolutionTypeExpected: 'redirect', phaseLabel: 'Scaffold',
        needFromUser: `The seat shim ${shimMissing[1]} does not exist in the pack at WOLFPACK_HOME=${wolfpackHome.home} (${wolfpackHome.source}). Point WOLFPACK_HOME / Wolfpack home at a wolfpack checkout that has scripts/podman-vibe.sh (the pack's execution layer), or disable the Vibe families (WOLFPACK_ENABLE_GLM=0 WOLFPACK_ENABLE_MISTRAL_AUTO=0 — reviews of Claude-written work then park no_cross_family_reviewer). Then resume.`,
        context: tcOut,
      })
      return { slug, verdict: 'PARKED', status: 'parked:shim_missing', reason: 'shim_missing', tier, worktreePath }
    }
    log(`⛔ ${slug}: seat toolcheck FAILED (exit ${tc && tc.exitCode}) — review/certify seats would run boxed or audit-only. Stopping.\n${tcOut}`)
    await parkHunt({
      reason: 'toolcheck_failed', resumePhase: tcResume, resolutionTypeExpected: 'redirect', phaseLabel: 'Scaffold',
      needFromUser: 'The seat profiles and the shim disagree (or a profile is missing). Fix them — usually `node <wolfpack>/scripts/wolfpack-install-vibe-agents.mjs` — re-run the toolcheck until it exits 0, then resume.',
      context: `toolcheck exit ${tc && tc.exitCode} (shim ${tcShim}):\n${tcOut}`,
    })
    return { slug, verdict: 'PARKED', status: 'parked:toolcheck_failed', reason: 'toolcheck_failed', tier, worktreePath }
  }
  log(`✓ seat toolcheck: profiles match the shim (${tcShim})`)
} else {
  log(`Seat toolcheck preflight skipped — ${EXAMINER_ORDER.some(f => f !== 'claude') ? 'no shim seat lies ahead (resume past Certify)' : 'no Vibe examiner family enabled'}`)
}

// [07 §6] Mistral review turn budget. CORRECTED 2026-06-08: the disconnect was NOT turn
// accumulation against a 25K-TPM cap (that theory is disproven — Medium is 200K context).
// It was a server-side request-SIZE/gateway limit, fixed by the LEAN request config in
// podman-vibe.sh (strips Vibe's ~43K default per-request overhead). With the bloat gone,
// the turn budget no longer needs to be tiny — and 5 demonstrably STARVED a tool-read review
// ("Turn limit reached" → empty output via --output text). Restored to a workable budget so
// the agent can read the diff + skill + analyze + emit a verdict. Env-tunable to re-find the
// sweet spot (too few starves; too many accumulates context toward the --max-tokens guard).
// RAISED 15 → 80 (GLM parity) when Mistral Large 4 became a DEFAULT-ON reviewer: 15 was sized
// for an opt-in afterthought and demonstrably starves a tool-reading review.
const MISTRAL_REVIEW_TURNS = (typeof process !== 'undefined' && process.env && process.env.WOLFPACK_MISTRAL_REVIEW_TURNS) || '80'

// GLM review/cert turn budget. Vibe's --max-turns counts the WHOLE session (incl. resumed
// turns), so a tight cap starves the review into empty output; the shim's wall-clock
// timeout (WOLFPACK_VIBE_REVIEW_TIMEOUT) is the real bound. Keep ≥80.
const GLM_REVIEW_TURNS = _env('WOLFPACK_GLM_REVIEW_TURNS') || '80'
// GLM implement budget (≥150; WOLFPACK_VIBE_IMPLEMENT_TIMEOUT is the real bound).
const GLM_IMPLEMENT_TURNS = _env('WOLFPACK_GLM_IMPLEMENT_TURNS') || '150'

// Read-only review command for a given examiner family. `vibeAgent` is the Vibe agent
// base name used for the Vibe families: Mistral runs it as-is; GLM runs the "-glm"
// variant (wolfpack-<role>-glm: active_model glm-5.3, edit-denied tools), which the shim
// resolves to the glm family (own rate-limit key + semaphore, --auto-approve, strict
// allow-list; write_file only into the seat's own out dir in handoff mode).
//
// The `claude` link is NOT a shim (there is no podman-claude.sh): the agent that walks the
// chain already IS Claude, so the "command" is an instruction to perform the review itself.
// It is the LAST link and is only ever reached when every cross-family link failed.
const CLAUDE_SELF_REVIEW_STEP = (promptFile, role) => `(no shim — YOU are Claude.) Read ${promptFile} and perform the review yourself,
       following the role skill it names. Emit the same <verdict> block the shims must emit, with
       "provider": "claude". Before you do, print
       WOLFPACK_CLAUDE_FALLBACK: ${role} r<round> reason=<why every cross-family link failed>
       and append {role, round, reason, evidence} to ${planDir}/metadata.json's
       "claude_fallback_reviews" array (create it if absent; preserve every other field).
       This link exists ONLY because every cross-family examiner was unavailable; it is never
       your first choice.`
// `handoff` ({dir, expect}, seat-handoff-writes): when set, the Vibe commands run the shim in
// handoff mode (the seat writes its own artifact into <planDir>/.seat-out/<dir>/ and the shim
// delivers it). The claude branch ignores it (its text is unchanged).
const reviewCmd = (who, vibeAgent, promptFile, role = 'reviewer', handoff = null) => {
  const ho = handoff ? ` ${handoffArgs(handoff)}` : ''
  return who === 'mistral'
    ? `${shq(shimPath)}${ho} ${shq(vibeAgent)} ${shq(worktreePath)} ${shq(promptFile)} ${shq(MISTRAL_REVIEW_TURNS)}`
    : who === 'glm'
    ? `${shq(shimPath)}${ho} ${shq(`${vibeAgent}-glm`)} ${shq(worktreePath)} ${shq(promptFile)} ${shq(GLM_REVIEW_TURNS)}`
    : CLAUDE_SELF_REVIEW_STEP(promptFile, role)
}

// ─── seat-handoff-writes: the seat writes its OWN handoff file ───────────────────────────
// Per-seat out dir (one per seat, round and lens — chain links and retries share it; the shim
// guarantees it starts empty and leaves nothing behind), the worktree-relative path the seat
// writes to (valid in both families' containers: Mistral mounts the worktree at /workspace,
// GLM at its host path), and the shim args. planDir must lie inside the worktree — the shim
// pins the out dir there — so a plan dir outside it fails LOUD at the first seat call.
const SEAT_OUT = (name) => `${planDir}/.seat-out/${name}`
const relToWorktree = (p) => (p.startsWith(`${worktreePath}/`) ? p.slice(worktreePath.length + 1) : null)
const seatOutRel = (h) => {
  const rel = relToWorktree(SEAT_OUT(h.dir))
  if (rel == null) {
    throw new Error(`seat-handoff-writes: the plan dir (${planDir}) is not inside the worktree (${worktreePath}) — a review/certify seat cannot run in handoff mode (the shim pins its out dir to <plan dir>/.seat-out/<seat>). Fix the hunt's worktree/plan-dir layout.`)
  }
  return rel
}
const handoffArgs = (h) => {
  seatOutRel(h)
  return `--deliver-to ${shq(planDir)} --out-dir ${shq(SEAT_OUT(h.dir))} ${h.expect.map(e => `--expect ${shq(e)}`).join(' ')}`
}
// Seat-facing paragraph, appended to the SEAT prompt text (after the verdict instruction).
const HANDOFF_NOTE = (h) => {
  const rel = seatOutRel(h)
  const files = h.expect.map(e => `${rel}/${e}`).join(' and ')
  const isCert = h.expect.includes('certification.md')
  return `

SANDBOXED SEAT HANDOFF (mandatory for the Vibe seat): your handoff is a FILE, not your reply. Write ${files} with the write_file tool — ${h.expect.length > 1 ? 'those paths are' : 'that path is'} relative to your working directory (the worktree root). ONE write_file call per file, with the COMPLETE content (write_file cannot overwrite or append). The ${isCert ? 'certification' : 'review'} file must contain your whole ${isCert ? 'certification' : 'review'} AND end with the <verdict> block; still end your final reply with the same <verdict> block. Write NOTHING else anywhere: no other file in ${rel}/, no file outside it, no metadata.json, no commits. Any extra file or any change to the worktree fails this round. This overrides any output file name or location in your system prompt or a role skill.${isCert ? ' Do NOT append to .wolfpack/pedigree/index.md, run scripts, commit or update metadata.json — the pipeline does that after you.' : ''}`
}
// Shim-agent-facing rules, appended to the review/certify shim-agent prompts.
const HANDOFF_SIGNAL_NOTE = `
HANDOFF SIGNAL: a Vibe shim run with --out-dir delivers its artifact ITSELF. Exit 0 plus one
"WOLFPACK_ARTIFACT_DELIVERED: <name> sha256=<hex> bytes=<n>" line per file in <base>.err means
the file is in the plan dir, byte-identical to what the seat wrote — NEVER write, rewrite,
prepend to or re-create it from stdout. Exit 78 or any "WOLFPACK_ARTIFACT_ERROR:" line means the
seat broke its write contract (missing artifact, extra file, source touched): that link FAILED.
A failed link can still have delivered a file (a two-file delivery whose second move fails,
or a "move-failed <name>" whose file landed): move every file named by a DELIVERED or
"move-failed" line of that link aside per the step's REJECTED delivered link rule (above) BEFORE the
next link, so no artifact of a failed link stays in the plan dir.
Print "WOLFPACK_HANDOFF_VIOLATION: <role> r<round> <provider> <the ARTIFACT_ERROR lines>",
append {role, round, provider, link, errors: [<lines>]} to metadata.json's
"handoff_violations" array (create it if absent; preserve every other field), log the
fallback with reason "tool_starved" when the TOOL-DENIAL grep shows write_file denied, else
"capability", and move to the next link. It never counts toward model_quota. If every link
failed and at least one was a handoff violation, return status "handoff_violation".
Exit 2 with "seat out dir is not empty" is plumbing (reason "error").`

// Prompt fragment: how a shim agent runs ONE non-Claude shim command and waits for it.
// A GLM/Mistral review or certification can outlast one shell call (10 min max), and an
// agent that backgrounds it and then ends its turn ("Waiting for the review…") kills the
// shim and returns ERROR — pipeline-automation wave 2 parked two hunts on exactly that
// (review_error at r4/r5 of plans that were converging). Same proven pattern as the
// GLM-Shepherd wrapper: subshell + rc file + bounded foreground polls.
const shimRun = (cmd, base) => `( ${cmd} > ${base}.out 2> ${base}.err; echo $? > ${base}.rc ) </dev/null >/dev/null 2>&1 &
       then, in the FOREGROUND, repeat
         timeout 540 bash -c 'until [ -f "$1" ]; do sleep 20; done' _ ${base}.rc
       until ${base}.rc exists (give up after ~60 minutes → this attempt FAILED, evidence "shim did not finish").
       The exit code is the content of ${base}.rc; the review text is ${base}.out (stderr: ${base}.err).
       Before a retry: rm -f ${base}.out ${base}.err ${base}.rc`
const SHIM_WAIT_RULE = `   WAITING ON A SHIM (hard rule): a shim stays alive only while YOU keep working. Wait ONLY with
   the foreground \`timeout 540 … until [ -f <rc> ]\` poll above, issued again and again until the rc file
   exists. Do NOT use Monitor, ScheduleWakeup, or the Bash tool's run_in_background, do NOT stop the
   shim's task, and NEVER end your turn or reply with a "waiting…" message while a shim runs —
   ending your turn kills the shim and the round is lost as an ERROR.`
const shimBase = (tmpFile, i) => `${tmpFile.replace(/\.txt$/, '')}-l${i + 1}`
const linkCmd = (who, vibeAgent, tmpFile, role, i, handoff = null) => who === 'claude'
  ? reviewCmd(who, vibeAgent, tmpFile, role)
  : shimRun(reviewCmd(who, vibeAgent, tmpFile, role, handoff), shimBase(tmpFile, i))

// Prompt fragment: the ordered examiner-chain steps for a review shim agent. Every Vibe link
// shares the same `handoff` out dir (seat-handoff-writes P3).
const chainSteps = (chain, vibeAgent, tmpFile, role = 'reviewer', handoff = null) => chain.map((who, i) => i === 0
  ? `   [1] PRIMARY ${EXAMINER_LABEL[who]} (provider "${who}") — on a NON-rate-limit failure wait 5s and retry ONCE:\n       ${linkCmd(who, vibeAgent, tmpFile, role, i, handoff)}`
  : `   [${i + 1}] FALLBACK ${EXAMINER_LABEL[who]} (provider "${who}") — one attempt:\n       ${linkCmd(who, vibeAgent, tmpFile, role, i, handoff)}`).join('\n')
  + (chain.some(w => w !== 'claude') ? `\n${SHIM_WAIT_RULE}` : '')

// Prompt fragment: the hard cross-family boundary for a review shim agent.
const chainBoundary = (chain, writers) => `CROSS-FAMILY BOUNDARY (hard rule): use ONLY the chain above, in order — ${chain.map(f => `"${f}"`).join(', ')}.
NEVER review with the family that wrote the artifact (${[...writers].join(', ')}) — not even as a last
resort — and never with a family that is not in the chain above. When every link has failed, return
ERROR as specified below; do not improvise another model.`
// AC17 — DURABLE record of a Claude LAST-RESORT review/certification. The prompt mandate alone
// is not disclosure: CLAUDE.md section "Fail Loud" requires the fact be logged at WARNING+ AND
// visible downstream, so the PIPELINE writes the row itself rather than trusting the examiner
// that just answered. No-op unless the accepted result's family is claude. Never throws — a
// failed record must not discard an accepted review, and the loud log happens either way.
const noteClaudeFallbackReview = async (role, round, result, chain, phaseLabel) => {
  const prov = result && (result.provider || result.status)
  if (familyOf(prov) !== 'claude') return
  const reason = `every cross-family link in [${chain.join(', ')}] was unavailable`
  log(`⚠ ${slug}: ${role}${round ? ` round ${round}` : ''} was answered by the CLAUDE LAST-RESORT examiner (provider "${prov}") — ${reason}. A Claude-reviewed hunt must never look identical to a cross-model one; recording it in metadata.claude_fallback_reviews.`)
  await agent(`
You are a minimal RECORD writer. Do exactly one thing, then return.

Append one row to the "claude_fallback_reviews" array in ${planDir}/metadata.json (create the
array if absent; PRESERVE every other field — read, modify, write back):
  {"role": ${JSON.stringify(role)}, "round": ${round || 0}, "reason": ${JSON.stringify(reason)},
   "evidence": ${JSON.stringify(`provider="${prov}"; chain=[${chain.join(', ')}]; code writers=[${[...codeWriterFamilies].join(', ')}]`)}}
Do NOT alter any other file. Do NOT commit. Return recorded: true when the row is in the file.
`, { label: `claude-fallback-record:${slug}:${role}:r${round || 0}`, phase: phaseLabel,
     schema: { type: 'object', properties: { recorded: { type: 'boolean' } }, required: ['recorded'] },
     model: 'sonnet' })
}

// seat-profiles-into-pack (AC6) — DURABLE record of an AUDIT-ONLY review/certification (a seat
// whose shell or tools were denied). Mirrors noteClaudeFallbackReview: the PIPELINE writes the
// row (metadata.audit_only_seats) and a note in the seat-notes/ sidecar itself (never inside the
// seat's byte-identical artifact — seat-handoff-writes), after a LOUD log, so
// an audit never looks like a review that ran git diff and the tests. Evidence comes from
// auditEvidence (certAuditEvidence for the Watchdog: on Orange/Red/unknown tiers a missing
// tool_access IS audit-only). A Vibe review — or a Green/Blue/Yellow certification — that
// omits tool_access is recorded as tool_access "unreported" (measured, not audit-only).
// Never throws — a failed record must not discard an accepted review; the log happens either way.
const noteAuditOnly = async (role, round, result, artifactPath, phaseLabel) => {
  try {
    const prov = (result && (result.provider || result.status)) || 'unknown'
    const fam = familyOf(prov)
    const ev = role === 'watchdog' ? certAuditEvidence(result, tier) : auditEvidence(result)
    // A tool_access object without a recognised shell state ({} or a garbled value) proves no
    // more than an omitted one, so it is recorded "unreported" too (Pointer r2 F2).
    const ta = result && result.toolAccess
    const hasTA = !!(ta && typeof ta === 'object' && ['ok', 'denied', 'unused'].includes(String(ta.shell || '').toLowerCase()))
    const r = round || 0
    const schema = { type: 'object', properties: { recorded: { type: 'boolean' } }, required: ['recorded'] }
    if (ev.length) {
      const shown = ev.slice(0, 3).join('; ')
      // seat-handoff-writes: the note goes to a pipeline-written SIDECAR, never into the seat's
      // byte-identical handoff artifact.
      const notesPath = `${planDir}/seat-notes/${artifactPath.split('/').pop()}`
      log(`⚠ ${slug}: ${role} r${r} (${prov}) was audit_only — it ran without a working shell (${shown}). Recording metadata.audit_only_seats and noting it in ${notesPath}.`)
      const header = `> audit_only: true — ${role} r${r} (${prov}) ran without a working shell: ${shown}`
      await agent(`
You are a minimal RECORD writer. Do exactly these two things, then return.

1. Append one row to the "audit_only_seats" array in ${planDir}/metadata.json (create the array
   if absent; PRESERVE every other field — read, modify, write back):
     {"role": ${JSON.stringify(role)}, "round": ${r}, "provider": ${JSON.stringify(prov)}, "audit_only": true, "evidence": ${JSON.stringify(ev.slice(0, 10))}}
2. Append this line to ${notesPath} (mkdir -p ${planDir}/seat-notes; create the file if absent)
   unless the file already contains a line beginning "> audit_only: true — ${role} r${r} ".
   Do NOT modify ${artifactPath} — it is the seat's byte-identical handoff:
     ${header}
Do NOT alter any other file. Do NOT commit. Return recorded: true when both are done.
`, { label: `audit-only-record:${slug}:${role}:r${r}`, phase: phaseLabel, schema, model: 'sonnet' })
      return
    }
    if (!hasTA && (role === 'watchdog' || fam === 'glm' || fam === 'mistral')) {
      log(`${slug}: ${role} r${r} (${prov}) did not report a tool_access shell state — recording tool_access "unreported" in metadata.audit_only_seats (not audit-only).`)
      await agent(`
You are a minimal RECORD writer. Do exactly one thing, then return.

Append one row to the "audit_only_seats" array in ${planDir}/metadata.json (create the array if
absent; PRESERVE every other field — read, modify, write back):
  {"role": ${JSON.stringify(role)}, "round": ${r}, "provider": ${JSON.stringify(prov)}, "tool_access": "unreported"}
Do NOT alter any other file. Do NOT commit. Return recorded: true when the row is in the file.
`, { label: `audit-only-record:${slug}:${role}:r${r}`, phase: phaseLabel, schema, model: 'sonnet' })
    }
  } catch (e) {
    log(`⚠ ${slug}: could not record the ${role} r${round || 0} tool-access row (${e && e.message ? e.message : e}) — the review stands; see the log line above.`)
  }
}

// seat-handoff-writes: one log line per accepted review/certification naming the artifacts the
// shim delivered (file + sha256 prefix), so the orchestrator log shows the seat's own bytes landed.
const logSeatArtifacts = (role, n, result) => {
  const arts = (result && Array.isArray(result.artifacts)) ? result.artifacts.filter(a => a && a.file) : []
  log(`✓ ${slug}: ${role} r${n || 0} artifacts delivered by the shim: ${arts.length
    ? arts.map(a => `${a.file} ${String(a.sha256 || '?').slice(0, 12)}`).join(', ')
    : (result && result.provider === 'claude' ? '(claude link wrote them)' : '(artifacts not reported by the shim agent)')}`)
}

// usage-limit-gate (AC6): metadata step for the Claude FINAL review round (usage offload on a
// Red / compliance-critical hunt). It is a mandated pass, NOT a fallback — so it records into
// claude_final_reviews and never into claude_fallback_reviews.
const CLAUDE_FINAL_REVIEW_STEP = (round) => `
   CLAUDE FINAL REVIEW: also append one row to the "claude_final_reviews" array in
   ${planDir}/metadata.json (create it if absent; preserve every other field):
     {"round": ${round}, "verdict": "<APPROVED|ISSUES_FOUND>", "findings": <grounded count>}
   Do NOT write a claude_fallback_reviews row for this round — it is not a fallback.`

// usage-limit-gate (Pointer r1 F1): the REVIEW step for the Claude final round. It must NOT
// reuse CLAUDE_SELF_REVIEW_STEP — that text is fallback-only (prints WOLFPACK_CLAUDE_FALLBACK
// and appends a claude_fallback_reviews row), which would contradict CLAUDE_FINAL_REVIEW_STEP
// in the same prompt and land the durable record in the wrong array.
const CLAUDE_FINAL_SELF_REVIEW_STEP = (promptFile) => `   [1] CLAUDE FINAL REVIEW (provider "claude") — (no shim — YOU are Claude.) Read ${promptFile}
       and perform the review yourself, following the role skill it names. Emit the same
       <verdict> block the shims must emit, with "provider": "claude". This is the MANDATED
       final review (usage offload, Red/compliance), NOT a last-resort fallback: do NOT print
       WOLFPACK_CLAUDE_FALLBACK and do NOT write a claude_fallback_reviews row — record it only
       in claude_final_reviews (step 8).`

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
      "file": "src/app/module.py", "line": 142,
      "claim": "one-sentence defect statement",
      "evidence": "what in the diff or file shows it" }
  ],
  "tool_access": { "shell": "ok" | "denied" | "unused", "denied_tools": [] }
}
</verdict>
Rules:
- verdict APPROVED ⇒ findings MAY be [] (empty). verdict ISSUES_FOUND ⇒ findings MUST be non-empty (an ISSUES_FOUND with no findings is a contradiction and will be discarded).
- Every "file" MUST be repo-root-relative (e.g. src/app/module.py) — never absolute, never a container mount path like /workspace/... — so the pipeline can ground it with test -f against the worktree.
- Put "file" and "line" on every finding that points at code; "claim" and "evidence" are required on each finding.
- Emitting NO <verdict> block, malformed JSON, or paths the grounding check cannot find means your review is DISCARDED (counts as no review at all).
- "tool_access" is MANDATORY: report honestly whether your shell ran (\`git diff\`, the project's test command). "ok" = it ran; "denied" = a shell call was refused/unavailable; "unused" = you never tried. Put every tool call that was denied or reported as an unknown tool in "denied_tools" (e.g. ["bash"]). Never present a file-reading audit as a review that ran the diff.`

// [05] Part B — the rate-limit signal contract between the shims and this orchestrator.
// The shims (podman-vibe.sh) now detect a throttle (HTTP 429 / "Server
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
Do NOT retry that model; go STRAIGHT to the NEXT link of the examiner chain. The shim
already did its own backoff + circuit-breaking internally, so a 75 means "stop asking this
endpoint." If an earlier link is rate-limited but a later link answers, proceed normally
with that link's verdict. If EVERY link in the chain is rate-limited (each exits 75 /
prints WOLFPACK_RATE_LIMITED, or fails with throttle/network/disconnect errors), do NOT
return missing_verdict_block — return verdict "ERROR" with status EXACTLY "model_quota".
That tells the pipeline this is a quota outage to reschedule, not a plumbing failure.
TIMEOUT SIGNAL: a shim that exits with code 76 OR prints a line starting with
"WOLFPACK_TIMEOUT:" hit its wall-clock limit. Treat it like a failed link — move to the
NEXT link (no retry) — but log the fallback reason as "timeout", NOT "rate_limited", and
do NOT count it toward model_quota (model_quota only when EVERY link was rate-limited).
INFRA SIGNAL: exit code 77 OR a line starting with \`WOLFPACK_INFRA_ERROR:\` means the shim's
own sandbox broke (e.g. disk full). This is NOT a rate limit and NOT the model's fault. Move
to the next link, log the fallback reason as \`error\`, and do NOT count it toward
model_quota. If every link failed and any of them was infra, return status \`infra_error\`,
never \`model_quota\`.`

// [06] AC2 — record WHY a primary fell back, and CLASSIFY the reason so a
// tool-box failure is graded differently from a capability failure (the spec's
// "un-confound the metrics": you can't grade a model that was starved of tools).
// A silent fallback nearly hid that Mistral never worked in run #5 — so every
// primary→fallback MUST leave a logged, classified row + a LOUD log line (a buried
// log isn't disclosure, CLAUDE.md). Appended to every review/certify shim prompt.
const FALLBACK_LOG_NOTE = `
FALLBACK LOGGING (mandatory EVERY time you move from one chain link to the next):
When a link fails and you move to the next one, you MUST (a) print a LOUD log line
"WOLFPACK_FALLBACK: <role> r<round> <failed>→<next> reason=<reason>" to stdout, and
(b) append a row to metadata.json's "fallback_log" array (create it if absent):
  { "role": "<bloodhound|pointer|watchdog|shepherd>", "round": <n>, "primary": "<glm|mistral|claude>",
    "fallback": "<glm|mistral|claude>", "reason": "<reason>", "evidence": "<short stderr/exit excerpt>" }
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
  • "error"         — plumbing broke (shim crashed, file-not-found, container error — incl. exit 77 / WOLFPACK_INFRA_ERROR). Neither
        a model nor a quota signal; surface for a human.
  • "timeout"       — primary exited 76 / printed WOLFPACK_TIMEOUT (wall clock ran out).
        Recorded separately: neither a quota outage nor (by itself) a capability grade.
Pick the HIGHEST-priority reason that applies in the order rate_limited → timeout →
tool_starved → error → capability (don't grade a model down for a failure a tool box or
quota caused).`

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
(.wolfpack/plans/<slug>/) — i.e. it touches app source (any source, test, template, script
or config file of the project) — the reviewer VIOLATED its
read-only role: print a LOUD log line "WOLFPACK_REVIEWER_DIFF_VIOLATION: <files>" and append
{ "round": <n>, "role": "<role>", "files": [<paths>] } to metadata.json's
"reviewer_diff_violations" array. Do NOT silently ignore it. (Clean tree = nothing to do.)`

// [05] Part B — classify an ERROR review/certify result: a model_quota outage (both
// cross-models throttled) parks differently from a review_error (plumbing broken). Match
// the agent-set status defensively (exact "model_quota" plus throttle-ish synonyms).
const isQuotaStatus = (s) => /model_quota|quota|rate[_\s-]?limit|both.*(rate|throttl)|throttl/i.test(String(s || ''))

// seat-profiles-into-pack — AUDIT-ONLY detection. A review/certify seat whose shell (or any
// tool) was denied produced a file-reading audit, not a review that ran `git diff` and the
// tests. Two signals, both deterministic here: (1) deniedTools — the fixed grep of
// TOOL_DENIAL_PATTERN over the accepted link's shim .out/.err (the shim agent runs it); (2)
// toolAccess — the seat's own "tool_access" self-report from its <verdict> block.
// TOOL_DENIAL_PATTERN MUST stay byte-equal to scripts/wolfpack-toolcheck.mjs's export (a
// harness test asserts it; this workflow body cannot import).
const TOOL_DENIAL_PATTERN =
  "Tool '[^']+' is permanently disabled|Unknown tool '[^']+'|Tool execution denied by (the )?approval policy|Tool '[^']+' was denied by hook|fatal: not a git repository"
// Tools every review/certify seat profile denies BY ROLE (vibe-agents/*.toml: edit-denied seats,
// no self-orchestration). A seat that self-reports one of these as denied is describing its
// profile, not a missing shell, so it is not audit-only evidence. write_file is NOT here
// (seat-handoff-writes): it is ALLOWED, confined by mount to the seat's own out dir, so a seat
// that self-reports write_file denied IS audit-only evidence (profile drift).
const ROLE_DENIED_TOOLS = ['edit', 'task', 'skill']
const auditEvidence = (r) => {
  const ev = []
  for (const l of (Array.isArray(r && r.deniedTools) ? r.deniedTools : [])) if (String(l).trim()) ev.push(String(l).trim())
  const ta = r && r.toolAccess
  if (ta && typeof ta === 'object') {
    if (String(ta.shell || '').toLowerCase() === 'denied') ev.push('seat reported tool_access.shell = denied')
    for (const t of (Array.isArray(ta.denied_tools) ? ta.denied_tools : [])) {
      if (!ROLE_DENIED_TOOLS.includes(String(t).trim().toLowerCase())) ev.push(`seat reported denied tool: ${t}`)
    }
  }
  if (r && r.auditOnly === true && !ev.length) ev.push('shim agent reported auditOnly')
  return ev
}
const isAuditOnly = (r) => auditEvidence(r).length > 0
// Multi-lens merge of the seats' tool_access self-reports: the WORST shell state wins
// (denied > unused > unrecognised/missing > ok) and denied_tools is the union, so a non-first
// lens's denial survives into auditEvidence(merged) with its real evidence. null when no lens
// reported at all.
const mergeToolAccess = (list) => {
  const tas = list.filter(ta => ta && typeof ta === 'object')
  if (!tas.length) return null
  const rank = (v) => ({ denied: 4, unused: 3, ok: 1 })[v] || 2
  let shell
  for (const ta of tas) {
    const v = String(ta.shell || '').toLowerCase() || null
    if (shell === undefined || rank(v) > rank(shell)) shell = v
  }
  const denied = [...new Set(tas.flatMap(ta => (Array.isArray(ta.denied_tools) ? ta.denied_tools : [])))]
  return { shell, denied_tools: denied }
}
// Orange/Red — or an unknown tier (fail closed: unknown = Red) — cannot certify on audit alone,
// and there a certifier that OMITS the mandatory tool_access field, or reports any shell state
// other than "ok" ("unused" = it never ran git diff or the tests), has not shown its shell ran.
const HEAVY = (t) => t === 'Orange' || t === 'Red' || !TIER_CONFIG[t]
const certAuditEvidence = (r, t) => {
  const ev = auditEvidence(r)
  if (!HEAVY(t)) return ev
  const ta = r && r.toolAccess
  if (!(ta && typeof ta === 'object')) ev.push('certifier omitted the mandatory tool_access field')
  else {
    const shell = String(ta.shell || '').toLowerCase()
    // 'denied' is already evidence via auditEvidence; anything else that is not 'ok' is too.
    if (shell !== 'ok' && shell !== 'denied') ev.push(`certifier reported tool_access.shell = ${JSON.stringify(ta.shell == null ? null : ta.shell)} (not "ok")`)
  }
  return ev
}
// Prompt fragment: the TOOL-DENIAL CHECK a shim agent runs on the link whose output it
// accepted. Pass-through only — it reports, the JS decides.
const toolDenialCheck = (baseHint) => `TOOL-DENIAL CHECK (mandatory, on the link whose output you ACCEPTED):
   - Vibe link (glm / mistral): run EXACTLY
       grep -E -i -h -o ${shq(TOOL_DENIAL_PATTERN)} <base>.out <base>.err 2>/dev/null | sort -u | head -20
     where <base> is that link's shim output base (${baseHint}). Return every output line, verbatim,
     as \`deniedTools\` (an empty output → \`deniedTools: []\`).
   - claude link: \`deniedTools: []\`.
   - Copy the verdict block's "tool_access" object VERBATIM into \`toolAccess\` (omit \`toolAccess\` if
     the block has none — do NOT invent one). Do not set \`auditOnly\`; the pipeline derives it.`

// [handoff-retry] Per-phase output VALIDATOR — the FORMAT-failure class. A reviewer
// that PRODUCED a substantive review but whose machine-readable <verdict> block failed
// validation (emitted XML / prose / malformed JSON, or an ISSUES_FOUND with no findings)
// is in a fundamentally different bucket from a quota outage (model down → can't retry it
// productively) or an ungrounded review (hallucinated files → a quality signal). A format
// failure is RETRYABLE: the same model, told EXACTLY what was wrong, can re-emit a valid
// verdict. So instead of parking review_error on the first format glitch (the observed
// failure: a good cross-model review whose verdict was XML parked a hunt twice), the fan-out
// re-runs with a corrective nudge first. Mirrors isQuotaStatus — match the agent-set
// status strings the review-runner returns in step 6.
const FORMAT_FAILURE_STATUSES = new Set([
  'malformed_verdict', 'missing_verdict_block', 'empty_findings_contradiction',
])
const isFormatFailureStatus = (s) => FORMAT_FAILURE_STATUSES.has(String(s || ''))

// [handoff-retry] The corrective nudge appended to a review re-run after a FORMAT failure.
// The reviewer's analysis was usable; only the verdict ENCODING was wrong. Tell it exactly
// what to fix so it re-emits a valid block rather than the pipeline discarding a real review.
const verdictCorrectiveNudge = (status) => `

CORRECTIVE RE-RUN — your PREVIOUS attempt was rejected for: ${status || 'malformed_verdict'}.
Your review CONTENT was acceptable; the machine-readable verdict FAILED VALIDATION. Re-run the
review, then end with EXACTLY ONE <verdict>...</verdict> block whose body is STRICT JSON —
double-quoted keys/strings, NO XML tags, NO markdown fences, and NOTHING after the closing tag:
<verdict>{"verdict":"APPROVED"|"ISSUES_FOUND","findings":[ ... ]}</verdict>
If your earlier verdict was XML or prose, TRANSLATE it to this JSON shape (REJECT→ISSUES_FOUND,
APPROVE→APPROVED) — do NOT change the substance of your findings, only fix the format. An
ISSUES_FOUND verdict MUST carry a non-empty findings array.`

// [02] Compliance-review risk-surface allowlist. The post-PASS compliance gate
// (AC5) parks any hunt whose diff touches one of these surfaces for human
// sign-off BEFORE the release queue. It is the NARROW risk-surface allowlist from
// wolfpack-config.md → Compliance Requirements → Risk-surface paths (prefix match for
// entries ending in /, exact match otherwise) — genuinely risk-bearing modules, not a
// pervasive top-level directory glob that would park most hunts and turn the
// checkpoint into noise. The project maintains it as a REVIEWED list in its config. A
// project that declares none gets an empty list: the gate then fires only on the Spec
// flag (step 1b).
const compliancePaths = () => cfg().compliancePaths

// Agent-config paths the Claude Code permission classifier refuses to let an agent edit
// ("Self-Modification"): guard hooks and settings. A plan item that changes one of these
// cannot be implemented by any Shepherd, so it would only surface later as a failed test
// (seen 2026-10-17). Instead the Debrief flags such items, the
// Shepherd stages each change as a patch under human-patches/, and the human-patch gate
// below parks the hunt with the commands to apply them.
const PROTECTED_AGENT_PATHS = [
  '.claude/hooks/',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.agents/hooks/',
]
const HUMAN_PATCH_DIR = `${planDir}/human-patches`
const PROTECTED_PATCH_RULE = `
PROTECTED AGENT-CONFIG PATHS (the permission classifier refuses agent edits to these):
${PROTECTED_AGENT_PATHS.map(p => `  - ${p}`).join('\n')}
NEVER edit or commit a file under these paths, and do not retry a refused edit. For each change
the plan needs there, write a unified diff with worktree-relative a/ b/ paths (the format
git diff prints) to ${HUMAN_PATCH_DIR}/<NN>-<short-name>.patch: copy the file to /tmp, edit the
copy, then diff -u it against the original and fix the header paths. Confirm it applies with
git apply --check <patch> from the worktree root. Commit everything else as usual, and list
each patch in shepherd-log.md under "## Human-Applied Patches". The pipeline parks the hunt so
the human applies and commits them.`

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
3. Update ${planDir}/metadata.json ${META_PRESERVE_NOTE}:
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
You ONLY update metadata.json for Wolfpack hunt ${slug} — do NOT plan, review, fix, or commit. ${META_PRESERVE_NOTE}

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

// Stamp the BACKWARD_AUTHORITATIVE "Tracker bounced it back" status so the next pass
// resumes at Implement (STATUS_RESUME.test_rewrite_needed → Implement) instead of letting
// the forward-biased artifact scan carry a failing hunt into Certify. Same tiny write-only
// agent shape as recordFlawedPlan (the workflow JS has no fs). See the call site in the
// Tracker gate for the incident this exists to prevent.
async function recordTestRewriteNeeded({ phaseLabel }) {
  return await agent(`
You ONLY update metadata.json for Wolfpack hunt ${slug} — do NOT plan, review, fix, test, or commit. ${META_PRESERVE_NOTE}

cd to ${worktreePath}. Use absolute paths.

1. Edit ${planDir}/metadata.json: set top-level "status" = "test_rewrite_needed",
   "phase" = "implement". Preserve every other field — in particular do NOT alter
   tracker_round / tracker_rounds / pointer_round, and do NOT touch any park block.
   (The worktree metadata is authoritative — do NOT mirror to any main-repo plan dir.)
   If the status is ALREADY "test_rewrite_needed", leave the file unchanged and return ok.

Do NOT commit. Do NOT push. Do NOT git add.
Return { ok: true }.
${heartbeat(phaseLabel || 'Test', 'recording TEST_REWRITE_NEEDED (tests failed)')}
`, { label: `test-rewrite:${slug}`, phase: phaseLabel || 'Test',
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
  // [handoff-retry] nudge = corrective re-runs this unit has consumed (FORMAT failures
  // only). MAX_NUDGE_RETRIES is the per-unit retry-before-park budget (spec N≈2).
  const MAX_NUDGE_RETRIES = 2
  let pending = lenses.map((l, i) => ({ ...l, idx: i, nudge: 0 }))
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
        agent(buildPrompt(unit, unit.nudge ? verdictCorrectiveNudge(unit.lastStatus) : ''),
              { label: `${label}:${unit.key}${unit.nudge ? `:nudge${unit.nudge}` : ''}`, phase: phaseLabel, schema: REVIEW_SCHEMA })))
      results.push(...res)
    }
    const failed = []
    const failedStatuses = []
    const retryNudge = []   // [handoff-retry] format failures with retry budget remaining
    results.forEach((r, i) => {
      const unit = pending[i]
      if (r && r.verdict && r.verdict !== 'ERROR') {
        done.push({ unit, r })
        return
      }
      const st = (r && r.status) || 'null/error'
      // [handoff-retry] PRE-HANDOFF GATE: a FORMAT failure (valid review, bad verdict
      // encoding) is re-run with a corrective nudge — NOT parked — until its budget is
      // spent. Quota / grounding / empty-findings failures are NOT format-retryable and
      // fall through to the existing cap-degradation + park path unchanged.
      if (isFormatFailureStatus(st) && unit.nudge < MAX_NUDGE_RETRIES) {
        retryNudge.push({ ...unit, nudge: unit.nudge + 1, lastStatus: st })
        degradeLog.push(`lens "${unit.key}" format-fail (${st}) → corrective re-run ${unit.nudge + 1}/${MAX_NUDGE_RETRIES}`)
      } else {
        failed.push(unit)
        failedStatuses.push(st)
        degradeLog.push(`lens "${unit.key}" failed (${st})`)
      }
    })
    // [handoff-retry] Corrective re-runs go back at the SAME concurrency (a verdict-format
    // glitch is not a concurrency problem). Only escalate to cap-degrade/park when a HARD
    // (non-format or budget-exhausted) failure remains.
    if (!failed.length && retryNudge.length) {
      log(`↻ ${retryNudge.length} review lens(es) returned a malformed verdict — corrective re-run before any park.`)
      pending = retryNudge
      continue
    }
    if (!failed.length && !retryNudge.length) break
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
    pending = failed.concat(retryNudge)   // [handoff-retry] carry any nudge-owed units forward too
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
    // Every accepted lens's provider (falling back to its status) — the cross-family
    // runtime invariant checks ALL of them, not just the first.
    providers: done.map(d => d.r.provider || d.r.status || null),
    // seat-handoff-writes: every accepted lens's shim-delivered artifacts.
    artifacts: done.flatMap(d => (Array.isArray(d.r.artifacts) ? d.r.artifacts : [])),
    status: (done.find(d => d.r.provider) || {}).r?.provider || null,
    // seat-profiles-into-pack: tool-access evidence across every accepted lens (audit_only
    // is any lens's evidence; the JS records it via noteAuditOnly).
    deniedTools: [...new Set(done.flatMap(d => (Array.isArray(d.r.deniedTools) ? d.r.deniedTools : [])))],
    auditOnly: done.some(d => isAuditOnly(d.r)),
    toolAccess: mergeToolAccess(done.map(d => d.r.toolAccess)),
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

First, read your full instructions at ${PACK_SKILLS}/spec/SKILL.md — follow them
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
   confidence penalty (a clear, well-specified compliance-area ticket can still be high).
7. Determine compliance_critical = the hunt touches any compliance area this project declares (wolfpack-config.md → Compliance Requirements → Compliance areas: ${cfg().complianceAreas || 'none — this project declares no compliance areas, so compliance_critical is false unless the ticket itself names a regulatory obligation'}).
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
10. Update ${planDir}/metadata.json ${META_PRESERVE_NOTE}: write the spec block
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

First, read your full instructions at ${PACK_SKILLS}/alpha/SKILL.md — follow them exactly.

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
  \`node ${shq(`${repoRoot}/scripts/wolfpack-routing.mjs`)} ${shq(planDir)}\` AFTER you've written
  predicted_dimensions + tier to ${planDir}/metadata.json. It reads those + the per-model meter
  (.wolfpack/pedigree/model-stats.json, [06] AC3) and returns the work-horse/judgment tier
  defaults overridden by capability×economics + domain (frontend→thorough verify;
  backend→thin verify), honoring the HARD constraints (Alpha always Opus; THE GOLDEN RULE —
  a review seat never shares a family with the writer of what it reviews; every reviewer seat
  walks the examiner CHAIN glm → mistral → claude (last resort)
  with the WRITER's family removed — Pointer/Watchdog never share the Shepherd's family;
  a glm:5.3 Shepherd pin is honored only on Green/Blue/Yellow non-compliance hunts and
  carries a Claude fallback; never explore on Red/compliance). Adopt its assignments into
  metadata.json model_assignments
  unless you have a specific documented reason to override (note it in the Debrief). The
  meter is thin until a calibration batch accrues, so today it returns the tier defaults —
  that is correct, not a bug. Follow ${PACK_SKILLS}/alpha/SKILL.md § Model Pool Selection.
- Read .wolfpack/cross-cutting-debt.md for known infra issues
- Explore relevant source files based on the scope
- Write plan.md to ${planDir}/plan.md with the full Alpha plan structure
- Score predicted_dimensions (7 dimensions, 0-4 each)
- Compute tier and mode — IF the campaign specifies a tier, use it. Do NOT downgrade.
- Set bloodhound_rounds, pointer_rounds, tracker_rounds based on tier. These are a FLOOR (minimum rounds), NOT a cap: under the automated pipeline ([03] Part B convergence detection) the review loop continues past the floor while it makes progress and parks when it stalls — round COUNT no longer caps it. The per-tier floors are the single source of truth in TIER_CONFIG (Red bloodhound base=3); you may RAISE a floor for an unusually risky plan, never lower it below the tier base.
- Select the Bloodhound cross-examiner model (cross-family from the Claude planner — one of the ENABLED examiner families for this run, EXCLUDING "claude" which is the last-resort link only and is filtered from every Bloodhound chain anyway: ${EXAMINER_ORDER.filter(f => f !== 'claude').map(f => `"${f}"`).join(', ')}) using the pedigree/lessons performance + quota data; write it to ${planDir}/metadata.json model_assignments.bloodhound. The runtime tries it FIRST, then walks the rest of the chain (${chainLabel(EXAMINER_ORDER)}) on a rate limit. Default to "glm" unless the pedigree data favors another enabled family for this surface. (GLM is on unless WOLFPACK_ENABLE_GLM=0; Mistral Large 4 is on unless WOLFPACK_ENABLE_MISTRAL_AUTO=0.)
- Shepherd seat: if ${planDir}/metadata.json models.architect_recommended (the /hunt --shepherd pin) or the router's model_assignments.shepherd is a glm pin (e.g. "glm:5.3"), keep it as model_assignments.shepherd ONLY on a Green/Blue/Yellow non-compliance hunt — Red/Orange/compliance force Opus. EXCEPTION: if metadata.usage_offload is set, the router assigns glm:5.3 on every tier (usage offload). Adopt it. Never assign a reviewer seat the Shepherd's family.
- Set review_strategy based on tier
- Update ${planDir}/metadata.json with all computed fields ${META_PRESERVE_NOTE}
- If campaign provided ticket refs, include them in the plan's scope section
- If campaign provided TODO items to clear, list them in the plan's changelog section

Pick reasonable defaults for any ambiguity. Document assumptions in plan.md.
Do NOT ask the user any questions — you are running autonomously.
${heartbeat('Plan', 'Alpha writing plan.md')}${HUMAN_NOTES_DIRECTIVE}

Return the tier, bloodhound_rounds, pointer_rounds, tracker_rounds, the chosen
Bloodhound reviewer model family as bloodhoundModel (${EXAMINER_ORDER.map(f => `"${f}"`).join(' or ')} — never Claude),
and worktree path.
`, { label: `alpha:${slug}`, phase: 'Plan', schema: VERDICT_SCHEMA })

  tier = alphaPlan.tier || 'Yellow'

  // Honor Alpha's pedigree-driven reviewer pick over the campaign round-robin.
  // (unfinalize-inventory-restore stalled because the runtime ignored Alpha's
  // reviewer assignment and forced a blind fallback family; this is the fix.)
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
// the pre-merge compliance checkpoint + cross-model Pointer/Watchdog (the golden rule binds).
const HEAVY_TIER = tier === 'Red' || tier === 'Orange'
// The CLAUDE Shepherd model: the implementer on every hunt without a glm pin, and the
// fallback implementer when the GLM Shepherd is rate-limited / fails.
const shepherdModel = HEAVY_TIER ? 'opus' : 'sonnet'
log(`Shepherd model: ${shepherdModel} (tier ${tier}) — work-horse Sonnet on non-heavy, Opus on Red/Orange`)

// ─── Shepherd SEAT (coder-alt): Claude by default, GLM when pinned ─────────────
// A hunt whose BINDING Shepherd assignment is glm (metadata.model_assignments.shepherd —
// Alpha/Debrief adopt /hunt --shepherd=glm:5.3, which only lands in the ADVISORY
// models.architect_recommended) implements through Vibe/GLM
// (podman-vibe.sh --implement wolfpack-shepherd-glm) — but ONLY on a non-heavy,
// non-compliance hunt with GLM enabled: Red/Orange/compliance ALWAYS force the Claude
// judgment Shepherd (Opus). A GLM rate limit / failure falls back to the Claude Shepherd
// for that step (logged in metadata.fallback_log). Whoever writes code joins
// codeWriterFamilies, which the Pointer/Watchdog chains exclude (cross-family rule) —
// tracked by who ACTUALLY wrote (a GLM step that was rate-limited before changing any
// file did not write). lastWriterFamily is the family of the LAST successful writer;
// rework (Pointer rounds, Tracker/Pointer bounce re-entry) goes back to it. The probe
// restores both from metadata (shepherd_families / last_shepherd_family) on resume, so
// a resumed Code Review / Certify never lets GLM review code GLM wrote earlier.
const SHEPHERD_SEAT_SCHEMA = {
  type: 'object',
  properties: {
    shepherdPin: { type: 'string' },
    trackerAssignment: { type: 'string' },          // raw pin string, or "" when none
    complianceCritical: { type: 'boolean' },  // spec.compliance_critical / review_required / domain_sensitivity ≥3
    shepherdFamilies: { type: 'array', items: { type: 'string' } },  // metadata.shepherd_families
    testWriterFamilies: { type: 'array', items: { type: 'string' } },  // metadata.test_writer_families
    lastShepherdFamily: { type: 'string' },   // metadata.last_shepherd_family, or ""
    glmWritePending: { type: 'boolean' },     // metadata.glm_write_pending === true
    gitWriterFamilies: { type: 'array', items: { type: 'string' } },  // Wolfpack-Writer trailers on BASE..HEAD
    gitHeadWriter: { type: 'string' },        // the trailer on the newest trailer-bearing commit, or ""
    uncommittedChanges: { type: 'boolean' },  // app files dirty outside .wolfpack/
    usageOffload: { type: 'boolean' },        // metadata.usage_offload is set (an object) — usage-limit-gate
  },
  // usageOffload is REQUIRED: an omitted field would silently read as false and skip the
  // offload + the mandated Claude final review with no warning (Pointer r2 F2).
  required: ['shepherdPin', 'complianceCritical', 'shepherdFamilies', 'usageOffload'],
}
let shepherdFamily = 'claude'
// usage-limit-gate (AC6/A-5): set from the seat probe. Offload moves the Shepherd to GLM on
// EVERY tier; on Red or compliance-critical hunts a Claude final review follows Pointer.
let usageOffloadActive = false
let seatComplianceCritical = false
let lastWriterFamily = ''   // '' = nobody has written yet (fresh Implement)
if (GLM_ENABLED && (at('Implement') || at('Code Review') || at('Certify'))) {
  const seat = await agent(`
You are a READ-ONLY probe. Do NOT modify anything. Read ${planDir}/metadata.json and return:
- shepherdPin: metadata.model_assignments.shepherd if it is a non-empty string, else ""
  (empty string). IGNORE metadata.models.architect_recommended — it is advisory only.
- complianceCritical: true if ANY of metadata.spec.compliance_critical === true,
  metadata.spec.compliance_review_required === true, or
  metadata.predicted_dimensions.domain_sensitivity >= 3; else false.
- shepherdFamilies: metadata.shepherd_families if it is an array of strings, else [].
- testWriterFamilies: metadata.test_writer_families if it is an array of strings, else []
  (the Tracker's tests are code on this branch — its family is a code-writer family).
- trackerAssignment: metadata.model_assignments.tracker if it is a non-empty string, else "".
- lastShepherdFamily: metadata.last_shepherd_family if a non-empty string, else "".
- glmWritePending: metadata.glm_write_pending === true (else false).
- gitWriterFamilies: the DISTINCT lowercase values of every "${WRITER_TRAILER}:" trailer on the
  branch's commits. Run (if the worktree exists; else []):
    git -C ${shq(worktreePath)} log --format='%(trailers:key=${WRITER_TRAILER},valueonly)' ${BASE}..HEAD
  Also count a commit whose subject ends in "[glm-shepherd]" as "glm" (legacy/untrailered).
- gitHeadWriter: the trailer value of the NEWEST commit in ${BASE}..HEAD that has one, else "".
- uncommittedChanges: true if \`git -C ${shq(worktreePath)} status --porcelain\` lists any path
  outside .wolfpack/, else false.
- usageOffload: true if metadata.usage_offload is set (a non-null object), else false.
Return ONLY these fields.
`, { label: `shepherd-seat:${slug}`, phase: 'Implement', schema: SHEPHERD_SEAT_SCHEMA, model: 'sonnet' })
  const pinFam = familyOf(seat && seat.shepherdPin)
  // Writer record = UNION of metadata and git (the more restrictive set): a crash between
  // a GLM commit and its metadata write can't downgrade the record, and neither can a lost
  // metadata.json. A pending GLM step with uncommitted edits counts as a GLM write.
  const metaFams = ((seat && seat.shepherdFamilies) || []).map(familyOf).filter(Boolean)
  const gitFams = ((seat && seat.gitWriterFamilies) || []).map(familyOf).filter(Boolean)
  // P9/AC22 edit 3 — the TEST-writer channel, mirroring shepherdFamilies exactly: two
  // independent channels (metadata + git trailer), same union rule, same "more restrictive
  // wins" semantics, so neither a lost metadata.json nor a missing trailer alone can silently
  // re-open the claude link over Claude-written tests.
  const testFams = ((seat && seat.testWriterFamilies) || []).map(familyOf).filter(Boolean)
  if (testFams.length) testWriterRecorded = true
  for (const ff of [...metaFams, ...gitFams, ...testFams]) codeWriterFamilies.add(ff)
  if (seat && seat.glmWritePending) codeWriterFamilies.add('glm')
  // Refresh the Tracker seat family from metadata (never a literal — a reviewer-b Tracker on
  // Green/Blue must record 'mistral', not 'claude'); 'claude' stays the conservative default.
  trackerFamily = familyOf(seat && seat.trackerAssignment) || trackerFamily
  const disagree = gitFams.filter(f => !metaFams.includes(f))
  if (disagree.length) {
    log(`⚠ WRITER RECORD MISMATCH: git trailers show ${disagree.join(', ')} wrote on feat/${slug} but metadata.shepherd_families (${metaFams.join(', ') || 'empty'}) does not — using the UNION (more restrictive): ${[...codeWriterFamilies].join(', ')}.`)
  }
  if (seat && seat.glmWritePending) {
    log(`⚠ ${slug}: metadata.glm_write_pending=true — a GLM step was interrupted${seat.uncommittedChanges ? ' with uncommitted edits in the worktree' : ''}; treating glm as a code writer.`)
  }
  // Last writer: git's newest trailer wins over metadata (it is written atomically with the commit).
  lastWriterFamily = familyOf(seat && seat.gitHeadWriter) || familyOf(seat && seat.lastShepherdFamily) || ''
  // usage-limit-gate: usage offload suspends the judgment override (and ONLY it) — the
  // GLM Shepherd applies on every tier. Without offload this branch is unchanged.
  const offload = !!(seat && seat.usageOffload)
  usageOffloadActive = offload
  seatComplianceCritical = !!(seat && seat.complianceCritical)
  if (pinFam === 'glm' || offload) {
    if (!offload && (HEAVY_TIER || (seat && seat.complianceCritical))) {
      log(`⚠ Shepherd pin "${seat.shepherdPin}" IGNORED — ${HEAVY_TIER ? `tier ${tier}` : 'compliance-critical hunt'} forces the Claude ${shepherdModel} Shepherd (judgment override never relaxes).`)
    } else {
      shepherdFamily = 'glm'
      // Resumed PAST Implement with no writer record (e.g. a crash before metadata was
      // written): we cannot prove GLM didn't write, so exclude it conservatively.
      if (!at('Implement') && !seat.shepherdFamilies?.length) codeWriterFamilies.add('glm')
      log(offload
        ? `⚖ Shepherd seat: Vibe/GLM — USAGE OFFLOAD (weekly pace) on tier ${tier}; Claude ${shepherdModel} is the fallback.${(tier === 'Red' || seatComplianceCritical) ? ' A Claude final review follows the cross-family Pointer review.' : ''}`
        : `Shepherd seat: Vibe/GLM (pin "${seat.shepherdPin}") — Claude ${shepherdModel} is the rate-limit fallback.`)
    }
  } else if (pinFam && pinFam !== 'claude') {
    log(`⚠ Shepherd pin "${seat.shepherdPin}" (${pinFam}) has no implementer path in this pipeline — using the Claude ${shepherdModel} Shepherd.`)
  }
} else if (!GLM_ENABLED) {
  log(`Shepherd seat: Claude ${shepherdModel} (GLM disabled via WOLFPACK_ENABLE_GLM — any glm Shepherd pin is ignored).`)
}
log(`Code-writer families: ${[...codeWriterFamilies].join(', ') || '(none yet)'} → code-review chain: ${chainLabel(examinerChain(codeWriterFamilies))}`)

const GLM_SHEPHERD_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string' },      // done | rate_limited | timeout | failed | no_changes | rebase_conflict
    exitCode: { type: 'number' },
    evidence: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    committed: { type: 'boolean' },
    findingsAddressed: REVISION_SCHEMA.properties.findingsAddressed,
    allAddressed: { type: 'boolean' },
  },
  required: ['outcome'],
}

// Run one GLM Shepherd step through a thin Claude WRAPPER agent that only does plumbing
// (rebase, write the task file, run the shim, commit GLM's files by name). mode is
// 'implement' (fresh build / reviewer-bounce entry) or 'rewrite' (a Pointer round).
// Returns the wrapper's result, or a synthetic { outcome: 'failed' } if it dropped.
// Chain mode: both Shepherd paths rebase onto the LOCAL campaign branch (no fetch, no origin/ —
// it is never pushed) and make sure metadata records base_branch (heals a hunt scaffolded
// before the campaign switched to chain mode). Barrier text is unchanged.
const REBASE_CMD = baseBranch ? `git rebase ${baseBranch}` : 'git fetch origin && git rebase origin/main'
const REBASE_LABEL = baseBranch || 'main'
const BASE_META_LINE = baseBranch
  ? `Ensure ${planDir}/metadata.json has "base_branch": "${baseBranch}" (set it if absent; preserve all other fields).`
  : ''
async function runGlmShepherd({ mode, round, task, phaseLabel }) {
  const tag = mode === 'implement' ? 'impl' : `r${round}`
  const base = `/tmp/shepherd-glm-${slug}-${tag}`
  const q = (sfx) => shq(`${base}${sfx}`)
  const cmd = `${shq(shimPath)} --implement wolfpack-shepherd-glm ${shq(worktreePath)} ${q('.txt')} ${shq(GLM_IMPLEMENT_TURNS)}`
  let r = null
  for (let attempt = 1; attempt <= 2 && !r; attempt++) {
    if (attempt > 1) log(`↻ shepherd-glm:${slug}:${tag} wrapper dropped mid-response — retry ${attempt}/2`)
    r = await agent(`
You are the GLM-Shepherd WRAPPER for Wolfpack hunt '${slug}', running headlessly. GLM 5.3
(via the Vibe CLI) is the IMPLEMENTER for this ${mode === 'implement' ? 'implementation' : `Pointer round ${round} rework`}.
YOU DO NOT WRITE, EDIT, FORMAT OR REVERT ANY SOURCE FILE YOURSELF — not even a one-line fix.
Your job is plumbing only. (If you wrote code, Claude-written code would be reviewed as
GLM's and the cross-family review invariant would silently break.)

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

Steps:
1. cd ${worktreePath}
${mode === 'implement'
  ? `2. REBASE FIRST (worktree drift): ${REBASE_CMD}
   If it fails: git rebase --abort and return outcome "rebase_conflict" immediately.${BASE_META_LINE ? `
   ${BASE_META_LINE}` : ''}`
  : `2. No rebase for a rework round. Check the tree: git status --porcelain (ignore .wolfpack/).
   If app files are already modified/uncommitted, return outcome "failed", evidence "dirty tree before GLM rework".`}
3. Write the GLM task to ${base}.txt with EXACTLY the text between the markers (use your
   file-write tool, verbatim, no paraphrase, markers excluded):
=====GLM TASK START=====
${task}
=====GLM TASK END=====
3b. DURABLE WRITER RECORD FIRST (crash safety — do this BEFORE step 4): update
   ${planDir}/metadata.json: remember whether "shepherd_families" ALREADY contained "glm"
   (call it HAD_GLM), then ensure "shepherd_families" contains "glm" and set
   "glm_write_pending" = true. Preserve every other field. (If the run dies anywhere after
   this, the resume probe still sees GLM as a possible writer — the safe direction.)
4. Run the shim. It can run for up to an hour — longer than one shell call may block — so
   start it in the BACKGROUND and poll:
     ( ${cmd} > ${q('.out')} 2> ${q('.err')}; echo $? > ${q('.rc')} ) </dev/null >/dev/null 2>&1 &
   then repeat \`timeout 540 bash -c 'until [ -f "$1" ]; do sleep 20; done' _ ${q('.rc')}\` until
   ${base}.rc exists (give up after ~80 minutes total → outcome "failed", evidence "shim did not finish").
   Run the shim EXACTLY as given — no extra flags, never a second copy in parallel.
5. Classify: rc 75, OR ${base}.err has a line starting "WOLFPACK_RATE_LIMITED:" → outcome
   "rate_limited". rc 76, OR a line starting "WOLFPACK_TIMEOUT:" → outcome "timeout" (the
   shim's wall clock ran out — NOT a quota signal). Any other non-zero rc → outcome
   "failed". rc 0 → continue.
6. List what GLM changed: git status --porcelain (+ git diff --stat). Put every changed/new
   path in changedFiles.${mode === 'implement' ? `
   rc 0 but NOTHING changed outside .wolfpack/ → outcome "no_changes".` : ''}
7. rc 0 with changes: stage EACH changed/new file BY NAME (git add -- <path> …) — NEVER
   git add . / -A / -f; skip anything under .wolfpack/plans/ (gitignored plan artifacts).
   Commit with a conventional message ending in "[glm-shepherd]" (e.g. "${mode === 'implement' ? `feat(<scope>): <summary> [glm-shepherd]` : `fix(<scope>): address Pointer round ${round} findings [glm-shepherd]`}")
   AND the git trailer "${WRITER_TRAILER}: glm" as the LAST line of the message (e.g.
   git commit -m "<subject>" --trailer "${WRITER_TRAILER}: glm"). The trailer is the
   durable, git-side writer record the resume probe cross-checks — never omit it.
   The commit must contain ONLY GLM's changes. Set committed=true.
   On rate_limited / failed: do NOT commit, revert, stash or clean — leave any partial GLM
   edits in the working tree for the fallback implementer (committed=false).${mode === 'rewrite' ? `
8. From ${base}.out take the LAST <dispositions>{...}</dispositions> block: strict JSON
   {"findingsAddressed":[{"id","severity","title","disposition","justification"}],"allAddressed":bool}.
   Pass it through as findingsAddressed / allAddressed. rc 0 but no parseable block →
   outcome "failed", evidence "no dispositions block" (keep the commit).` : ''}
9. Finalize ${planDir}/metadata.json (the code-writer record the cross-family review rule
   reads on resume; preserve every other field):
   - if changedFiles is EMPTY and nothing was committed AND HAD_GLM was false (GLM wrote
     nothing this step and never before): remove "glm" from "shepherd_families" again;
     otherwise KEEP "glm" there;
   - if outcome is "done": set "last_shepherd_family" = "glm";
   - set "glm_write_pending" = false (only AFTER the lines above).
10. rm -f ${q('.txt')} ${q('.out')} ${q('.err')} ${q('.rc')}
Return outcome ("done" when rc 0 and the step completed), exitCode, evidence (≤300 chars of
the .err/.out tail), changedFiles, committed${mode === 'rewrite' ? ', findingsAddressed, allAddressed' : ''}.
SAFETY: No git push, no deploy, no git add . / -A / -f, never run the test suite.
${heartbeat(phaseLabel, `GLM Shepherd ${mode === 'implement' ? 'coding' : `rework r${round}`}`)}
`, { label: `shepherd-glm:${slug}:${tag}`, phase: phaseLabel, schema: GLM_SHEPHERD_SCHEMA, model: 'sonnet' })
  }
  return r || { outcome: 'failed', evidence: 'GLM wrapper agent dropped twice (no result)', changedFiles: [] }
}

// Classify a GLM Shepherd miss for fallback_log (same buckets as FALLBACK_LOG_NOTE).
const glmFallbackReason = (r) => (r.outcome === 'rate_limited' ? 'rate_limited'
  : r.outcome === 'timeout' ? 'timeout' : r.outcome === 'no_changes' ? 'capability' : 'error')

// The instruction block handed to the CLAUDE Shepherd when it takes over from GLM.
const glmFallbackNote = (r, round) => `
FALLBACK ENTRY — the GLM Shepherd (this hunt's pinned implementer) did not complete:
outcome=${r.outcome}${r.exitCode != null ? ` (rc ${r.exitCode})` : ''}; evidence: ${String(r.evidence || '').slice(0, 300)}.
You are the Claude fallback implementer (${shepherdModel}).
- The worktree was already rebased by the GLM wrapper — do NOT rebase again.
- The working tree may hold UNCOMMITTED partial GLM edits (${(r.changedFiles || []).join(', ') || 'none reported'}).
  Inspect them (git status / git diff), keep what is correct, fix or finish the rest, commit.
- Record the fallback: print "WOLFPACK_FALLBACK: shepherd r${round} glm→claude reason=${glmFallbackReason(r)}" and
  append to ${planDir}/metadata.json "fallback_log" (create if absent):
  {"role":"shepherd","round":${round},"primary":"glm","fallback":"claude:${shepherdModel}","reason":"${glmFallbackReason(r)}","evidence":"<≤200 chars>"}
  and ensure "shepherd_families" contains "claude"${(r.changedFiles || []).length ? ' and "glm" (GLM left edits)' : ''}; set
  "last_shepherd_family" = "claude" and "glm_write_pending" = false. Preserve every other field.
- End every commit message with the git trailer "${WRITER_TRAILER}: claude"${(r.changedFiles || []).length ? `
  PLUS a second trailer "${WRITER_TRAILER}: glm" on the commit that includes GLM's partial edits` : ''}.
`

// Writer record appended to a plain (non-fallback) Claude Shepherd prompt.
const CLAUDE_WRITER_RECORD = `
WRITER RECORD: end every commit message with the git trailer "${WRITER_TRAILER}: claude"
(git commit --trailer "${WRITER_TRAILER}: claude"). After committing, update ${planDir}/metadata.json ${META_PRESERVE_NOTE} —
ensure the "shepherd_families" array exists and contains "claude", and set "last_shepherd_family" = "claude".
Preserve every other field.`

// Which family gets the NEXT rework (Pointer round / Tracker or Pointer bounce re-entry):
// the family that LAST actually wrote, and GLM only while the GLM seat is still eligible.
const reworkFamily = () => (shepherdFamily === 'glm' && (lastWriterFamily || 'glm') === 'glm') ? 'glm' : 'claude'
// Record a completed GLM step's effect on the writer sets.
const noteGlmStep = (g) => {
  if ((g.changedFiles || []).length || g.committed) codeWriterFamilies.add('glm')
  if (g.outcome === 'done') lastWriterFamily = 'glm'
}
const noteClaudeWrote = () => { codeWriterFamilies.add('claude'); lastWriterFamily = 'claude' }
// P9/AC22: tests are code on the branch and Watchdog verifies code AND tests, so the test
// writer IS a writer. Record the REALIZED family — today the in-process Claude agent() path
// means `trackerResult.provider` is absent or claude-labelled and this resolves to 'claude',
// but a reviewer-b Tracker (wolfpack-config.md section Overrides) records 'mistral' instead of
// lying. Conservative by design: a Tracker round that wrote nothing still records, because we
// cannot prove it didn't.
const noteTrackerWrote = (res) => {
  codeWriterFamilies.add(familyOf(res && (res.provider || res.model)) || trackerFamily)
  testWriterRecorded = true
}

// ─── Phase 2: Bloodhound Review Loop (skipped on resume) ───────
if (at('Review')) {
  phase('Review')

  let approved = false
  // A resume INTO Review continues the round numbering: with plan-revised-K.md on disk the
  // next review is round K+1 of plan-revised-K.md. Restarting at round 1 re-reviews plan.md
  // under a stale round number and the reviewer refuses it (pipeline-automation wave 2:
  // both resolved review_error parks re-parked as round_mismatch_not_run).
  let round = (!fresh && resumeFrom === 'Review') ? Math.max(0, Math.floor(Number(resumeProbe.latestRevisedPlan) || 0)) : 0
  if (round > 0) log(`▶ ${slug}: resuming the plan review at round ${round + 1} (plan-revised-${round}.md)`)
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

    // The examiner chain for THIS round (the preferred examiner may have moved on a
    // sticky answer). The plan's writer is Alpha (Claude), so Claude is the excluded
    // family — which also always removes the `claude` last-resort link from a Bloodhound
    // chain. An empty chain means both kill switches are off; fail loud rather than review
    // same-family.
    const bhChain = examinerChain(PLAN_WRITER_FAMILIES)
    if (!bhChain.length) {
      log(`⛔ ${slug}: no cross-family examiner is enabled for the plan review (writers: ${[...PLAN_WRITER_FAMILIES].join(', ')}). Parking.`)
      await parkHunt({
        reason: 'no_cross_family_reviewer', resumePhase: 'Review', resolutionTypeExpected: 'redirect', phaseLabel: 'Review',
        needFromUser: `No enabled non-Claude examiner family is left for the plan review after removing the writer's family. Enable one (WOLFPACK_ENABLE_GLM / WOLFPACK_ENABLE_MISTRAL_AUTO) or fix the examiner gates, then resume.`,
        context: `Enabled examiners: ${EXAMINER_ORDER.join(', ') || '(none)'}; plan writer families: ${[...PLAN_WRITER_FAMILIES].join(', ')}`,
      })
      return { slug, verdict: 'PARKED', status: 'parked:no_cross_family_reviewer', reason: 'no_cross_family_reviewer', tier, worktreePath }
    }

    // One shim per review lens. The DEFAULT is a single comprehensive lens (current,
    // validated behavior). buildPrompt(unit) closes over the round; runReviewFanout owns
    // the fan-out + n-1 concurrency degradation (workflow-orchestrated, never CLI self-
    // orchestration). For the 'full' lens the raw file is review-${round}.md (Alpha-revise
    // + the resume probe read it); extra lenses get review-${round}-<lens>.md.
    const buildBloodhoundPrompt = (unit, nudge) => {
      const rawFile = unit.key === 'full' ? `review-${round}.md` : `review-${round}-${unit.key}.md`
      const tmpFile = unit.key === 'full' ? `/tmp/bloodhound-${slug}-r${round}.txt` : `/tmp/bloodhound-${slug}-r${round}-${unit.key}.txt`
      // seat-handoff-writes: ONE out dir per seat, round and lens (every Vibe link shares it).
      const handoff = { dir: unit.key === 'full' ? `bloodhound-r${round}` : `bloodhound-r${round}-${unit.key}`, expect: [rawFile] }
      return `
You are a shim agent orchestrating a Bloodhound review${unit.focus ? ` (FOCUS LENS: ${unit.key})` : ''}. This hunt's examiner
chain for the plan review is ${chainLabel(bhChain)} — try each link in order, moving to the
next only when the current one fails. (All links are non-Claude — never review with Claude.)

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
   "You are reviewing Wolfpack hunt '${slug}', round ${round}, tier ${tier}. Read the plan at ${planDir}/${planFile}. Also read TODO.md, CLAUDE.md, and .wolfpack/pedigree/index.md for context. Read metadata.json at ${planDir}/metadata.json for tier and scope. Read .agents/skills/bloodhound/SKILL.md (if present in this checkout; otherwise your seat profile carries the role) and follow it. Produce your adversarial review following your system prompt instructions. PLAN-REVIEW SCOPE (mandatory): you are reviewing the PLAN DOCUMENT's design — NOT whether it has been implemented. The code is NOT written yet (Shepherd implements in a LATER phase). Findings of the form 'not implemented / missing from the codebase / absent from the file / helper missing / code remains unchanged / pre-implementation state' are INVALID and MUST NOT be reported — that state is EXPECTED at plan-review time and reporting it is a misfire that falsely trips non-convergence. Use the code ONLY to verify the plan's factual claims about the CURRENT codebase are accurate; judge the plan's correctness, completeness, and compliance, never its implementation status.${unit.focus ? ` ${unit.focus}` : ''} EFFICIENCY (mandatory): do NOT read whole large files — grep for the relevant symbols/lines first, then read only those ranges with a line offset/limit. Scope every grep to the relevant app directory (e.g. src/app/, lib/module/), never the repo root, or it times out. Reading entire 1000+ line files (models.py, views.py) bloats context and can crash the request mid-review.${tier === 'Red' ? ' SINGLE-PASS REVIEW (mandatory, all models): do NOT spawn sub-agents or use the task tool. Produce ONE comprehensive adversarial review covering every lens (correctness, compliance, multi-tenancy, security, edge-case/repro) in a single response, then emit the verdict block. The headless cross-model roster fan-out is disabled — the pipeline handles orchestration, not you.' : ''}${VERDICT_CONTRACT}${HANDOFF_NOTE(handoff)}${nudge || ''}"

3. Walk the EXAMINER CHAIN in order until one link yields an acceptable review:
${chainSteps(bhChain, 'wolfpack-bloodhound', tmpFile, 'bloodhound', handoff)}
   Each wrapper enforces a read-only adversarial review and caps concurrent
   calls on its model (flock) to avoid rate limits. Run each EXACTLY as
   given — do not add flags or spawn it multiple times in parallel.
   An attempt FAILS if ANY of: non-zero exit, empty output, no parseable
   <verdict> block (step 6), or — for an ISSUES_FOUND verdict — every
   file-bearing finding fails the grounding check (step 7, the blind/hallucinating
   reviewer signal). A rate-limit signal (exit 75 / WOLFPACK_RATE_LIMITED) skips
   straight to the next link — no retry. A Vibe link's exit 0 is checked by the HANDOFF
   SIGNAL rules below (exit 78 / any WOLFPACK_ARTIFACT_ERROR line = that link FAILED).
   ${chainBoundary(bhChain, PLAN_WRITER_FAMILIES)}

4. When a link FAILS, move to the NEXT link of the chain (log the fallback — see below).
   Strip ANSI escape codes from the output.

5. THE ARTIFACT. Vibe link: the shim delivered ${planDir}/${rawFile} itself (HANDOFF SIGNAL) —
   do not write or modify it. claude link: save your review to ${planDir}/${rawFile}. (The
   SANDBOXED SEAT HANDOFF note in the review prompt applies only to Vibe links.)
   REJECTED delivered link (exit 0 but step 6/7 fails it, OR a FAILED handoff — exit 78 / any
   WOLFPACK_ARTIFACT_ERROR line — whose .err names ${rawFile} in a WOLFPACK_ARTIFACT_DELIVERED or
   "move-failed" line and the file exists): before the next link run exactly
     mkdir -p ${planDir}/seat-notes && mv -f ${planDir}/${rawFile} ${planDir}/seat-notes/${rawFile}.rejected-l<N>
6. EXTRACT THE VERDICT from ${planDir}/${rawFile} (the delivered artifact) for a Vibe link, or
   from your own review for the claude link — strict extract-and-validate, NO prose-rescue. The
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
   a. Normalize the path: strip a leading "${worktreePath}/" or "/workspace/" if
      present, then strip any remaining leading "/", yielding a repo-root-relative
      path. (A containerized reviewer emits /workspace/... under its mount — or, for a
      GLM seat, the worktree's HOST path; the shim runs on the host, so without
      stripping every finding would be wrongly dropped.)
   b. test -f "${worktreePath}/<normalized-path>". Exists → GROUNDED (keep, and
      rewrite finding.file to the normalized path). Missing → DROP the finding:
      add { id, file, reason: "file_not_found" } to a \`dropped\` array and EXCLUDE
      it from findingsList.
   c. A finding with NO "file" is kept as-is (plan-level/general — nothing to ground).
   d. If verdict == ISSUES_FOUND AND at least one finding named a file AND EVERY
      file-bearing finding was dropped (0 grounded) → the whole review is suspect.
      This attempt FAILED: go to the NEXT link of the chain. If every remaining link is
      ALSO 0/N grounded, return "ERROR", status "ungrounded_review".
   e. Write the grounding line "grounded: <G>/<N> findings, <D> dropped" (N = file-bearing
      findings seen, G = grounded, D = dropped), with the dropped findings beneath it, to
      ${planDir}/seat-notes/${rawFile} (mkdir -p ${planDir}/seat-notes; overwrite). NEVER add it
      to ${planDir}/${rawFile} — that file is the seat's byte-identical handoff.
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
7.5 ${toolDenialCheck(`${tmpFile.replace(/\.txt$/, '')}-l<N>, N = that link's number in step 3`)}
8. Update ${planDir}/metadata.json ${META_PRESERVE_NOTE}: review_round=${round}, status="reviewed",
   phase="review-${round}", and record grounded/dropped counts. Do NOT write
   review_fingerprints or convergence here — the orchestrator records those once per
   round (concurrent shim writes would race). Also append
   {"role": "bloodhound", "round": ${round}, "file": "${rawFile}", "sha256": "<hex>", "provider": "<family>"}
   to the "seat_artifacts" array (create it if absent) — sha256 from the WOLFPACK_ARTIFACT_DELIVERED
   line (Vibe link), or \`sha256sum ${planDir}/${rawFile}\` of the file the claude link wrote.
9. Clean up temp files: rm -f ${tmpFile}
10. Return: verdict, findings (count of GROUNDED findingsList items), findingsList
    (grounded only, each with id/severity/title/file/line/claim/evidence/FINGERPRINT),
    grounded (count), dropped (the array from step 7), and the provider FAMILY that produced
    the ACCEPTED review as \`provider\` (exactly one of ${bhChain.map(f => `"${f}"`).join(', ')}). Also set
    \`status\` to that provider. Also return \`deniedTools\` and (when the block had it) \`toolAccess\`
    from step 7.5. Also return \`artifacts\`: [{file, sha256}] from the accepted link's
    WOLFPACK_ARTIFACT_DELIVERED lines, or [] for the claude link.

If NO link produced an acceptable review — every CLI in the chain failed to run, OR every run
lacked a parseable <verdict> block / was malformed / was an empty-findings
contradiction / grounded 0/N — return verdict "ERROR" with the MOST SPECIFIC status
above (missing_verdict_block | malformed_verdict | empty_findings_contradiction |
ungrounded_review). There is NO path that turns a block-less or ungrounded review
into APPROVED.
${RATE_LIMIT_SIGNAL_NOTE}
${HANDOFF_SIGNAL_NOTE}
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

    // Cross-family runtime invariant — BEFORE trusting (or sticking to) the answer.
    if (reviewResult.verdict !== 'ERROR') {
      const bhViolation = crossFamilyViolation(reviewResult, PLAN_WRITER_FAMILIES, bhChain)
      if (bhViolation) {
        log(`⛔ ${slug}: Bloodhound round ${round} CROSS-FAMILY VIOLATION — ${bhViolation}. Parking (not trusting this review).`)
        await parkHunt({
          reason: 'cross_family_violation', resumePhase: 'Review', resolutionTypeExpected: 'clarify', phaseLabel: 'Review',
          needFromUser: `The plan review for round ${round} could not be proven cross-family: ${bhViolation}. The review was NOT accepted. Resume to re-run the review (clarify), or fix the reviewer plumbing (redirect).`,
          context: `Examiner chain: ${bhChain.join(' → ')}; providers reported: ${JSON.stringify(reviewResult.providers || [reviewResult.provider])}`,
        })
        return { slug, verdict: 'PARKED', status: 'parked:cross_family_violation', reason: 'cross_family_violation', tier, worktreePath }
      }
      await noteClaudeFallbackReview('bloodhound', round, reviewResult, bhChain, 'Review')
      await noteAuditOnly('bloodhound', round, reviewResult, `${planDir}/review-${round}.md`, 'Review')
      logSeatArtifacts('bloodhound', round, reviewResult)
    }

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
      // [05] AC3 — distinguish a QUOTA outage (every chain examiner rate-limited; status
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
          ? `Every examiner in the chain (${chainLabel(bhChain)}) is rate-limited / quota-exhausted, so the plan review could not run. This is transient: re-run the campaign after the window resets (the host gate auto-resumes overnight runs) — clarify to resume, or redirect if you suspect the reviewer plumbing.`
          : `Every examiner in the chain (${chainLabel(bhChain)}) failed to produce a usable verdict for the plan review even at sequential concurrency (cap 1) — likely a model outage or quota exhaustion. Decide: retry later (clarify → resume the review), or investigate the reviewer plumbing (redirect).`,
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

    // [dropped-agent guard] alpha-revise regenerates the FULL plan (large output), the step most
    // exposed to a mid-response connection drop — agent() then returns null and a bare
    // revisionResult.findingsAddressed deref crashed the whole campaign (observed on
    // inventory-adjustment-core r1/r3, 2026-07-02). Retry the transient drop inline, then fail
    // LOUD + resumable rather than a cryptic TypeError; never silently proceed with 0 addressed.
    let revisionResult = null
    for (let reviseAttempt = 1; reviseAttempt <= 3 && !revisionResult; reviseAttempt++) {
      if (reviseAttempt > 1) log(`↻ alpha-revise:${slug}:r${round} dropped mid-response — retry ${reviseAttempt}/3`)
      revisionResult = await agent(`
You are the Alpha planner running a Phase 2 revision, headlessly.

First, read your full instructions at ${PACK_SKILLS}/alpha/SKILL.md — follow the Phase 2 (Revision) section.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

cd to ${worktreePath} before doing any work.

Read:
- ${planDir}/review-${round}.md (Bloodhound findings for this round)
- ${planDir}/seat-notes/review-${round}.md (pipeline notes on that review: grounding, dropped findings, audit-only — if present)
- ${planDir}/${planFile} (the current plan)

MANDATORY: Address EVERY finding below. For each, mark ACCEPTED (explain what you changed in
the revised plan) or REJECTED (explain specifically why the finding is incorrect or out of scope).
Skipping a finding is NOT allowed — every line must have a disposition.

--- FINDINGS CHECKLIST (from Bloodhound round ${round}) ---
${checklist}
--- END CHECKLIST ---

Produce ${planDir}/plan-revised-${round}.md as the COMPLETE, self-contained revised plan (Shepherd
implements from it, so it can't be a diff) — but BUILD it by making MINIMAL, TARGETED edits to the
current plan: change only the sections the findings touch, and preserve every untouched section
VERBATIM. Do NOT rewrite, re-explain, or pad sections the findings don't concern. The plan MUST NOT
grow round-over-round; aim to keep it under ~1,200 lines — well past that the headless reviewer
times out. A revised plan materially larger than the current one means you rewrote instead of edited
(surgical edits also avoid introducing NEW defects in sections that were already correct — a primary
reason review loops fail to converge). If the current plan is ALREADY oversized — e.g. it carries
accreted "## Bloodhound Response" / "## Revisions After Review" sections from prior rounds, or
redundant restatements — COMPACT it as part of this revision: strip those embedded per-round logs
(their dispositions now live in the revision-log files) and any duplicated prose, preserving ALL
substantive plan content.

Write the per-finding dispositions (each: ACCEPTED with what changed, or REJECTED with why) to a
SEPARATE file ${planDir}/revision-log-${round}.md. Do NOT embed a "## Bloodhound Response" or
"## Revisions After Review" section inside the plan — that per-round log accreting in the plan is
what bloats it past the reviewer's size limit and eventually times the review out. (This supersedes
any "add a Revisions section to the plan" guidance in the skill.)
Update ${planDir}/metadata.json ${META_PRESERVE_NOTE}.

Return the findingsAddressed array with disposition (ACCEPTED or REJECTED) and justification for each.
Set allAddressed to true only if every finding has a disposition.

Do NOT ask the user. Pick reasonable defaults.
${heartbeat('Review', `Alpha revision round ${round}`)}${HUMAN_NOTES_DIRECTIVE}${convergenceMetaInstruction(planDir, bhEntry, verdictC.detail.startsWith('converging') ? 'converging' : 'continue', cumCrit)}
`, { label: `alpha-revise:${slug}:r${round}`, phase: 'Review', schema: REVISION_SCHEMA })
    }
    if (!revisionResult) {
      throw new Error(`alpha-revise:${slug}:r${round} returned null after 3 attempts (agent dropped mid-response / terminal API error) — cannot proceed without the revised plan; resume the run to retry this round.`)
    }

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

First, read your full instructions at ${PACK_SKILLS}/alpha/SKILL.md — follow the Phase 2.5 (Debrief) section.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

cd to ${worktreePath} before doing any work.

Read all review rounds and the final plan version.

Execute:
- Write ${planDir}/debrief.md summarizing accepted/rejected findings
- Write ${planDir}/plan-final.md (copy of the last accepted plan version)
- Compute and write all 6 model_assignments to ${planDir}/metadata.json
- Update ${planDir}/metadata.json ${META_PRESERVE_NOTE}: phase="implement", status="ready"

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

PROTECTED-PATH CHECK (mandatory): agents cannot edit these paths (the permission
classifier refuses them):
${PROTECTED_AGENT_PATHS.map(p => `  - ${p}`).join('\n')}
If plan-final.md changes any file under them, add a "## Human-Applied Edits" section to
debrief.md listing each such file and the exact change, and mark those plan-final items
"(human-applied patch)". The Shepherd stages them as patches in ${HUMAN_PATCH_DIR}/ and the
hunt parks for the human to apply them. If none, write "## Human-Applied Edits\nNone." Where
a plan item can reach its goal without touching a protected path, prefer that.

For model selection, use pedigree-driven algorithm from your skill.
Do NOT ask the user.
${heartbeat('Debrief', 'synthesizing plan-final')}${HUMAN_NOTES_DIRECTIVE}
`, { label: `debrief:${slug}`, phase: 'Debrief' })
}

// Human-patch gate. After the Shepherd runs, any patch in human-patches/ that is not yet
// applied to the worktree (git apply --check -R fails) means a protected-path change is
// still waiting for the human, so the hunt parks rather than reviewing and testing code
// that is missing it. /resolve after the human applies + commits → clarify → Code Review.
const HUMAN_PATCH_SCHEMA = {
  type: 'object',
  properties: {
    pending: { type: 'array', items: { type: 'object', properties: {
      patch: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, applies: { type: 'boolean' },
    }, required: ['patch', 'paths', 'applies'] } },
  },
  required: ['pending'],
}
async function humanPatchGate(phaseLabel) {
  const check = await agent(`
You are a READ-ONLY probe. Do NOT modify, apply, stage or commit anything.
cd to ${worktreePath}. If ${HUMAN_PATCH_DIR}/ does not exist or has no *.patch files, return { pending: [] }.
For each ${HUMAN_PATCH_DIR}/*.patch, in name order:
  - if \`git apply --check -R <patch>\` succeeds, it is already applied: skip it;
  - otherwise add { patch: <absolute path>, paths: <the b/ paths it touches, without the b/>,
    applies: <true if \`git apply --check <patch>\` succeeds, else false> }.
Return { pending: [...] }.
`, { label: `human-patch-check:${slug}`, phase: phaseLabel, schema: HUMAN_PATCH_SCHEMA, model: 'sonnet' })
  const pending = (check && Array.isArray(check.pending)) ? check.pending : []
  if (pending.length === 0) return null
  log(`⏸ ${slug}: ${pending.length} protected-path patch(es) need the human — parking human_patch`)
  const files = [...new Set(pending.flatMap(x => x.paths || []))]
  const steps = pending.map(x => `  git -C ${worktreePath} apply ${x.patch}${x.applies ? '' : '   # does NOT apply cleanly: inspect it first'}`).join('\n')
  await parkHunt({
    reason: 'human_patch',
    resumePhase: 'Code Review',
    resolutionTypeExpected: 'clarify',
    phaseLabel,
    needFromUser: `The plan changes protected agent-config files that agents cannot edit (${files.join(', ')}). The Shepherd staged the change as ${pending.length} patch(es). Review, apply and commit them on feat/${slug}, then /resolve (clarify) to resume at Code Review.`,
    context: `Apply (from any shell):\n${steps}\n  git -C ${worktreePath} add ${files.join(' ')}\n  git -C ${worktreePath} commit -m "fix(hooks): apply the Shepherd's staged patch"\nThe change is described in ${planDir}/shepherd-log.md under "## Human-Applied Patches".`,
    options: `- A (clarify): applied and committed — resume at Code Review.\n- B (redirect): the change is wrong — re-plan.`,
  })
  return { slug, verdict: 'PARKED', status: 'parked:human_patch', reason: 'human_patch', tier, worktreePath }
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
plan items. After fixing, re-run your self-check (git diff ${BASE}..HEAD) and commit on feat/${slug}.
`
} else if (resumeStatus === 'code_rewrite_needed') {
  const n = resumeProbe.pointerRounds || 1
  rewriteDirective = `
REWRITE ENTRY — Pointer round ${n} (NOT a fresh build): the code is already implemented and
committed on feat/${slug}; the Pointer bounced it back. Read ${planDir}/pointer-review-${n}.md
(pipeline notes, if any: ${planDir}/seat-notes/pointer-review-${n}.md)
and fix EVERY finding it lists (all severities) — do not re-scaffold or re-implement settled
plan items. After fixing, re-run your self-check (git diff ${BASE}..HEAD) and commit on feat/${slug}.
`
}

// The Claude Shepherd (primary on non-glm hunts; fallback for a GLM miss). fallbackNote
// is the GLM-takeover block (skips the rebase the GLM wrapper already did).
const runClaudeShepherd = (fallbackNote = '') => agent(`
You are the Shepherd implementing a Wolfpack hunt, running headlessly.

First, read your full instructions at ${PACK_SKILLS}/shepherd/SKILL.md — follow them exactly.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
${rewriteDirective}${fallbackNote}
cd to ${worktreePath} before doing any work.
${fallbackNote ? `
(Rebase already done by the GLM wrapper — skip it.)
` : `
CRITICAL FIRST STEP: Rebase onto ${REBASE_LABEL} to avoid worktree drift.
  cd ${worktreePath} && ${REBASE_CMD}
  If the rebase FAILS (conflict, diverged history, etc.):
  - Run: git rebase --abort
  - Return verdict "REBASE_CONFLICT" immediately — do NOT proceed with implementation
  - The user must resolve the conflict manually
`}
Only if rebase succeeds, execute ALL Shepherd instructions:${BASE_META_LINE ? `
- ${BASE_META_LINE}` : ''}
- Read ${planDir}/plan-final.md and ${planDir}/debrief.md
- Implement all plan items
- Write ${planDir}/shepherd-log.md documenting what was done, any deviations
- Self-check: git diff ${BASE}..HEAD vs plan items
- Commit on feat/${slug} with conventional commit messages
- Stage files by name only — NEVER git add . or git add -A

SAFETY RULES:
- Do NOT git push
- Do NOT deploy
- Do NOT run the test suite. Running tests is the TRACKER phase's job, not yours (your SKILL.md says this too). To confirm your code loads, the MOST you may do is a fast syntax/import check (e.g. \`node --check <file>\`, a compile, or the project's quick check if wolfpack-config.md names one). NEVER invoke the project's test command (\`${cfg().testCommand}\`) — the full suite can hang for a long time and livelock the whole pipeline. Tracker runs the suite, scoped, in its own phase.
- Do NOT modify files outside the worktree
- Do NOT run git add . or git add -A
${PROTECTED_PATCH_RULE}

Do NOT ask the user. If you need to deviate from the plan, document it in shepherd-log.md.
${fallbackNote ? '' : CLAUDE_WRITER_RECORD}
${heartbeat('Implement', 'Shepherd coding')}${HUMAN_NOTES_DIRECTIVE}
`, { label: `shepherd${fallbackNote ? '-fallback' : ''}:${slug}`, phase: 'Implement', model: shepherdModel })

// A fresh build goes to the seat family; a bounce re-entry (rewriteDirective) goes back to
// the family that LAST actually wrote the code (a Claude takeover stays with Claude).
const implFamily = rewriteDirective ? reworkFamily() : shepherdFamily
log(`Implement step → ${implFamily === 'glm' ? 'Vibe/GLM' : `Claude ${shepherdModel}`}${rewriteDirective ? ` (rework; last writer: ${lastWriterFamily || 'unknown'})` : ''}`)
if (implFamily === 'glm') {
  // GLM has no shell: the task names every file it must read/write by absolute path,
  // and the wrapper commits. The rewrite directive (Tracker/Pointer bounce entry) rides
  // along verbatim — "commit on feat/…" in it is the wrapper's job, not GLM's.
  const glmTask = `You are the Wolfpack Shepherd (implementer) for hunt '${slug}', tier ${tier}.
You have NO shell: you cannot run git, tests or any command. Your tools: read_file, grep,
write_file (creates NEW files only — it refuses a file that exists), edit (modify an
EXISTING file), dev_cortex_repo_map and dev_cortex_file_outline (code maps of this
checkout). The worktree root is ${worktreePath} (already rebased); use absolute paths under it.
${rewriteDirective ? `${rewriteDirective}(A wrapper commits your changes after you finish — you cannot commit.)\n` : ''}
1. Read ${worktreePath}/.agents/skills/shepherd/SKILL.md (if present in this checkout; otherwise your seat profile carries the role) and follow it, skipping anything
   that needs a shell (rebase, git, tests — the wrapper handles git; Tracker runs tests).
2. Read ${worktreePath}/CLAUDE.md for the project rules, then ${planDir}/plan-final.md and
   ${planDir}/debrief.md. Implement ALL plan items in the worktree.
3. Write ${planDir}/shepherd-log.md (write_file if it does not exist yet, else edit)
   documenting what you did, file by file, and any deviation from the plan with its reason.
4. Do NOT modify files outside ${worktreePath}. Under .wolfpack/ touch ONLY shepherd-log.md.
   Do not write or edit test files unless the plan explicitly lists them as implementation.
   NEVER edit a file under ${PROTECTED_AGENT_PATHS.join(', ')}: for each change the plan needs
   there, write_file a unified diff (worktree-relative a/ b/ paths) to
   ${HUMAN_PATCH_DIR}/<NN>-<short-name>.patch and list it in shepherd-log.md under
   "## Human-Applied Patches". A human applies it.
EFFICIENCY: start from dev_cortex_repo_map / dev_cortex_file_outline and grep; read only the
line ranges you need — never whole 1000+ line files. Make ONE tool call at a time.
End your response with a short list of every file you created or changed.`
  const g = await runGlmShepherd({ mode: 'implement', round: 1, task: glmTask, phaseLabel: 'Implement' })
  noteGlmStep(g)
  if (g.outcome === 'done') {
    log(`GLM Shepherd implemented ${slug} (${(g.changedFiles || []).length} file(s), committed=${!!g.committed}).`)
  } else if (g.outcome === 'rebase_conflict') {
    log(`⚠ ${slug}: REBASE_CONFLICT before the GLM Shepherd ran — the user must resolve the conflict manually (same as the Claude path).`)
  } else {
    log(`⚠ WOLFPACK_FALLBACK: shepherd r1 glm→claude:${shepherdModel} reason=${glmFallbackReason(g)} (${g.outcome}: ${String(g.evidence || '').slice(0, 160)})`)
    await runClaudeShepherd(glmFallbackNote(g, 1))
    noteClaudeWrote()
  }
} else {
  await runClaudeShepherd()
  noteClaudeWrote()
}
log(`Code-writer families after Implement: ${[...codeWriterFamilies].join(', ')} (last writer: ${lastWriterFamily || 'none'})`)
const implPatchPark = await humanPatchGate('Implement')
if (implPatchPark) return implPatchPark
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
  // usage-limit-gate (AC6, A-5): under a usage offload the GLM Shepherd wrote the code on a
  // tier that normally forces Opus. On Red OR compliance-critical hunts, an APPROVED
  // cross-family round is followed by ONE more round on chain ['claude'] — a CLAUDE FINAL
  // REVIEW (not a fallback) — through the same prompt, verdict contract, grounding and
  // convergence bookkeeping. ISSUES_FOUND there takes the normal rework path, and the next
  // approval goes cross-family again and then Claude-final again. Claude never reviews code
  // Claude wrote: if the Claude fallback Shepherd fired, the final review is skipped (logged).
  const claudeFinalNeeded = () =>
    (tier === 'Red' || seatComplianceCritical) && usageOffloadActive && !codeWriterFamilies.has('claude')
  let claudeFinalPassed = false
  let claudeFinalRound = false     // true while the CURRENT round is the Claude final review
  let claudeFinalSkipLogged = false
  // Pointer r1 F3: the mandated Claude-final rounds are EXTRA rounds the cross-family
  // approval earned — they must not eat into the convergence breaker. classifyConvergence
  // therefore sees the CROSS-FAMILY round count (pRound minus Claude-final rounds run). Still
  // bounded: every Claude-final round needs a preceding cross-family APPROVED round, and each
  // of those advances the effective count, so the breaker still trips on a writer/Claude
  // ping-pong after maxRounds cross-family rounds.
  let claudeFinalRoundsRun = 0

  while (!pointerApproved) {
    pRound++
    if (claudeFinalRound) claudeFinalRoundsRun++
    log(`Pointer round ${pRound}${claudeFinalRound ? ' — CLAUDE FINAL REVIEW (usage offload, Red/compliance)' : ''} (floor ${pFloor}, breaker ${pcfg.maxRounds} rounds, plan-smell ≥${pcfg.planSmellBound} distinct criticals, crit-persist ${pcfg.critPersist})`)

    // Code-review chain: enabled examiners minus EVERY family that wrote code on this
    // branch (a GLM Shepherd removes glm; a Claude fallback keeps claude excluded too).
    // The Claude final review round forces ['claude'] (claude is not a writer — checked).
    ensureCodeWriterRecord()
    const ptrChain = claudeFinalRound ? ['claude'] : examinerChain(codeWriterFamilies)
    if (!ptrChain.length) {
      log(`⛔ ${slug}: no cross-family examiner left for the code review (writers: ${[...codeWriterFamilies].join(', ')}). Parking.`)
      await parkHunt({
        reason: 'no_cross_family_reviewer', resumePhase: 'Code Review', resolutionTypeExpected: 'redirect', phaseLabel: 'Code Review',
        needFromUser: `Every enabled examiner shares a family with the code's writer(s) (${[...codeWriterFamilies].join(', ')}), so no cross-family code review is possible. Enable another examiner family (WOLFPACK_ENABLE_GLM / WOLFPACK_ENABLE_MISTRAL_AUTO) or re-implement with a different Shepherd, then resume.`,
        context: `Enabled examiners: ${EXAMINER_ORDER.join(', ') || '(none)'}; code writer families: ${[...codeWriterFamilies].join(', ')}`,
      })
      return { slug, verdict: 'PARKED', status: 'parked:no_cross_family_reviewer', reason: 'no_cross_family_reviewer', tier, worktreePath }
    }
    log(`Pointer chain r${pRound}: ${chainLabel(ptrChain)} (code writers: ${[...codeWriterFamilies].join(', ')})`)

    const buildPointerPrompt = (unit, nudge) => {
      const rawFile = unit.key === 'full' ? `pointer-review-${pRound}.md` : `pointer-review-${pRound}-${unit.key}.md`
      const tmpFile = unit.key === 'full' ? `/tmp/pointer-${slug}-r${pRound}.txt` : `/tmp/pointer-${slug}-r${pRound}-${unit.key}.txt`
      // seat-handoff-writes: ONE out dir per seat, round and lens (every Vibe link shares it).
      const handoff = { dir: unit.key === 'full' ? `pointer-r${pRound}` : `pointer-r${pRound}-${unit.key}`, expect: [rawFile] }
      const finalBanner = claudeFinalRound ? `
CLAUDE FINAL REVIEW (usage offload, Red/compliance) — not a fallback. The cross-family chain
already APPROVED this diff; this is the mandated judgment-tier pass on GLM-written code. Review
it with the SAME rigour and the SAME verdict contract.
` : ''
      return `${finalBanner}
You are a shim agent orchestrating a Pointer code review${unit.focus ? ` (FOCUS LENS: ${unit.key})` : ''}. The examiner chain
for this code review is ${chainLabel(ptrChain)} — try each link in order, moving to the next
only when the current one fails. (${claudeFinalRound
  ? 'This round the ONLY link is the mandated Claude FINAL review — not a fallback'
  : 'Claude only as the final last-resort link'}; none shares a
family with the code's writer(s): ${[...codeWriterFamilies].join(', ')}.)

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
Round: ${pRound}
Tier: ${tier}

Steps:
1. cd to ${worktreePath}

2. Write the review prompt to a temp file:
   Write to ${tmpFile}:
   "You are reviewing code for Wolfpack hunt '${slug}', Pointer round ${pRound}, tier ${tier}. Read plan-final.md at ${planDir}/plan-final.md and shepherd-log.md at ${planDir}/shepherd-log.md. Run 'git diff ${BASE}..HEAD' to see the code changes. Read .agents/skills/pointer/SKILL.md (if present in this checkout; otherwise your seat profile carries the role) and follow it. Produce your adversarial code review following your system prompt instructions.${unit.focus ? ` ${unit.focus}` : ''} EFFICIENCY (mandatory): work from the diff plus targeted greps — do NOT read whole large files; grep for a symbol then read only the relevant line range, and scope greps to the changed app directory (never the repo root) so they don't time out. Whole-file reads of large modules bloat context and can crash the request.${tier === 'Red' ? ' SINGLE-PASS REVIEW (mandatory, all models): do NOT spawn sub-agents or use the task tool. Produce ONE comprehensive code review covering every lens (correctness, compliance, multi-tenancy, security, edge-case/repro) in a single response, then emit the verdict block. Cross-model sub-agent fan-out is disabled — the pipeline handles orchestration.' : ''}${VERDICT_CONTRACT}${HANDOFF_NOTE(handoff)}${nudge || ''}"

3. Walk the EXAMINER CHAIN in order until one link yields an acceptable review:
${claudeFinalRound ? CLAUDE_FINAL_SELF_REVIEW_STEP(tmpFile) : chainSteps(ptrChain, 'wolfpack-pointer', tmpFile, 'pointer', handoff)}
   Each wrapper enforces a read-only review and caps concurrent calls on its
   model (flock). Run each EXACTLY as given — no extra flags, no parallel spawns.
   An attempt FAILS if ANY of: non-zero exit, empty output, no parseable
   <verdict> block (step 6), or — for an ISSUES_FOUND verdict — every file-bearing
   finding fails the grounding check (step 7). A rate-limit signal (exit 75 /
   WOLFPACK_RATE_LIMITED) skips straight to the next link — no retry. A Vibe link's exit 0
   is checked by the HANDOFF SIGNAL rules below (exit 78 / any WOLFPACK_ARTIFACT_ERROR line =
   that link FAILED).
   ${chainBoundary(ptrChain, codeWriterFamilies)}

4. When a link FAILS, move to the NEXT link of the chain (log the fallback — see below).

5. THE ARTIFACT. Vibe link: the shim delivered ${planDir}/${rawFile} itself (HANDOFF SIGNAL) —
   do not write or modify it. claude link: save your review to ${planDir}/${rawFile}. (The
   SANDBOXED SEAT HANDOFF note in the review prompt applies only to Vibe links.)
   REJECTED delivered link (exit 0 but step 6/7 fails it, OR a FAILED handoff — exit 78 / any
   WOLFPACK_ARTIFACT_ERROR line — whose .err names ${rawFile} in a WOLFPACK_ARTIFACT_DELIVERED or
   "move-failed" line and the file exists): before the next link run exactly
     mkdir -p ${planDir}/seat-notes && mv -f ${planDir}/${rawFile} ${planDir}/seat-notes/${rawFile}.rejected-l<N>
6. EXTRACT THE VERDICT from ${planDir}/${rawFile} (the delivered artifact) for a Vibe link, or
   from your own review for the claude link — strict extract-and-validate, NO prose-rescue. The
   reviewer was instructed to end with exactly one <verdict>{...}</verdict> block:
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
   a. Normalize: strip a leading "${worktreePath}/" or "/workspace/", then any remaining
      leading "/" → repo-root-relative (a containerized reviewer emits /workspace/... —
      or the worktree's host path for a GLM seat; unstripped paths would all be dropped).
   b. test -f "${worktreePath}/<normalized-path>". Exists → GROUNDED (keep, rewrite
      finding.file to the normalized path). Missing → DROP: add
      { id, file, reason: "file_not_found" } to a \`dropped\` array, EXCLUDE from findingsList.
   c. A finding with no "file" is kept as-is (plan-level/general).
   d. If verdict == ISSUES_FOUND AND ≥1 finding named a file AND every file-bearing
      finding was dropped (0 grounded) → review is suspect: this attempt FAILED, go to
      the NEXT link. If every remaining link is also 0/N grounded, "ERROR", status
      "ungrounded_review".
   e. Write the grounding line "grounded: <G>/<N> findings, <D> dropped", with the dropped
      findings beneath it, to ${planDir}/seat-notes/${rawFile} (mkdir -p ${planDir}/seat-notes;
      overwrite). NEVER add it to ${planDir}/${rawFile} — that file is the seat's
      byte-identical handoff.
6.5 FINGERPRINT — for every GROUNDED finding compute a coarse \`fingerprint\`:
   <normalized repo-relative file path, or "plan" if no file> + ":" + <defect-class>.
   The defect-class is a 2-4 word lowercase-kebab slug naming the UNDERLYING defect
   bucket from the claim/title — e.g. "missing-related-name", "tenant-leak",
   "unrounded-tax", "cs-retention-short", "null-deref", "missing-test". CRUCIAL: the SAME
   underlying defect in the SAME file across DIFFERENT rounds MUST yield the SAME
   fingerprint — bucket by the DEFECT, not by wording or line number. Put \`fingerprint\`
   on every finding in findingsList.
7.5 ${toolDenialCheck(`${tmpFile.replace(/\.txt$/, '')}-l<N>, N = that link's number in step 3`)}
8. Update ${planDir}/metadata.json ${META_PRESERVE_NOTE}: pointer_round=${pRound}, status per verdict, record
   grounded/dropped counts. Do NOT write review_fingerprints or convergence here — the
   orchestrator records those once per round (concurrent shim writes would race). Also append
   {"role": "pointer", "round": ${pRound}, "file": "${rawFile}", "sha256": "<hex>", "provider": "<family>"}
   to the "seat_artifacts" array (create it if absent) — sha256 from the WOLFPACK_ARTIFACT_DELIVERED
   line (Vibe link), or \`sha256sum ${planDir}/${rawFile}\` of the file the claude link wrote.${claudeFinalRound ? CLAUDE_FINAL_REVIEW_STEP(pRound) : ''}
9. Clean up temp files: rm -f ${tmpFile}
10. Return: verdict, findings (count of GROUNDED items), findingsList (grounded only,
    each with id/severity/title/file/line/claim/evidence/FINGERPRINT), grounded (count),
    dropped (array), and the provider FAMILY that produced the accepted review as
    \`provider\` (exactly one of ${ptrChain.map(f => `"${f}"`).join(', ')}). Also return \`deniedTools\`
    and (when the block had it) \`toolAccess\` from step 7.5. Also return \`artifacts\`:
    [{file, sha256}] from the accepted link's WOLFPACK_ARTIFACT_DELIVERED lines, or [] for the
    claude link.

If NO link produced an acceptable review — every CLI in the chain failed, OR every run lacked a
parseable <verdict> block / was malformed / was an empty-findings contradiction /
grounded 0/N — return verdict "ERROR" with the MOST SPECIFIC status
(missing_verdict_block | malformed_verdict | empty_findings_contradiction |
ungrounded_review). No block-less or ungrounded review becomes APPROVED.
${RATE_LIMIT_SIGNAL_NOTE}
${HANDOFF_SIGNAL_NOTE}
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

    // Cross-family runtime invariant — the reviewer must not share the code writer's family.
    if (pointerResult.verdict !== 'ERROR') {
      const ptrViolation = crossFamilyViolation(pointerResult, codeWriterFamilies, ptrChain)
      if (ptrViolation) {
        log(`⛔ ${slug}: Pointer round ${pRound} CROSS-FAMILY VIOLATION — ${ptrViolation}. Parking (not trusting this review).`)
        await parkHunt({
          reason: 'cross_family_violation', resumePhase: 'Code Review', resolutionTypeExpected: 'clarify', phaseLabel: 'Code Review',
          needFromUser: `The code review for round ${pRound} could not be proven cross-family: ${ptrViolation}. The review was NOT accepted. Resume to re-run the code review (clarify), or fix the reviewer plumbing (redirect).`,
          context: `Examiner chain: ${ptrChain.join(' → ')}; code writer families: ${[...codeWriterFamilies].join(', ')}; providers reported: ${JSON.stringify(pointerResult.providers || [pointerResult.provider])}`,
        })
        return { slug, verdict: 'PARKED', status: 'parked:cross_family_violation', reason: 'cross_family_violation', tier, worktreePath }
      }
      // The Claude FINAL review is mandated, not a last-resort fallback — it records into
      // metadata.claude_final_reviews (CLAUDE_FINAL_REVIEW_STEP), not claude_fallback_reviews.
      if (!claudeFinalRound) await noteClaudeFallbackReview('pointer', pRound, pointerResult, ptrChain, 'Code Review')
      await noteAuditOnly('pointer', pRound, pointerResult, `${planDir}/pointer-review-${pRound}.md`, 'Code Review')
      logSeatArtifacts('pointer', pRound, pointerResult)
    }

    if (!claudeFinalRound) setExaminer(pointerResult.provider, `sticky: answered pointer round ${pRound}`)

    if (pointerResult.verdict === 'APPROVED') {
      if (claudeFinalRound) {
        claudeFinalPassed = true
        claudeFinalRound = false
        pointerApproved = true
        log(`Pointer APPROVED at round ${pRound} — CLAUDE FINAL REVIEW passed (usage offload).`)
        break
      }
      if (!claudeFinalPassed && claudeFinalNeeded()) {
        claudeFinalRound = true
        log(`Pointer cross-family APPROVED at round ${pRound} — running the CLAUDE FINAL REVIEW (usage offload on ${tier === 'Red' ? 'Red' : 'compliance-critical'} hunt) before Test.`)
        continue
      }
      if (!claudeFinalPassed && !claudeFinalSkipLogged && usageOffloadActive &&
          (tier === 'Red' || seatComplianceCritical) && codeWriterFamilies.has('claude')) {
        claudeFinalSkipLogged = true
        log(`⚠ Claude final review SKIPPED — claude wrote code on this branch; cross-family review stands`)
        await agent(`
You are a minimal RECORD writer. Do exactly one thing, then return.
Set "claude_final_review_skipped" in ${planDir}/metadata.json to
  {"round": ${pRound}, "reason": "claude wrote code on this branch (Claude fallback Shepherd) — Claude cannot review its own code; cross-family review stands"}
${META_PRESERVE_NOTE}. Do NOT alter any other file. Do NOT commit. Return recorded: true.
`, { label: `claude-final-skip-record:${slug}:r${pRound}`, phase: 'Code Review',
     schema: { type: 'object', properties: { recorded: { type: 'boolean' } }, required: ['recorded'] },
     model: 'sonnet' })
      }
      pointerApproved = true
      log(`Pointer APPROVED at round ${pRound}`)
      break
    }
    // A Claude final round that did NOT approve (ISSUES_FOUND / ERROR) falls through to the
    // normal handling below; the NEXT approval walks the cross-family chain again first.
    const wasClaudeFinalRound = claudeFinalRound
    claudeFinalRound = false
    if (pointerResult.verdict === 'ERROR') {
      // [03] Part B — code-review fan-out floored at cap 1 and STILL failing → PARK.
      // [05] AC3 — quota outage (every chain examiner throttled) parks model_quota (host
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
          ? `Every examiner in the code-review chain (${chainLabel(ptrChain)}) is rate-limited / quota-exhausted, so the code review could not run. Transient: re-run after the window resets (clarify), or redirect if you suspect the reviewer plumbing.`
          : `Every examiner in the code-review chain (${chainLabel(ptrChain)}) failed to produce a usable verdict even at sequential concurrency (cap 1) — likely a model outage or quota exhaustion. Decide: retry later (clarify → resume the code review), or investigate the reviewer plumbing (redirect).`,
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

    // Pointer r1 F3: breaker sees cross-family rounds only (see claudeFinalRoundsRun). A
    // Claude-final ISSUES round shares the round number of the cross-family APPROVED round it
    // follows, and gets ONE round of grace past the breaker so that approval always earns a
    // rework (an approval AT maxRounds would otherwise park without one). Bounded: the next
    // cross-family round is already ≥ maxRounds+1 and parks on ISSUES; a further Claude-final
    // ISSUES parks at ≥ maxRounds+1.
    const effRound = pRound - claudeFinalRoundsRun
    const pv = classifyConvergence({
      round: effRound, findings: pFindings, history: pHistory, floor: pFloor,
      cfg: wasClaudeFinalRound ? { ...pcfg, maxRounds: pcfg.maxRounds + 1 } : pcfg,
    })
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

    // Pointer rewrites go back to the SAME Shepherd family that wrote the code. A GLM
    // rework that is rate-limited / fails falls back to the Claude Shepherd for this round
    // (logged), which also makes claude a code writer (already excluded from review).
    let rewriteResult = null
    let rewriteFallbackNote = ''
    if (reworkFamily() === 'glm') {
      const glmRework = `You are the Wolfpack Shepherd (implementer) for hunt '${slug}', addressing Pointer code-review round ${pRound}.
You have NO shell (no git, no tests, no commands). Tools: read_file, grep, write_file (NEW files
only — it refuses an existing file), edit (modify EXISTING files), dev_cortex_repo_map,
dev_cortex_file_outline. Worktree root: ${worktreePath} (absolute paths under it).
Read ${worktreePath}/.agents/skills/shepherd/SKILL.md (if present in this checkout; otherwise your seat profile carries the role) (skip shell steps) and the full review at
${planDir}/pointer-review-${pRound}.md (pipeline notes, if any: ${planDir}/seat-notes/pointer-review-${pRound}.md).
MANDATORY: address EVERY finding below — ACCEPTED (change the code, say what changed) or
REJECTED (say specifically why the finding is wrong). Skipping a finding is NOT allowed.
--- FINDINGS CHECKLIST (from Pointer round ${pRound}) ---
${pointerChecklist}
--- END CHECKLIST ---
Update ${planDir}/shepherd-log.md (edit) with the disposition of each finding. Touch nothing
outside ${worktreePath}; under .wolfpack/ touch ONLY shepherd-log.md and ${HUMAN_PATCH_DIR}/.
NEVER edit a file under ${PROTECTED_AGENT_PATHS.join(', ')}: write_file the change as a unified diff
(worktree-relative a/ b/ paths) to ${HUMAN_PATCH_DIR}/<NN>-<short-name>.patch instead. One tool call at a time.
End your response with EXACTLY ONE block, strict JSON, nothing after it:
<dispositions>{"findingsAddressed":[{"id":1,"severity":"HIGH","title":"...","disposition":"ACCEPTED","justification":"..."}],"allAddressed":true}</dispositions>`
      const g = await runGlmShepherd({ mode: 'rewrite', round: pRound, task: glmRework, phaseLabel: 'Code Review' })
      noteGlmStep(g)
      if (g.outcome === 'done' && Array.isArray(g.findingsAddressed)) {
        rewriteResult = { findingsAddressed: g.findingsAddressed, allAddressed: !!g.allAddressed, __glm: true }
        log(`GLM Shepherd reworked Pointer round ${pRound} (${g.findingsAddressed.length} disposition(s)).`)
      } else {
        log(`⚠ WOLFPACK_FALLBACK: shepherd r${pRound} glm→claude:${shepherdModel} reason=${glmFallbackReason(g)} (${g.outcome}: ${String(g.evidence || '').slice(0, 160)})`)
        rewriteFallbackNote = glmFallbackNote(g, pRound)
      }
    }
    // [dropped-agent guard] see alpha-revise above — a dropped Shepherd rewrite returns null and
    // the bare rewriteResult.findingsAddressed deref would crash the campaign. Retry then fail loud.
    for (let rewriteAttempt = 1; rewriteAttempt <= 3 && !rewriteResult; rewriteAttempt++) {
      if (rewriteAttempt > 1) log(`↻ shepherd-rewrite:${slug}:r${pRound} dropped mid-response — retry ${rewriteAttempt}/3`)
      rewriteResult = await agent(`
You are the Shepherd addressing Pointer code review findings, running headlessly.

Read ${PACK_SKILLS}/shepherd/SKILL.md for your instructions.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
${rewriteFallbackNote}
cd to ${worktreePath}.

Read ${planDir}/pointer-review-${pRound}.md for full context on each finding
(pipeline notes, if any: ${planDir}/seat-notes/pointer-review-${pRound}.md).

MANDATORY: Address EVERY finding below. For each, mark ACCEPTED (explain what code you changed)
or REJECTED (explain specifically why the finding is incorrect). Skipping a finding is NOT allowed.

--- FINDINGS CHECKLIST (from Pointer round ${pRound}) ---
${pointerChecklist}
--- END CHECKLIST ---

Commit fixes on feat/${slug}. Update ${planDir}/shepherd-log.md with the disposition of each finding.

Return the findingsAddressed array with disposition (ACCEPTED or REJECTED) and justification for each.
Set allAddressed to true only if every finding has a disposition.

SAFETY: No git push, no deploy, no git add .
${PROTECTED_PATCH_RULE}
${rewriteFallbackNote ? '' : CLAUDE_WRITER_RECORD}
${heartbeat('Code Review', `Shepherd rewrite round ${pRound}`)}${HUMAN_NOTES_DIRECTIVE}${convergenceMetaInstruction(planDir, pEntry, pv.detail.startsWith('converging') ? 'converging' : 'continue', pCumCrit)}
`, { label: `shepherd-rewrite:${slug}:r${pRound}`, phase: 'Code Review', schema: REVISION_SCHEMA, model: shepherdModel })
    }
    // A Claude rewrite ran (no GLM result) → Claude is now the last writer.
    if (rewriteResult && !rewriteResult.__glm) noteClaudeWrote()
    if (!rewriteResult) {
      throw new Error(`shepherd-rewrite:${slug}:r${pRound} returned null after 3 attempts (agent dropped mid-response / terminal API error) — cannot proceed without the rework; resume the run to retry this round.`)
    }

    const totalPtrFindings = pFindings.length
    const ptrAddressed = rewriteResult.findingsAddressed?.length || 0
    if (ptrAddressed < totalPtrFindings) {
      log(`⚠ Shepherd addressed ${ptrAddressed}/${totalPtrFindings} Pointer findings — ${totalPtrFindings - ptrAddressed} skipped`)
    } else {
      log(`Shepherd addressed all ${totalPtrFindings} Pointer findings`)
    }
    const reworkPatchPark = await humanPatchGate('Code Review')
    if (reworkPatchPark) return reworkPatchPark
  }
}

// ─── Phase 6: Tracker Tests (skipped on resume) ───────────────
// Tracker always runs in automated mode (minimums enforced above)
if (at('Test')) {
  phase('Test')
  log(`Tracker testing: ${slug}`)

  // [dropped-agent guard] Same lesson as alpha-revise and shepherd-rewrite above, which the Test
  // phase never got: agent() returns null when the subagent dies on a terminal error (quota
  // exhaustion, API failure after retries), and the bare `trackerResult.verdict` deref below
  // crashed the ENTIRE campaign run rather than parking the hunt. Observed 2026-08-01,
  // tickets-jul29 wave 2: "You've hit your session limit" → TypeError at the verdict gate, whole
  // workflow aborted with Pointer already approved and the work stranded mid-pipeline.
  let trackerResult = null
  for (let trackerAttempt = 1; trackerAttempt <= 3 && !trackerResult; trackerAttempt++) {
    if (trackerAttempt > 1) log(`↻ tracker:${slug} dropped mid-response — retry ${trackerAttempt}/3`)
    trackerResult = await agent(`
You are the Tracker writing and running tests, headlessly.

First, read your full instructions at ${PACK_SKILLS}/tracker/SKILL.md — follow them exactly.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}

cd to ${worktreePath} before doing any work.

Execute ALL Tracker instructions:
- Read plan-final.md, shepherd-log.md, pointer reviews, code diff
- Write tests per the tier strategy
- Run tests using: ${cfg().testCommand}
  (wolfpack-config.md → Project Identity → Test command — follow its notes on narrowing and on which test backend the sandbox uses)
- Classify failures (baseline/transient/pre-existing/legitimate)
- Write ${planDir}/tracker-log.md and ${planDir}/tracker-report-1.md if needed
- Update ${planDir}/metadata.json ${META_PRESERVE_NOTE}
- Commit test files on feat/${slug}. WRITER RECORD: end every commit message with the git
  trailer "${WRITER_TRAILER}: ${trackerFamily}"
  (git commit --trailer "${WRITER_TRAILER}: ${trackerFamily}") — the tests are code on this
  branch and the certifier must not share your family.
- In ${planDir}/metadata.json, append "${trackerFamily}" to the test_writer_families array
  (create it if absent; keep it de-duplicated). Preserve every other field.

Return verdict: "TESTS_PASS" if all tests pass, "TESTS_FAIL" if legitimate failures,
"REWRITE_NEEDED" if Shepherd needs to fix code.

SAFETY: No git push, no deploy, no git add .
Do NOT ask the user.
${heartbeat('Test', 'Tracker writing and running tests')}
`, { label: `tracker:${slug}`, phase: 'Test', schema: VERDICT_SCHEMA })
  }

  // Still nothing after 3 attempts → the subagent died terminally (almost always quota).
  // Park instead of crashing. `model_quota` is the ONE auto-resumable park (see isQuotaPark),
  // so the next runner pass picks the hunt back up at Test with no /resolve needed — which is
  // exactly right for a rate-limit window that resets on its own.
  if (!trackerResult) {
    log(`⏸ ${slug}: Tracker dropped 3x — parking model_quota at Test (auto-resumes next pass).`)
    await parkHunt({
      reason: 'model_quota',
      resumePhase: 'Test',
      resolutionTypeExpected: 'clarify',
      phaseLabel: 'Test',
      needFromUser: `The Tracker subagent died before returning a verdict — almost always a rate-limit / session-limit window rather than a code problem. This park is TRANSIENT and auto-resumes: re-run the campaign after the window resets and the hunt picks up at Test. No code change is implied; nothing about the diff has been judged.`,
      context: `Pointer had already approved the diff; only the Test phase is outstanding.`,
    })
    return { slug, verdict: 'PARKED_QUOTA', tier, worktreePath }
  }

  // P9/AC22 — the Tracker wrote code (tests) on the branch: record the REALIZED family before
  // any verdict gate, so a bounce or a fall-through to Certify both carry it. Phase 6 runs
  // BEFORE the Watchdog's examinerChain(), so the certifier sees it; the Pointer dispatch ran
  // earlier, which is why Pointer round 1 legitimately keeps its claude link.
  noteTrackerWrote(trackerResult)
  log(`Code-writer families after Test: ${[...codeWriterFamilies].join(', ')}`)

  // Gate on Tracker results — do NOT proceed to Watchdog if tests fail
  if (trackerResult.verdict === 'TESTS_FAIL' || trackerResult.verdict === 'REWRITE_NEEDED') {
    log(`Tracker: ${trackerResult.verdict}. Tests did not pass.`)
    // FORCE the resumable status instead of trusting the Tracker agent's own write.
    // Observed 2026-07-29 (tickets-jul29 / inventory-filter-stickiness): a Tracker that
    // found a legitimate failure wrote `tracker_complete` — a status in NEITHER
    // STATUS_RESUME, DONE_STATUSES, nor the human-gated set. The next pass therefore fell
    // through to the FORWARD-biased artifact scan, whose furthest artifact is
    // tracker-report-N.md → it resumes at Certify and can certify a hunt that fails its
    // own acceptance criteria. `test_rewrite_needed` is BACKWARD_AUTHORITATIVE, so it
    // overrides the artifact scan and routes back to Shepherd. Idempotent — harmless when
    // the Tracker already wrote the right status.
    await recordTestRewriteNeeded({ phaseLabel: 'Test' })
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

// Certification writes files (certification.md, pedigree.json). A Vibe link (both families)
// writes them ITSELF into its shim-mounted out dir and the shim delivers them byte-for-byte
// (seat-handoff-writes); the claude last-resort link (the shim agent itself) writes them
// directly. The old
// Agy "writes the files directly" branch is gone with the shim, and with it the
// print-mode fabrication surface documented in .wolfpack/cross-cutting-debt.md.
// The certifier walks the same cross-family chain as the Pointer: enabled examiners
// minus every family that wrote code OR TESTS on this branch.
// [07 §6] Cert turn budget (same correction as the review step above: disconnect was
// request-SIZE/gateway, fixed by the LEAN config — not a turn/TPM cap). A cert reads MORE
// (diff + tests + plan), so it needs at least as much room as a review. AC13: the Mistral
// certify budget is now >= the GLM review budget (was '15', sized for an opt-in afterthought).
const MISTRAL_CERTIFY_TURNS = (typeof process !== 'undefined' && process.env && process.env.WOLFPACK_MISTRAL_CERTIFY_TURNS) || GLM_REVIEW_TURNS
// AC13: the Mistral certifier runs the REAL wolfpack-watchdog agent. It used to borrow
// wolfpack-pointer, which handed the certifier the Pointer system prompt (known_traps #6).
// seat-handoff-writes: the certifier's out dir (round 0, as noteAuditOnly records it) and
// the two artifacts the shim delivers.
const wdHandoff = { dir: 'watchdog-r0', expect: ['certification.md', 'pedigree.json'] }
const vibeCertifyStep = `${shq(shimPath)} ${handoffArgs(wdHandoff)} wolfpack-watchdog ${shq(worktreePath)} ${shq(`/tmp/watchdog-${slug}.txt`)} ${shq(MISTRAL_CERTIFY_TURNS)}`
// The claude last-resort CERTIFY link — prose, not a command (there is no podman-claude.sh:
// the shim agent walking this chain already IS Claude). Watchdog is the highest-stakes seat,
// so this is spelled out in full rather than abbreviated.
const CLAUDE_SELF_CERTIFY_STEP = `(no shim — YOU are Claude.) Read the certify prompt file and perform the certification
       yourself, following the watchdog role skill it names (${PACK_SKILLS}/watchdog/SKILL.md) —
       the full checklist and the Pedigree rubric, not an abridged pass. Emit the same <verdict>
       block the shims must emit (PASS / REWORK / FLAWED_PLAN), with "provider": "claude", and
       write certification.md + pedigree.json into the plan dir yourself. Before you do, print
       WOLFPACK_CLAUDE_FALLBACK: watchdog r<round> reason=<why every cross-family link failed>
       and append {role: "watchdog", round, reason, evidence} to ${planDir}/metadata.json's
       "claude_fallback_reviews" array. The pedigree row MUST record that this certification was
       Claude's own last-resort pass, so a Claude-certified hunt is never indistinguishable from
       a cross-model one. This link exists ONLY because every cross-family certifier was
       unavailable; the cross-family golden rule still binds — if any Claude-family writer is in
       the code-writer families, examinerChain has already removed this link and reaching it at
       all is a bug, not a fallback.`
// GLM certifier: its own read-only Watchdog agent (wolfpack-watchdog-glm, glm-5.3), ≥80 turns.
const glmCertifyStep = `${shq(shimPath)} ${handoffArgs(wdHandoff)} wolfpack-watchdog-glm ${shq(worktreePath)} ${shq(`/tmp/watchdog-${slug}.txt`)} ${shq(GLM_REVIEW_TURNS)}`
const certifyStep = (who) => (who === 'glm' ? glmCertifyStep : who === 'mistral' ? vibeCertifyStep : CLAUDE_SELF_CERTIFY_STEP)
ensureCodeWriterRecord()
ensureTestWriterRecord()
const wdChain = examinerChain(codeWriterFamilies)
if (!wdChain.length) {
  log(`⛔ ${slug}: no cross-family certifier left (writers: ${[...codeWriterFamilies].join(', ')}). Parking.`)
  await parkHunt({
    reason: 'no_cross_family_reviewer', resumePhase: 'Certify', resolutionTypeExpected: 'redirect', phaseLabel: 'Certify',
    needFromUser: `Every enabled examiner shares a family with the code's writer(s) (${[...codeWriterFamilies].join(', ')}), so no cross-family certification is possible. Enable another examiner family, then resume.`,
    context: `Enabled examiners: ${EXAMINER_ORDER.join(', ') || '(none)'}; code writer families: ${[...codeWriterFamilies].join(', ')}`,
  })
  return { slug, verdict: 'PARKED', status: 'parked:no_cross_family_reviewer', reason: 'no_cross_family_reviewer', tier, worktreePath }
}
log(`Watchdog chain: ${chainLabel(wdChain)} (code writers: ${[...codeWriterFamilies].join(', ')})`)
const certifySteps = wdChain.map((who, i) => `   [${i + 1}] ${i === 0 ? 'PRIMARY' : 'FALLBACK'} ${EXAMINER_LABEL[who]} (provider "${who}"):
       ${who === 'claude' ? certifyStep(who) : shimRun(certifyStep(who), `/tmp/watchdog-${slug}-l${i + 1}`)}
       ${who === 'claude'
          ? 'This link IS you — follow the step above and write certification.md / pedigree.json yourself.'
          : `${EXAMINER_LABEL[who]} writes certification.md + pedigree.json itself; the shim delivers them byte-for-byte (HANDOFF SIGNAL). Do NOT write, edit or re-create either file for this link.`}`).join('\n')
  + (wdChain.some(w => w !== 'claude') ? `\n${SHIM_WAIT_RULE}` : '')
// seat-handoff-writes (review-6 #1): the certify prompt carries only the Vibe out-dir HANDOFF
// note, so the claude last-resort link gets its own explicit plan-dir write location here (the
// CLAUDE_SELF_CERTIFY_STEP / "This link IS you" texts stay unchanged).
const certifyClaudeBranch = wdChain.includes('claude') ? `
   claude link: the SANDBOXED SEAT HANDOFF note in the certify prompt does NOT apply to you —
   write certification.md + pedigree.json directly to ${planDir}/certification.md and
   ${planDir}/pedigree.json. The .seat-out/ path applies only to Vibe links (a shim delivers
   those); it does not exist for you.

` : ''

watchdogResult = await agent(`
You are a shim agent orchestrating Watchdog certification. The certifier chain for this
hunt is ${chainLabel(wdChain)} — try each link in order. No link shares a family with the
code's writer(s) (${[...codeWriterFamilies].join(', ')}) — certification must be cross-family.
Watchdog must produce certification.md and pedigree.json:
 - If the running link is a Vibe family (Vibe/GLM or Vibe/Mistral Large 4), the SEAT writes both
   files itself with write_file into its out dir and the shim delivers them into the plan dir
   byte-for-byte (HANDOFF SIGNAL) — YOU never write, edit or re-create them for that link.
 - If the running link is "claude" (the FINAL, last-resort link), there is no shim: YOU
   perform the certification yourself per that step and write the files directly.

Hunt: ${slug}
Worktree: ${worktreePath}
Plan dir: ${planDir}
Tier: ${tier}

Steps:
1. cd to ${worktreePath}

2. Write the Watchdog prompt to /tmp/watchdog-${slug}.txt:
   Read ${PACK_SKILLS}/watchdog/SKILL.md for the full Watchdog instructions.
   Build the prompt: "You are the Watchdog certifier for hunt '${slug}', tier ${tier}.
   Follow the Watchdog skill instructions.${tier === 'Red' ? ' SINGLE-PASS CERTIFICATION (mandatory, all models): do NOT spawn sub-agents or use the task tool. Run all certification lenses in ONE comprehensive pass, then emit the verdict block. Cross-model sub-agent fan-out is disabled.' : ''}
   Read plan-final.md at ${planDir}/plan-final.md,
   shepherd-log.md, debrief.md, metadata.json. Run git diff ${BASE}..HEAD for the code diff.
   Read .wolfpack/known-broken-tests.md and .wolfpack/cross-cutting-debt.md.
   EFFICIENCY (mandatory): certify from the diff plus targeted greps — do NOT read whole large files; grep for a symbol then read only the relevant range, and scope greps to the changed app directory (never the repo root) so they don't time out. Whole-file reads of large modules bloat context and can crash the certification request.
   SAFETY: No git push. No deploy commands. No \`git add -f\` — ever.
   You MUST run git diff ${BASE}..HEAD and the project's test command yourself. End your response with a <verdict> block: {verdict, plan_adherence, code_quality, test_result, tool_access: {shell: ok|denied|unused, denied_tools: []}} — tool_access is MANDATORY: report honestly whether your shell ran; list every denied or unknown tool call in denied_tools; never present a file-reading audit as a verified certification.${HANDOFF_NOTE(wdHandoff)}"

3. Walk the CERTIFIER CHAIN in order. Each wrapper caps concurrent calls on its model
   (flock). Run each EXACTLY as given, capture stdout for verdict parsing:
${certifySteps}
${certifyClaudeBranch}   A rate-limit signal (exit 75 / WOLFPACK_RATE_LIMITED) skips straight to the next link.
   A Vibe link's exit 0 is checked by the HANDOFF SIGNAL rules below (exit 78 / any
   WOLFPACK_ARTIFACT_ERROR line = that link FAILED).
   ${chainBoundary(wdChain, codeWriterFamilies)}

4. Extract the verdict from the link that ran, in PRIORITY ORDER:
   - If ${planDir}/certification.md exists (the shim delivered it, or the claude link wrote it), read the verdict from the file
   - Else if stdout has a <verdict> block, parse it
   - Else if stdout has a "## Status: <VERDICT>" line or a clear PASS / REWORK / FLAWED_PLAN statement, use that
   - If none of these are present, that link failed — go to step 5
   REJECTED delivered link (exit 0 but this step or 4.5 fails it, OR a FAILED handoff — exit 78 /
   any WOLFPACK_ARTIFACT_ERROR line — after a partial delivery: the .err has a
   WOLFPACK_ARTIFACT_DELIVERED or "move-failed" line): before the next link, move EVERY one of
   the two files that exists in ${planDir} aside, so no artifact of a failed link survives
   there (step 4's file-first read and the resume probe would take it as this round's verdict):
     mkdir -p ${planDir}/seat-notes; for f in certification.md pedigree.json; do [ ! -e ${planDir}/$f ] || mv -f ${planDir}/$f ${planDir}/seat-notes/$f.rejected-l<N>; done

4a. ${toolDenialCheck(`/tmp/watchdog-${slug}-l<N>, N = that link's number in step 3`)}

4.5 AUDIT-ONLY GATE (tier ${tier}): ${HEAVY(tier)
  ? `this tier cannot certify on audit alone. If the TOOL-DENIAL CHECK found ANY line, OR the verdict's
   tool_access shows shell as anything other than "ok" ("denied" or "unused") or lists any denied tool
   other than the read-only-by-role ${ROLE_DENIED_TOOLS.join('/')},
   OR the verdict has NO tool_access you can copy — do NOT perform the PASS-only actions: do not stamp status "certified" (step 7), do not run
   step 8/8b, do not append to .wolfpack/pedigree/index.md, do not commit. Still write
   certification.md if the claude link produced the verdict — a delivered Vibe link's
   certification.md / pedigree.json stay byte-identical (do NOT write, edit or re-create
   them) — and return the verdict with \`deniedTools\` / \`toolAccess\` — the pipeline parks it.`
  : `an audit-only certification is allowed on this tier but recorded; proceed normally and return
   \`deniedTools\` / \`toolAccess\`.`}

4.6 PASS-ONLY ACTIONS (YOU, the shim agent — never the certifier seat). On PASS, and only if
   4.5 allows it, perform these AFTER step 8 below has run (so the index row carries the
   DURATION value and the committed pedigree.json carries the timing block): append to
   .wolfpack/pedigree/index.md, run ./scripts/wolfpack-lessons.sh, then commit the wolfpack
   learning-loop artifacts. STRICT staging rules (a past bug force-committed gitignored
   worktree plan files into main at ${worktreeRoot}/<slug>/… paths — these rules prevent
   that recurrence):
     - FIRST \`cd ${worktreePath}\` so every path you stage is WORKTREE-RELATIVE. NEVER
       stage a path that begins with \`${worktreeRoot}/\` (that path only exists from the
       MAIN repo and force-commits the worktree's files into main).
     - Stage ONLY by EXACT name: \`.wolfpack/pedigree/index.md\`,
       \`.wolfpack/pedigree/lessons.md\` (if changed), and
       \`.wolfpack/plans/${slug}/pedigree.json\` (the force-tracked scorecard).
     - NEVER \`git add .\` / \`git add -A\` / \`git add -f\`. NEVER stage certification.md or
       metadata.json — they are GITIGNORED plan artifacts that ride the worktree and are
       copied back by /merge; force-adding them is the leak.
   Then \`git commit\`.

5. If a link failed, move to the NEXT link of the chain (step 3 list) and repeat step 4.

6. Clean up: rm -f /tmp/watchdog-${slug}.txt

7. Update ${planDir}/metadata.json based on verdict ${META_PRESERVE_NOTE}:
   PASS: phase="done", status="certified", completed_at=$(date -Iseconds) (the REAL clock — the t_end marker; "created" is t0)
   REWORK: phase="implement", status="rework_needed"
   FLAWED_PLAN: phase="plan", status="flawed_plan"
   Also append one row per file to the "seat_artifacts" array (create it if absent):
     {"role": "watchdog", "round": 0, "file": "certification.md" | "pedigree.json", "sha256": "<hex>", "provider": "<family>"}
   — sha256 from the WOLFPACK_ARTIFACT_DELIVERED lines (Vibe link), or \`sha256sum\` of the files
   the claude link wrote.

8. On PASS only — fold timing into the scorecard (non-blocking, like the lessons
   aggregator). Run this YOURSELF on the host AFTER the certifier returns (node is
   NOT in the sandbox container — do not put this in the certifier prompt):
   \`node ${shq(`${repoRoot}/scripts/wolfpack-timing.mjs`)} ${shq(planDir)}\`.
   It reads ${planDir}/timing.jsonl + metadata.json, writes a "timing" block into
   ${planDir}/pedigree.json, and prints a "DURATION=<…>" line plus an
   "INCOMPLETE" warning if any phase is missing a start/end. Capture the DURATION
   value and put it in the Duration column of the .wolfpack/pedigree/index.md row
   you append. If the script fails, log it and continue — timing is telemetry, not
   a gate.

8b. On PASS only — refresh the [06] per-model routing meter (host-side, non-blocking,
   same rules as step 8: run YOURSELF on the host after the certifier returns, node is
   NOT in the sandbox; pass the agent clock since the script has no Date):
   \`node ${shq(`${repoRoot}/scripts/wolfpack-model-stats.mjs`)} --stamp "$(date -Iseconds)"\`.
   It re-aggregates every .wolfpack/plans/*/pedigree.json (this hunt's now folded in:
   model_assignments, execution_scores, predicted_dimensions, and timing/review_fingerprints
   if present) into .wolfpack/pedigree/model-stats.json — per-model signal/noise/miss/spend
   sliced by domain, the substrate Alpha's router (scripts/wolfpack-routing.mjs) reads next
   run. Metrics with no source data yet are NULL (honest thinness), and the file is
   gitignored (regenerated, fail-safes to tier defaults on a fresh clone). If it fails, log
   and continue — the meter is telemetry, not a gate.

Return the verdict, and the provider FAMILY that produced the accepted certification in
BOTH \`provider\` and \`status\` (exactly one of ${wdChain.map(f => `"${f}"`).join(', ')}), plus \`deniedTools\`
and (when the verdict block had it) \`toolAccess\` from step 4a. Also return \`artifacts\`:
[{file, sha256}] from the accepted link's WOLFPACK_ARTIFACT_DELIVERED lines, or [] for the
claude link. If EVERY link was rate-limited, return verdict "ERROR" with status "model_quota".

SAFETY: No git push, no deploy.
${RATE_LIMIT_SIGNAL_NOTE}
${HANDOFF_SIGNAL_NOTE}
${FALLBACK_LOG_NOTE}
${heartbeat('Certify', 'Watchdog certification')}
`, { label: `watchdog:${slug}`, phase: 'Certify', schema: VERDICT_SCHEMA })

log(`Watchdog verdict: ${watchdogResult.verdict}`)

// Cross-family runtime invariant on the certifier (a real verdict only; quota ERROR is
// handled below). Unprovable → park; never let a same-family certification through.
if (watchdogResult && watchdogResult.verdict && watchdogResult.verdict !== 'ERROR') {
  const wdViolation = crossFamilyViolation(
    { provider: watchdogResult.provider || watchdogResult.status }, codeWriterFamilies, wdChain)
  if (wdViolation) {
    log(`⛔ ${slug}: Watchdog CROSS-FAMILY VIOLATION — ${wdViolation}. Parking (certification NOT accepted).`)
    await parkHunt({
      reason: 'cross_family_violation', resumePhase: 'Certify', resolutionTypeExpected: 'clarify', phaseLabel: 'Certify',
      needFromUser: `Certification could not be proven cross-family: ${wdViolation}. The ${watchdogResult.verdict} verdict was NOT accepted. Resume to re-run certification (clarify), or fix the certifier plumbing (redirect).`,
      context: `Certifier chain: ${wdChain.join(' → ')}; code writer families: ${[...codeWriterFamilies].join(', ')}; provider reported: ${watchdogResult.provider || watchdogResult.status || '(none)'}`,
    })
    return { slug, verdict: 'PARKED', status: 'parked:cross_family_violation', reason: 'cross_family_violation', tier, worktreePath }
  }
  await noteClaudeFallbackReview('watchdog', 0, watchdogResult, wdChain, 'Certify')
  await noteAuditOnly('watchdog', 0, watchdogResult, `${planDir}/certification.md`, 'Certify')
  logSeatArtifacts('watchdog', 0, watchdogResult)
}

// seat-profiles-into-pack (AC6b/c) — an Orange/Red (or unknown-tier) certification that was
// AUDIT-ONLY (denied tools, or no mandatory tool_access) cannot PASS: it never ran git diff or
// the tests. Park it with the evidence. Lighter tiers keep the PASS (recorded above).
const certEv = certAuditEvidence(watchdogResult, tier)
if (watchdogResult && watchdogResult.verdict === 'PASS' && certEv.length && HEAVY(tier)) {
  log(`⛔ ${slug}: ${tier || 'unknown-tier'} certification was AUDIT-ONLY (${certEv.slice(0, 3).join('; ')}) — PASS not accepted.`)
  await parkHunt({
    reason: 'audit_only_certification', resumePhase: 'Certify', resolutionTypeExpected: 'redirect', phaseLabel: 'Certify',
    needFromUser: `The ${tier || 'unknown-tier'} certification ran without a working shell, so it could not run git diff or the tests. Orange/Red hunts cannot certify on audit alone. Fix the seat (installer + toolcheck), then resume Certify.`,
    context: `certifier: ${watchdogResult.provider || watchdogResult.status || '(unknown)'}; evidence: ${certEv.join(' | ')}`,
  })
  return { slug, verdict: 'PARKED', status: 'parked:audit_only_certification', reason: 'audit_only_certification', tier, worktreePath }
}

// [05] AC3 — both certifiers rate-limited → PARK model_quota, NOT a non-PASS that
// masks a quota outage as a quality failure (REWORK/FLAWED_PLAN would wrongly send the
// hunt back to Shepherd/Alpha). Transient: the host driver reschedules past the window.
if (watchdogResult.verdict === 'ERROR' && isQuotaStatus(watchdogResult.status)) {
  log(`⏸ ${slug}: every certifier in the chain rate-limited (${watchdogResult.status}). Parking model_quota.`)
  await parkHunt({
    reason: 'model_quota',
    resumePhase: 'Certify',
    resolutionTypeExpected: 'clarify',
    phaseLabel: 'Certify',
    needFromUser: `Every certifier in the chain (${chainLabel(wdChain)}) is rate-limited / quota-exhausted, so certification could not run. Transient: re-run after the window resets (clarify), or redirect if you suspect the certifier plumbing.`,
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
// (compliancePaths(), from wolfpack-config.md) the hunt parks `compliance_review` for human
// sign-off BEFORE the release queue — honoring the project's compliance bar without taxing cosmetic
// hunts. Fail-closed: if path detection is uncertain, park anyway. A prior /resolve
// sign-off (park.compliance_signed_off) short-circuits the gate so resume proceeds.
if (at('Verify')) {
  const complianceGate = (await agent(`
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
   classified this hunt compliance-critical (e.g. it touches a declared compliance
   area broadly, beyond the narrow path allowlist below).
   FIRST write ${planDir}/compliance-summary.md — this hunt WILL park for sign-off and
   the park payload references this file by path, so it MUST exist (a missing summary
   here is the recurring bug this branch fixes: the spec-flag path used to STOP before
   the step-4 write). The whole diff is the compliance surface (no narrow path match), so:
   run \`git diff --stat ${BASE}..HEAD\` for the file list, then \`git diff ${BASE}..HEAD\` and
   quote the risk-bearing hunks (the hunks that touch a declared compliance area), noting each against the [compliance] criteria in
   ${planDir}/acceptance.md (if present). Keep it readable in under a minute. Do NOT
   commit it. THEN return
   { complianceTouched:true, determined:true, alreadySignedOff:false,
   touchedPaths:["spec.compliance_review_required"], summary:"Spec flagged
   compliance_review_required" } — STOP. The path allowlist in step 3 only ADDS
   to this signal; it never overrides a Spec compliance flag. (This closes the gap
   where a Spec-flagged hunt whose diff misses the narrow allowlist — e.g. a feature
   in a compliance area touching a file outside the listed risk-surface paths — certified
   without sign-off.)

2. Compute the touched files: \`git diff --name-only ${BASE}..HEAD\` (run from the
   worktree). If that fails for any reason, return determined:false (the pipeline
   fails closed and parks). Otherwise determined:true.

3. A path is COMPLIANCE-TOUCHED if it matches ANY entry of this risk-surface
   allowlist (wolfpack-config.md → Compliance Requirements → Risk-surface paths):
${compliancePaths().length ? compliancePaths().map(p => `   - ${p}`).join('\n') : '   (this project declares no risk-surface paths — nothing matches here; step 1b still applies)'}
   This is intentionally NARROW: an entry ending in / matches the whole directory
   (prefix); a file entry matches only that file. A file near a listed one that is not
   itself listed does NOT count.

4. If any touched file matches, set complianceTouched:true and write a tight
   ${planDir}/compliance-summary.md: list the matched files, quote the relevant diff
   hunks (\`git diff ${BASE}..HEAD -- <file>\`, trimmed to the risk-bearing lines), and
   note each against the [compliance] criteria in ${planDir}/acceptance.md (if present).
   Keep it readable in under a minute. Do NOT commit it.

Return { complianceTouched, determined, alreadySignedOff:false, touchedPaths (the
matched files), summary (one line) }.
${heartbeat('Certify', 'compliance-review gate: scanning touched paths')}
`, { label: `compliance-gate:${slug}`, phase: 'Certify', schema: COMPLIANCE_GATE_SCHEMA }))
    // agent() returns null when the seat dies on a terminal error (session
    // limit, skip). The comment below already promises fail-closed on a
    // malformed result — a NULL result crashed the run instead (observed
    // 2026-08-22, session-limit death at this seat). Coalesce to the
    // fail-closed shape so a dead gate PARKS for a human like any other
    // inconclusive determination.
    ?? { determined: false, complianceTouched: null, alreadySignedOff: false, touchedPaths: [] }

  // Fail closed: review unless the gate EXPLICITLY determined the diff and found no
  // compliance surface. `determined !== true` (covers false AND undefined) forces a
  // park — an inconclusive or malformed gate result never silently proceeds.
  const mustReview = complianceGate.determined !== true || complianceGate.complianceTouched === true
  if (!complianceGate.alreadySignedOff && mustReview) {
    const why = complianceGate.determined === false
      ? 'path detection was inconclusive — failing closed'
      : `touches compliance risk surfaces: ${(complianceGate.touchedPaths || []).join(', ') || 'see compliance-summary.md'}`
    if (baseBranch) {
      // AC11 chain mode: merge-and-await, no park payload. The hunt certifies, merges into the
      // campaign branch as merged_to_campaign_pending_compliance (its dependents may build on
      // it), and the sign-off moves to the campaign release. Fail-closed is preserved: an
      // inconclusive gate also lands here, so the hunt still cannot reach main unsigned
      // (compliance_hold + spec.compliance_review_required survive every later status change).
      log(`⏸ ${slug}: compliance surface (${why}) — chain mode: certified, will merge into ${baseBranch} as merged_to_campaign_pending_compliance; sign-off moves to the campaign release.`)
      await agent(`
You ONLY update metadata.json for Wolfpack hunt ${slug} — write-only bookkeeping. Do NOT plan,
review, fix, merge or commit anything.

cd to ${worktreePath}. Use absolute paths.

1. Get the timestamp: run \`date -u +%Y-%m-%dT%H:%M:%SZ\` — call it NOW.
2. Edit ${planDir}/metadata.json ${META_PRESERVE_NOTE}:
   - set top-level "status" = "certified_pending_compliance"
   - set a "compliance_hold" block:
     { "reason": ${JSON.stringify(why)}, "touched_paths": ${JSON.stringify(complianceGate.touchedPaths || [])},
       "summary": "${planDir}/compliance-summary.md", "held_at": "<NOW>" }
   - and set spec.compliance_review_required = true (create "spec" if absent; keep its other fields)
   Preserve every other field.
Do NOT write parked.md. Do NOT touch the "park" block. Do NOT commit. Do NOT push. Do NOT git add.
Return {ok:true}.
${heartbeat('Certify', 'chain mode: recording compliance hold (merge-and-await)')}
`, { label: `compliance-hold:${slug}`, phase: 'Certify', model: 'sonnet', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
      return { slug, verdict: 'CERTIFIED_PENDING_COMPLIANCE', status: 'certified_pending_compliance', reason: 'compliance_review', tier, worktreePath }
    }
    log(`⛔ ${slug}: compliance-review checkpoint (${why}). Parking compliance_review before the release queue.`)
    await parkHunt({
      reason: 'compliance_review',
      resumePhase: 'Verify',          // sign-off resumes straight into deploy/verify
      resolutionTypeExpected: 'clarify',
      phaseLabel: 'Certify',
      needFromUser: `This certified hunt's diff ${why}. Read the compliance summary and sign off (or send it back), checking it against the project's Compliance Requirements (wolfpack-config.md)${cfg().complianceAreas ? ` — declared areas: ${cfg().complianceAreas}` : ''}.`,
      context: `Compliance summary: ${planDir}/compliance-summary.md\nMatched surfaces: ${(complianceGate.touchedPaths || []).join(', ') || '(detection inconclusive — failing closed)'}\nFull diff: \`git -C ${worktreePath} diff ${BASE}..HEAD\``,
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
// A-13 chain mode: no per-hunt deploy guidance — /release-campaign deploys the campaign branch
// ONCE for the whole campaign (AC14). The certified hunt goes back to the runner, which merges it.
if (baseBranch) {
  log(`Chain mode: per-hunt dev deploy skipped — /release-campaign deploys ${baseBranch} once.`)
  return { slug, verdict: 'CERTIFIED_AWAITING_DEPLOY', tier, findings: watchdogResult?.findings, worktreePath, status: 'certified' }
}
// wolfpack-self-hosting (AC10): a project with no deploy step (wolfpack-config.md → Deployment
// Notes → Dev deploy command: none) has nothing to verify on dev. The verdict token stays
// CERTIFIED_AWAITING_DEPLOY — campaign-runner and wolfpack-release.mjs key on it.
if (!cfg().devDeployCommand) {
  log(`No deploy step: wolfpack-config.md → Deployment Notes → Dev deploy command is none — ${slug} is certified; next: /merge ${slug}.`)
  return { slug, verdict: 'CERTIFIED_AWAITING_DEPLOY', tier, findings: watchdogResult?.findings, worktreePath, status: 'certified' }
}
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

2. SURFACE THE DEPLOY COMMANDS (user-run, never by you):
   Read wolfpack-config.md → Deployment Notes. If it has a "Feature-branch deploy (Verify)" block, surface those
   commands verbatim with {worktree} → ${worktreePath} and {slug} → ${slug}. Otherwise surface the Dev deploy
   command (\`${cfg().devDeployCommand}\`) and WARN that it may deploy the main checkout, not this branch — the
   user must confirm how to deploy a feature branch. These commands are user-only (project hooks may block them).
   Do NOT attempt to run them.

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
- Do NOT run any deploy command (user-only)
- Do NOT merge to main
- Do NOT git push
${heartbeat('Verify', 'preparing deploy commands and smoke steps')}
`, { label: `verify:${slug}`, phase: 'Verify', schema: VERDICT_SCHEMA })

// agent() returns null when the seat dies on a terminal error (session limit,
// user skip). The hunt is already CERTIFIED at this point — Verify only preps
// deploy/smoke guidance — so degrade gracefully instead of crashing the run
// (observed 2026-08-20: session-limit death at the verify seat crashed an
// otherwise-complete pipeline on this exact dereference).
if (verifyResult == null) {
  log(`Verification seat died (limit/skip) — hunt is certified; deploy/smoke guidance not generated.`)
} else {
  log(`Verification phase: ${verifyResult.verdict}`)
}
log(`Pipeline complete for ${slug}. Awaiting user deploy + smoke + /merge.`)

return {
  slug,
  verdict: 'CERTIFIED_AWAITING_DEPLOY',
  tier,
  findings: watchdogResult?.findings,
  worktreePath,
  status: verifyResult?.status ?? 'awaiting_user_deploy',
}
