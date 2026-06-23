export const meta = {
// REFERENCE — ported from PawPIMS; this orchestration layer is slated for DevDen reimplementation (deterministic Python). NOT de-PawPIMS-genericized. See wolfpack-lab/DEVDEN-ARCHITECTURE.md section 14.
  name: 'campaign-runner',
  description: 'Run all hunts in a Wolfpack campaign wave by wave',
  phases: [
    { title: 'Parse', detail: 'Read campaign.md and extract wave structure' },
    { title: 'Execute', detail: 'Run hunts wave by wave with parallel tracks' },
  ],
}

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
              },
              required: ['slug', 'description'],
            },
          },
        },
        required: ['number', 'hunts'],
      },
    },
  },
  required: ['waves'],
}

// args may arrive as an object or, when the invoker stringifies it, as a JSON
// string. Parse defensively so campaignSlug never silently resolves to undefined.
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const { campaignSlug, maxParallel } = parsedArgs
const parallelCap = maxParallel || 2

// Alternate the non-Claude cross-examiner per hunt so two parallel hunts never
// stack their reviews on the same model (which trips Mistral rate limits).
// Examiner SPREAD DEFAULT (the "runner rebalances" baseline): even-indexed hunts
// → Mistral, odd → Gemini, so parallel hunts don't both start on one provider.
// This is only a HINT now — once a hunt's Alpha runs, its pedigree-driven
// model_assignments.bloodhound OVERRIDES this per hunt (hunt-pipeline.js
// setExaminer), and the hunt then sticks with whichever examiner answers. When
// two concurrent hunts' Alphas land on the same provider anyway, the per-model
// flock cap in the shim scripts (≤2 calls at once) prevents overload. Full
// Alpha-aware cross-hunt reassignment would need post-Plan coordination — not
// done yet; the flock cap is the interim safeguard.
let huntCounter = 0
const nextCrossExaminer = () => (huntCounter++ % 2 === 0 ? 'mistral' : 'gemini')

// ─── [05] AC1 — self-imposed token-budget breaker ─────────────
// The Workflow harness `budget` global is a SHARED output-token pool across the main
// loop and every workflow; `budget.total` is the ceiling an operator set for an
// overnight run ("how much of my window I'll spend"), `budget.remaining()` what's left.
// This is the runaway guard (NOT the account rate-limit — that's the host-side window
// gate, scripts/wolfpack-window-gate.mjs). Before scaffolding each NEW hunt we check we
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
// [Fix 1] The old batch-sum breaker (budgetShortfallForBatch) retired with the batch
// scheduler. The rolling pool below reserves each in-flight hunt's full estimated cost
// (inFlightReserved) and gates a new claim on (this hunt + in-flight reserved) — same
// "two concurrent Reds can't both pass a single-hunt check then exhaust the pool"
// guarantee, now enforced per-claim instead of per-batch.

// ─── Phase: Parse Campaign ─────────────────────────────────────
phase('Parse')
log(`Parsing campaign: ${campaignSlug}`)

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
  .agents/worktrees/<slug>/.wolfpack/plans/<slug>/metadata.json FIRST if it exists (it's the
  live one during a run), else the main-repo copy .wolfpack/plans/<slug>/metadata.json — and
  return its \`status\` as-is. Meanings:
  - "merged" — stamped by /merge + /merge-wave at copy-back; the hunt shipped.
  - "certified" / "certified_not_merged" — Watchdog PASS, NOT yet merged (await /merge-wave).
  - "needs_spec" or "parked:<reason>" (parked:open_critical, parked:compliance_review,
    parked:non_convergence, parked:model_quota, …) — await a human via /resolve (except
    parked:model_quota, which auto-resumes). Pass through verbatim; do NOT drop them.
  - anything else (ready_for_alpha, reviewing, reviewed, implementing, …) — mid-pipeline, resumable.
- LEGACY FALLBACK ONLY: if an OLD hunt's status is still "certified" but feat/<slug> is gone AND
  its merge commit is on main, you MAY return "merged". New hunts are stamped "merged" directly,
  so this git inference should not normally be needed.

Return the structured wave data. Exclude BLOCKED hunts. Include done, certified, and
parked/needs_spec hunts with their verbatim status.
`, { label: 'parse-campaign', phase: 'Parse', schema: CAMPAIGN_SCHEMA })

log(`Campaign parsed: ${campaign.waves.length} waves, ${campaign.waves.reduce((n, w) => n + w.hunts.length, 0)} hunts`)

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
    const claimNext = () => {
      if (budgetPause || cursor >= independent.length) return null
      const hunt = independent[cursor]
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
      return hunt
    }

    // Each worker drains the shared queue; a finished/parked hunt immediately frees
    // the worker to claim the next one. Release the budget reserve in `finally` so a
    // thrown hunt-pipeline can't leak a reservation and wedge the breaker.
    const worker = async () => {
      for (let hunt = claimNext(); hunt; hunt = claimNext()) {
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

    const result = await workflow('hunt-pipeline', {
      slug: hunt.slug,
      description: hunt.description,
      campaign: campaignSlug,
      crossExaminer: nextCrossExaminer(),
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
    log(`These hunts CERTIFIED but are held for COMPLIANCE SIGN-OFF (DEA/NM/PCI risk surface) — they are EXCLUDED from the release queue until you sign off with /resolve:`)
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
    log(`  2. deploy-dev                                    (ONE deploy for the whole wave)`)
    log(`  3. /smoke-wave ${campaignSlug} ${wave.number}    (consolidated [auto] smoke + [manual] checklist)`)
    log(``)
    log(`If one hunt fails smoke: git revert <that hunt's merge commit> (--no-ff merges are cleanly revertible),`)
    log(`re-lay the wave tag on the post-revert commit, redeploy, re-smoke that hunt only.`)
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
