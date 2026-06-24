#!/usr/bin/env bash
# REFERENCE — ported from PawPIMS; slated for DevDen reimplementation. NOT fully genericized. See DEVDEN-ARCHITECTURE.md section 14.
# scripts/wolfpack-run-local.sh — model-agnostic local Wolfpack orchestrator.
# Drives the 6-phase pipeline without a Claude subscription.
# Uses `agy` for remote Claude/Gemini models and `vibe` for local models.
# Integrates with the `wolfpack-models` script to load/evict local models on-demand.
# Compliance-aware: forces remote Claude/Gemini for sensitive veterinary areas.
#
# Usage:
#   ./scripts/wolfpack-run-local.sh <feature-slug> [phase_override]
#
# Examples:
#   ./scripts/wolfpack-run-local.sh feat/add-billing-field
#   ./scripts/wolfpack-run-local.sh feat/add-billing-field alpha

set -euo pipefail

SLUG="${1:?Usage: wolfpack-run-local.sh <feature-slug> [phase_override]}"
PHASE_OVERRIDE="${2:-}"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
WM_BIN="$HOME/Projects/local-llm/bin/wolfpack-models"

# ─── 1. Locate Metadata and Worktree ───────────────────────────
PLAN_DIR=""
WORKTREE_PATH=""
METADATA_FILE=""

# Check possible locations
if [ -f "$REPO_ROOT/.wolfpack/plans/$SLUG/metadata.json" ]; then
    METADATA_FILE="$REPO_ROOT/.wolfpack/plans/$SLUG/metadata.json"
elif [ -f "$REPO_ROOT/.agents/worktrees/$SLUG/.wolfpack/plans/$SLUG/metadata.json" ]; then
    METADATA_FILE="$REPO_ROOT/.agents/worktrees/$SLUG/.wolfpack/plans/$SLUG/metadata.json"
else
    # Search git worktree list
    WT_LINE=$(git worktree list | grep -F "feat/$SLUG" || true)
    if [ -n "$WT_LINE" ]; then
        WT_PATH=$(echo "$WT_LINE" | awk '{print $1}')
        if [ -f "$WT_PATH/.wolfpack/plans/$SLUG/metadata.json" ]; then
            METADATA_FILE="$WT_PATH/.wolfpack/plans/$SLUG/metadata.json"
        fi
    fi
fi

if [ -z "$METADATA_FILE" ] || [ ! -f "$METADATA_FILE" ]; then
    echo "ERROR: metadata.json for feature '$SLUG' not found." >&2
    echo "Please scaffold the hunt first via '/hunt $SLUG \"description\"' or create the directory." >&2
    exit 1
fi

PLAN_DIR=$(dirname "$METADATA_FILE")
WORKTREE_PATH=$(jq -r '.worktree_path // empty' "$METADATA_FILE")
[ -n "$WORKTREE_PATH" ] || WORKTREE_PATH="$REPO_ROOT"

echo "=========================================================="
echo ">> WOLFPACK LOCAL RUNNER: $SLUG"
echo ">> Plan Directory: $PLAN_DIR"
echo ">> Worktree Path: $WORKTREE_PATH"
echo "=========================================================="
echo

# ─── 2. Compliance and Model Settings ──────────────────────────
# Check if the feature is compliance-sensitive or high-risk
is_compliance() {
    # 1. Read metadata domain_sensitivity
    local sens
    sens=$(jq -r '.scope.domain_sensitivity // 0' "$METADATA_FILE")
    if [ "$sens" -ge 3 ]; then
        return 0
    fi
    # 2. Check if files to modify touch controlled_substances, billing/models, or records/models
    # Let's inspect git diff or modified files
    if git -C "$WORKTREE_PATH" status --short 2>/dev/null | grep -qE "controlled_substances/|billing/models\.py|records/models\.py"; then
        return 0
    fi
    return 1
}

# Resolve model for a given role
resolve_model() {
    local role="$1"
    # Read operator pins if they exist in metadata.json
    local pin
    pin=$(jq -r ".model_assignments.$role // empty" "$METADATA_FILE")
    [ -n "$pin" ] || pin=$(jq -r ".models.$role // empty" "$METADATA_FILE")
    
    if is_compliance; then
        # Force high-fidelity remote models for compliance
        case "$role" in
            alpha)      echo "Claude Opus 4.6 (Thinking)" ;;
            shepherd)   echo "Claude Sonnet 4.6 (Thinking)" ;;
            tracker)    echo "local" ;; # Tracker runs test runner on host
            *)          echo "Gemini 3.1 Pro (High)" ;; # Reviewers/Certifiers
        esac
        return 0
    fi

    # Non-compliance standard mappings
    case "$role" in
        alpha)
            # Planner: default to Gemini 3.1 Pro (High) (excellent planner, flat-rate agy)
            echo "${pin:-Gemini 3.1 Pro (High)}"
            ;;
        shepherd)
            # Implementer: default to Claude Sonnet (via agy)
            echo "${pin:-Claude Sonnet 4.6 (Thinking)}"
            ;;
        bloodhound)
            # Plan Reviewer: default to local Gemma (lobito/manada) or Gemini 3.5 Flash (via agy)
            echo "${pin:-lobito}"
            ;;
        pointer)
            # Code Reviewer: default to local Mellum or Gemma
            echo "${pin:-mellum}"
            ;;
        watchdog)
            # Certifier: default to local Mellum or Gemini 3.5 Flash
            echo "${pin:-mellum}"
            ;;
        tracker)
            echo "local"
            ;;
    esac
}

# ─── 3. LLM Execution Engine ───────────────────────────────────
# Run an agent phase
run_agent() {
    local role="$1"
    local model="$2"
    local prompt="$3"
    local output_file="$4"

    echo ">> Running role: $role using model: $model"

    # Check if the model is a local model served by llama-server
    case "$model" in
        luna|lobito|tiangou|yutu|manada|jauria|mellum|chispa)
            if [ -x "$WM_BIN" ]; then
                echo "[local] ensuring local model '$model' is loaded on host..."
                "$WM_BIN" ensure "$model" --evict
            else
                echo "WARNING: local model manager not found at $WM_BIN. Assuming server is up."
            fi
            # Run local model via vibe
            echo "[local] running vibe with $model..."
            VIBE_ACTIVE_MODEL="$model" "$REPO_ROOT/scripts/podman-vibe.sh" "wolfpack-$role" "$WORKTREE_PATH" <(echo "$prompt") 80 > "$output_file" 2>&1 || true
            ;;
        *)
            # Run remote model via agy
            echo "[remote] running agy with $model..."
            WOLFPACK_AGY_MODEL="$model" "$REPO_ROOT/scripts/podman-agy.sh" --review "$WORKTREE_PATH" <(echo "$prompt") > "$output_file" 2>&1 || true
            ;;
    esac

    # Display execution summary
    echo ">> Completed role: $role. Output written to $output_file"
}

# Extract JSON block between <verdict> tags
extract_verdict() {
    local file="$1"
    python3 -c "
import sys, re
content = open(sys.argv[1]).read()
m = re.search(r'<verdict>(.*?)</verdict>', content, re.DOTALL)
if m:
    print(m.group(1).strip())
else:
    print('{\"verdict\": \"ERROR\", \"findings\": [{\"severity\": \"CRITICAL\", \"title\": \"Missing verdict block\", \"claim\": \"LLM did not output verdict contract tags\"}]}')
" "$file"
}

# ─── 4. Phase Executors ────────────────────────────────────────
execute_spec() {
    echo "=========================================================="
    echo ">> PHASE 0: SPECIFICATION"
    echo "=========================================================="
    local model
    model=$(resolve_model "alpha")
    
    local prompt
    prompt="You are the Spec writer. Read .gemini/skills/spec/SKILL.md and execute Phase 0 (Spec) for feature $SLUG. Check acceptance criteria. Output acceptance.md and update metadata.json."
    
    local out_log="$PLAN_DIR/spec-raw.log"
    run_agent "spec" "$model" "$prompt" "$out_log"
    
    # Update status to planning
    jq '.status = "ready_for_alpha" | .phase = "plan"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
}

execute_plan() {
    echo "=========================================================="
    echo ">> PHASE 1: PLANNING (Alpha)"
    echo "=========================================================="
    local model
    model=$(resolve_model "alpha")
    
    local prompt
    prompt="You are the Alpha planner. Read .gemini/skills/alpha/SKILL.md and execute Phase 1 (Planning) for feature $SLUG. Explore the codebase and write plan.md in the plan directory."
    
    local out_log="$PLAN_DIR/plan-raw.log"
    run_agent "alpha" "$model" "$prompt" "$out_log"
    
    # Update status to reviewing
    jq '.status = "reviewing" | .phase = "review-1"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
}

execute_review() {
    local round="$1"
    echo "=========================================================="
    echo ">> PHASE 2: PLAN REVIEW (Bloodhound) - Round $round"
    echo "=========================================================="
    local model
    model=$(resolve_model "bloodhound")
    
    local prompt
    prompt="You are the Bloodhound reviewer. Read .gemini/skills/bloodhound/SKILL.md and execute Phase 2 (Adversarial Plan Review) for feature $SLUG. Read plan.md, check compliance, correctness, and multi-tenancy. You MUST output a verdict contract JSON block at the end."
    
    local out_log="$PLAN_DIR/review-raw-$round.log"
    run_agent "bloodhound" "$model" "$prompt" "$out_log"
    
    # Save the review output
    cat "$out_log" > "$PLAN_DIR/review-$round.md"
    
    local json_block
    json_block=$(extract_verdict "$out_log")
    echo "Verdict JSON block:"
    echo "$json_block"
    
    local verdict
    verdict=$(echo "$json_block" | jq -r '.verdict // "ERROR"')
    
    if [ "$verdict" = "APPROVED" ]; then
        echo ">> Bloodhound APPROVED the plan!"
        execute_debrief
    else
        echo ">> Bloodhound found ISSUES: $verdict"
        execute_revise "$round"
    fi
}

execute_revise() {
    local round="$1"
    local next_round=$((round + 1))
    echo "=========================================================="
    echo ">> PHASE 2: PLAN REVISION (Alpha) - After Round $round"
    echo "=========================================================="
    local model
    model=$(resolve_model "alpha")
    
    local prompt
    prompt="You are the Alpha planner. Read .gemini/skills/alpha/SKILL.md. Incorporate the findings from .wolfpack/plans/$SLUG/review-$round.md into a revised plan at .wolfpack/plans/$SLUG/plan-revised-$round.md."
    
    local out_log="$PLAN_DIR/revise-raw-$round.log"
    run_agent "alpha" "$model" "$prompt" "$out_log"
    
    # Copy to plan.md for next review round
    cp "$PLAN_DIR/plan-revised-$round.md" "$PLAN_DIR/plan.md"
    
    # Update status in metadata
    jq ".status = \"reviewing\" | .phase = \"review-$next_round\"" "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
}

execute_debrief() {
    echo "=========================================================="
    echo ">> PHASE 2.5: DEBRIEF"
    echo "=========================================================="
    local model
    model=$(resolve_model "alpha")
    
    local prompt
    prompt="You are the Alpha planner. Read .gemini/skills/alpha/SKILL.md. Compile debrief.md in the plan directory summarizing the plan review history, resolved points, and model assignments."
    
    local out_log="$PLAN_DIR/debrief-raw.log"
    run_agent "alpha" "$model" "$prompt" "$out_log"
    
    # Copy final plan
    cp "$PLAN_DIR/plan.md" "$PLAN_DIR/plan-final.md"
    
    # Update status to ready (awaiting user sign-off to implement)
    jq '.status = "ready" | .phase = "ready"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
    
    echo ">> Debrief written to $PLAN_DIR/debrief.md."
    echo ">> Hunt is ready! Review the plan-final.md and debrief.md."
    echo ">> Press Enter to proceed to Phase 3: IMPLEMENTATION (Shepherd)..."
    read -r _
}

execute_implement() {
    echo "=========================================================="
    echo ">> PHASE 3: IMPLEMENTATION (Shepherd)"
    echo "=========================================================="
    local model
    model=$(resolve_model "shepherd")
    
    local prompt
    prompt="You are the Shepherd. Read .gemini/skills/shepherd/SKILL.md and implement the plan for $SLUG. Write shepherd-log.md in the plan directory when done. Code only, no tests."
    
    local out_log="$PLAN_DIR/shepherd-raw.log"
    
    # Make sure we checkout/pull worktree
    # (Local run has no remote, so just check we are in worktree)
    cd "$WORKTREE_PATH"
    
    run_agent "shepherd" "$model" "$prompt" "$out_log"
    
    # Update status to code_reviewing
    jq '.status = "code_reviewing" | .phase = "code-review-1"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
}

execute_code_review() {
    local round="$1"
    echo "=========================================================="
    echo ">> PHASE 4: CODE REVIEW (Pointer) - Round $round"
    echo "=========================================================="
    local model
    model=$(resolve_model "pointer")
    
    local prompt
    prompt="You are the Pointer code reviewer. Read .gemini/skills/pointer/SKILL.md and review the code changes. Run 'git diff main..HEAD' or read the diff in the worktree. You MUST output a verdict contract JSON block at the end."
    
    local out_log="$PLAN_DIR/pointer-raw-$round.log"
    run_agent "pointer" "$model" "$prompt" "$out_log"
    
    # Save Pointer review
    cat "$out_log" > "$PLAN_DIR/pointer-review-$round.md"
    
    local json_block
    json_block=$(extract_verdict "$out_log")
    echo "Verdict JSON block:"
    echo "$json_block"
    
    local verdict
    verdict=$(echo "$json_block" | jq -r '.verdict // "ERROR"')
    
    if [ "$verdict" = "APPROVED" ]; then
        echo ">> Pointer APPROVED the code changes!"
        # Proceed to Tracker (tests)
        jq '.status = "testing" | .phase = "test"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
    else
        echo ">> Pointer rejected the code: $verdict"
        execute_code_rewrite "$round"
    fi
}

execute_code_rewrite() {
    local round="$1"
    local next_round=$((round + 1))
    echo "=========================================================="
    echo ">> PHASE 4: CODE REWRITE (Shepherd) - After Pointer Round $round"
    echo "=========================================================="
    local model
    model=$(resolve_model "shepherd")
    
    local prompt
    prompt="You are the Shepherd. Read pointer-review-$round.md in the plan directory. Address the findings in the code and update shepherd-log.md."
    
    local out_log="$PLAN_DIR/shepherd-rewrite-raw-$round.log"
    run_agent "shepherd" "$model" "$prompt" "$out_log"
    
    # Update status to code_reviewing next round
    jq ".status = \"code_reviewing\" | .phase = \"code-review-$next_round\"" "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
}

execute_tracker() {
    echo "=========================================================="
    echo ">> PHASE 5: TEST RUN (Tracker)"
    echo "=========================================================="
    echo ">> Running unit/integration tests locally in worktree..."
    
    # Run django test suite
    cd "$WORKTREE_PATH"
    
    local test_status=0
    set +e
    # Run local tests using the project's standard test script
    ./scripts/run_tests.sh --local > "$PLAN_DIR/tracker-log.md" 2>&1
    test_status=$?
    set -e
    
    cat "$PLAN_DIR/tracker-log.md"
    echo
    
    if [ $test_status -eq 0 ]; then
        echo ">> Tracker tests PASSED!"
        jq '.status = "certifying" | .phase = "certify"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
    else
        echo ">> Tracker tests FAILED! Exit code: $test_status"
        # Write test failures to tracker-report
        cat "$PLAN_DIR/tracker-log.md" > "$PLAN_DIR/tracker-report-1.md"
        execute_test_rewrite
    fi
}

execute_test_rewrite() {
    echo "=========================================================="
    echo ">> PHASE 5: TEST REWRITE (Shepherd)"
    echo "=========================================================="
    local model
    model=$(resolve_model "shepherd")
    
    local prompt
    prompt="You are the Shepherd. The test suite failed in the Tracker phase. Read the test log in .wolfpack/plans/$SLUG/tracker-report-1.md. Fix the code to make the tests pass, and update shepherd-log.md."
    
    local out_log="$PLAN_DIR/shepherd-test-rewrite-raw.log"
    run_agent "shepherd" "$model" "$prompt" "$out_log"
    
    # Reset status back to testing for another run
    jq '.status = "testing" | .phase = "test"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
}

execute_watchdog() {
    echo "=========================================================="
    echo ">> PHASE 6: CERTIFICATION (Watchdog)"
    echo "=========================================================="
    local model
    model=$(resolve_model "watchdog")
    
    local prompt
    prompt="You are the Watchdog certifier. Read .gemini/skills/watchdog/SKILL.md and certify the hunt for $SLUG. Verify code, tests, documentation, and score the pedigree. Output certification.md and pedigree.json in the plan directory."
    
    local out_log="$PLAN_DIR/watchdog-raw.log"
    run_agent "watchdog" "$model" "$prompt" "$out_log"
    
    # Verify Watchdog wrote certification
    if [ -f "$PLAN_DIR/certification.md" ]; then
        echo ">> Watchdog certification complete!"
        jq '.status = "certified" | .phase = "done"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
        echo ">> Feature $SLUG is fully certified and ready to merge!"
    else
        echo "ERROR: Watchdog failed to output certification.md. Please check the log at $out_log" >&2
        exit 1
    fi
}

# ─── 5. Main State Loop ────────────────────────────────────────
# Determine start phase
CURRENT_PHASE=$(jq -r '.phase // empty' "$METADATA_FILE")
CURRENT_STATUS=$(jq -r '.status // empty' "$METADATA_FILE")

if [ -n "$PHASE_OVERRIDE" ]; then
    CURRENT_PHASE="$PHASE_OVERRIDE"
    echo ">> Overriding start phase to: $CURRENT_PHASE"
fi

if [ -z "$CURRENT_PHASE" ]; then
    CURRENT_PHASE="spec"
fi

echo ">> Resuming pipeline from Phase: '$CURRENT_PHASE' (Status: '$CURRENT_STATUS')"
echo

# State machine loop
while :; do
    case "$CURRENT_PHASE" in
        spec)
            execute_spec
            CURRENT_PHASE="plan"
            ;;
        plan)
            execute_plan
            CURRENT_PHASE="review-1"
            ;;
        review-*)
            # Extract round number from phase
            ROUND=$(echo "$CURRENT_PHASE" | cut -d'-' -f2)
            execute_review "$ROUND"
            # Read next phase from metadata
            CURRENT_PHASE=$(jq -r '.phase' "$METADATA_FILE")
            STATUS=$(jq -r '.status' "$METADATA_FILE")
            if [ "$STATUS" = "ready" ]; then
                CURRENT_PHASE="ready"
            fi
            ;;
        ready)
            # Debrief is done, user must verify and transition to implement
            echo ">> Feature is in 'ready' state. Implementer can begin."
            jq '.status = "implementing" | .phase = "implement"' "$METADATA_FILE" > "$METADATA_FILE.tmp" && mv "$METADATA_FILE.tmp" "$METADATA_FILE"
            CURRENT_PHASE="implement"
            ;;
        implement)
            execute_implement
            CURRENT_PHASE="code-review-1"
            ;;
        code-review-*)
            ROUND=$(echo "$CURRENT_PHASE" | cut -d'-' -f3)
            execute_code_review "$ROUND"
            CURRENT_PHASE=$(jq -r '.phase' "$METADATA_FILE")
            ;;
        test)
            execute_tracker
            CURRENT_PHASE=$(jq -r '.phase' "$METADATA_FILE")
            ;;
        certify)
            execute_watchdog
            break
            ;;
        done)
            echo ">> Hunt is already done!"
            break
            ;;
        *)
            echo "ERROR: Unknown phase '$CURRENT_PHASE'" >&2
            exit 1
            ;;
    esac
done

echo ">> Wolfpack Local Runner finished successfully!"
exit 0
