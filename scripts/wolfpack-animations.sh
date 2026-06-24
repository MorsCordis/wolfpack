#!/usr/bin/env bash
# scripts/wolfpack-animations.sh — All Wolfpack terminal animations
# Sourced by howl.sh. Each animation is a bash array of fixed-size heredoc frames.
#
# Conventions:
# - Every frame in an animation is the same height (lines) and width (chars)
# - Frames are cycled at ~1.5 FPS by default (adjustable via ANIM_FPS env var)
#   Slower than typical animation speed so messages are readable, not flashy.
# - Set NO_ANIMATION=1 to skip all animations (falls back to text spinner)
#
# Usage from howl.sh:
#   source scripts/wolfpack-animations.sh
#   wolfpack_animate ALPHA "planning cs-audit-trail"  # runs until wolfpack_animate_stop
#   # ... do work ...
#   wolfpack_animate_stop

# ──────────────────────────────────────────────────────────────
# ANIM_ALPHA — Wolf howling at moon (strategy forming)
# ──────────────────────────────────────────────────────────────
ANIM_ALPHA=(
'      .

    /| |\
   ( o o )    thinking...
    > ^ <
   (  _  )
    |   |'

'      o

    /| |\
   ( o o )    scouting the code...
    > ^ <
   (  _  )
    |   |'

'      O
     .  .
    /| |\
   ( ^ ^ )    planning the hunt...
    > o <
   (  _  )
    |   |'

'     ( )
    . ♪ .
    /| |\
   ( o o )    AWOOO
    >OOO<
   (  _  )
    |   |'

'      O

    /| |\
   ( - - )    writing...
    > ^ <
   (  _  )
    |   |'
)

# ──────────────────────────────────────────────────────────────
# ANIM_BLOODHOUND — Hound with magnifying glass, sniffing
# ──────────────────────────────────────────────────────────────
ANIM_BLOODHOUND=(
'            ___
      _____/o o\___ o
     /           \  \_
    /   bloodhound \  O   sniff...
   |   ___   ___    |
    \_/   \_/   \__/
     |_|   |_|'

'              ___
      _____/- -\___ o
     /           \  \
    /   bloodhound \  o    sniff sniff...
   |   ___   ___    |
    \_/   \_/   \__/
     |_|   |_|'

'                ___
      _____/o o\___
     /           \   O
    /   bloodhound \ /|\   found a scent!
   |   ___   ___    | |
    \_/   \_/   \__/
     |_|   |_|'

'            ___
      _____/> <\___
     /           \  [Q]   investigating...
    /   bloodhound \
   |   ___   ___    |
    \_/   \_/   \__/
     |_|   |_|'

'            ___
      _____/o o\___
     /           \  [Q]   checking the files...
    /   bloodhound \
   |   ___   ___    |
    \_/   \_/   \__/
     |_|   |_|'
)

# ──────────────────────────────────────────────────────────────
# ANIM_DEBATE — Alpha and Bloodhound circling, sparks flying
# ──────────────────────────────────────────────────────────────
ANIM_DEBATE=(
'
    /| |\     *   ___
   ( o o )    *  /o o\___
    > ^ <    *  |       \
   (  _  )   *   \_   __/
    Alpha       Bloodhound'

'
    /| |\    ><    ___
   ( ^ ^ )       /- -\___
    > o <    *  |       \
   (  _  )      \_   __/
    Alpha       Bloodhound'

'
    /| |\   ><!>    ___
   ( ^ ^ )       /> <\___
    >OOO<       |       \
   (  _  )       \_   __/
    debating    Bloodhound'

'
    /| |\    *    ___
   ( o o )       /o o\___
    > ^ <    ! |       \
   (  _  )   *  \_   __/
  considering  Bloodhound'

'
    /| |\          ___
   ( o o )  ~~~  /o o\___
    > ^ <       |       \
   (  _  )      \_   __/
    revising    Bloodhound'
)

# ──────────────────────────────────────────────────────────────
# ANIM_DEBRIEF — Pack gathered around campfire
# ──────────────────────────────────────────────────────────────
ANIM_DEBRIEF=(
'                  (
              (   )
               ) (
              (( )
           (((~v~)))
          _(((.^.)))_
      ~/\       ~       /\~
      o o   the pack    o o
      ^ ^  gathers...   ^ ^'

'                  (
              )   (
               ( )
              (( )
           (((~^~)))
          _(((.^.)))_
      ~/\     ~ ~    /\~
      ^ ^  debriefing o o
      o o    ...      ^ ^'

'                   (
              (   (
               ) (
              ( ))
           (((~v~)))
          _(((.^.)))_
      ~/\      ~      /\~
      o o   summarizing o o
      > <   the hunt   > <'
)

# ──────────────────────────────────────────────────────────────
# ANIM_SHEPHERD — Wolf herding code blocks
# ──────────────────────────────────────────────────────────────
ANIM_SHEPHERD=(
'                [::]  [::]  [::]

    /| |\       ->
   ( o o )     ->  herding the code
    > ^ <    ->
   (  _  )
    |   |'

'             [::]  [::]   [::]

    /| |\    ->
   ( ^ ^ )   ->    implementing...
    > o <    ->
   (  _  )
    |   |'

'           [::]    [::]      [::]

    /| |\ ->
   ( o o )  ->     testing edges...
    > ^ <    ->
   (  _  )
    |   |'

'      [::] [::]  [::]  [::]   [::]

    /| |\
   ( ^ ^ )    building the pen
    > o <
   (  _  )
    |   |'

'         [OK] [OK]  [OK]  [OK]  [OK]

    /| |\
   ( ^ ^ )    tests pass!
    > o <
   (  _  )
    |   |'
)

# ──────────────────────────────────────────────────────────────
# ANIM_WATCHDOG — Wolf at a gate, inspecting passing code
# ──────────────────────────────────────────────────────────────
ANIM_WATCHDOG=(
'     ___|___|___|___
    |   |   |   |   |
    |   |   |   |   |      [::]
    |   |_|_|_|_|   |   <- inspecting
    |  / /| |\ \    |
    | ( ( o o ) )   |
    |  \ > ^ <  /   |
    |___\______/____|'

'     ___|___|___|___
    |   |   |   |   |
    |   |   |   |   |
    |   |_|_|_|_|   |   [::]  checking plan adherence
    |  / /| |\ \    |
    | ( ( ^ ^ ) )   |
    |  \ > o <  /   |
    |___\______/____|'

'     ___|___|___|___
    |   |   |   |   |
    |   |   |   |   |
    |   |_|_|_|_|   |   [OK]  cleared the gate
    |  / /| |\ \    |
    | ( ( o o ) )   |
    |  \ > ^ <  /   |
    |___\______/____|'
)

# ──────────────────────────────────────────────────────────────
# ANIM_BUGCHASE — Wolf chases down a bug (transition animation)
# ──────────────────────────────────────────────────────────────
ANIM_BUGCHASE=(
'

    /| |\                    .
   ( o o )                  /x\    bug spotted!
    > o <                   \_/
   (  _  )
    |   |'

'
    /| |\
   ( ^ ^ )  ~~>             .
    >OOO<                  /x\
   (  _  )                 \_/
    |   |    *chase*'

'
    /| |\
   ( ^ ^ ) ~~~~~>      .
    >OOO<             /x\
   (  _  )            \_/
    |   |   the hunt is on!'

'
    /| |\
   ( ^ ^ )  ~~~~~~~~~> .
    >OOO<              x
   (  _  )            ///
    |   |    pounce!'

'
    /| |\
   ( > < )  <grrrr>
    >OOO<   [x]
   (  _  )
    |   |    got em!'

'
    /| |\
   ( ^ ^ )     ♪
    > ^ <
   (  _  )    [x] squished
    |   |'
)

# ──────────────────────────────────────────────────────────────
# ANIM_WAITING — Wolf sitting, tail wagging, waiting for user
# ──────────────────────────────────────────────────────────────
ANIM_WAITING=(
'                  ~
    /| |\
   ( o o )    waiting for the alpha...
    > ^ <
   (  _  )
    |   |'

'                    ~
    /| |\
   ( ^ ^ )    waiting for the alpha...
    > ^ <
   (  _  )
    |   |'

'                  ~
    /| |\
   ( o o )    waiting for the alpha...
    > ^ <
   (  _  )
    |   |'

'                 ~
    /| |\
   ( ^ ^ )    waiting for the alpha...
    > ^ <
   (  _  )
    |   |'
)

# ──────────────────────────────────────────────────────────────
# Static splash wolf — proper pointed ears, rendered once at phase start
# ──────────────────────────────────────────────────────────────

# Role splashes. Heredoc'd to preserve all special characters in ASCII art
# (apostrophes, backticks, backslashes, quotes).
# Each SPLASH_<ROLE> variable holds a multi-line string. Swap in better art
# anytime by updating these heredocs.

IFS= read -r -d '' SPLASH_ALPHA <<'SPLASH_EOF' || true
       /\       /\
      /  \     /  \
     /    \___/    \       A L P H A  —  planning the hunt
    |    o     o    |
     \      Y      /
      \    ___    /
       \__|   |__/
          |___|
SPLASH_EOF

# The hound has classic droopy hound ears + a magnifying glass — distinctly
# different from the pointed-eared wolves around it.
IFS= read -r -d '' SPLASH_BLOODHOUND <<'SPLASH_EOF' || true
              ___
       ___/o     o\___      [Q]   B L O O D H O U N D  —  investigating
      /                \    /
     |    bloodhound    |__/
      \________________/
      |_|            |_|
SPLASH_EOF

IFS= read -r -d '' SPLASH_SHEPHERD <<'SPLASH_EOF' || true
       /\       /\           [::]   [::]   [::]
      /  \     /  \           ↑      ↑      ↑
     /    \___/    \         S H E P H E R D  —  herding code
    |    ^     ^    |
     \      v      /
      \    ___    /
       \__|   |__/
          |___|
SPLASH_EOF

# The gate-wolf stands watch. Contributed art.
IFS= read -r -d '' SPLASH_WATCHDOG <<'SPLASH_EOF' || true
          /\
         /  \.--./\
        /    \  /  \
       /      \/    \        .--.
      /     |\_/|    \       |   | .---.
     /     / o o\     \      |   | |   | .---.
    /      /(   )\     \     |   `-'   |_|   |
   /       / \#/ \      \    |         ._____'
           |     |           `---.     |
           | | | |                |    |
         (~\ | | /~)              |    |
        __\_|| ||_/__             |    |
    ___///_//_| |_\\__\\\________.|____|

       W A T C H D O G  —  guards the gate
SPLASH_EOF

IFS= read -r -d '' SPLASH_DEBRIEF <<'SPLASH_EOF' || true
   /\    /\          /\    /\
  /  \  /  \        /  \  /  \
 /    \/    \      /    \/    \         T H E  D E B R I E F
|   o     o |      | o     o   |        the pack gathers
 \    Y    /        \    Y    /
  \  ___  /          \  ___  /                 (
   \_| |_/            \_| |_/                 ( )
                                            ((/^v^\))
                                            __pack__
SPLASH_EOF

# ──────────────────────────────────────────────────────────────
# ANIM_TERRITORY — wolf marks the tree after a successful merge+push
# ──────────────────────────────────────────────────────────────
ANIM_TERRITORY=(
'     /\
    /  \               /| |\
   / /\ \             ( o o )
  /_/  \_\             > ^ <
     ||               (  _  )
     ||                \   /\
     ||
  approaching...'

'     /\
    /  \       /| |\
   / /\ \     ( o o )
  /_/  \_\     > ^ <
     ||       (  _  )
     ||        \   /\
     ||
  sniff sniff...'

'     /\
    /  \  /| |\
   / /\ \( o o )
  /_/  \_\> ^ <
     ||  (  _  )
     ||   \  /|
     ||
  getting into position...'

'     /\
    /  \  /| |\
   / /\ \( - - )
  /_/  \_\> ^ <
     ||  (  _  )
     ||   /  |
     || /
  here it comes...'

'     /\
    /  \  /| |\ ~
   / /\ \( - - )~
  /_/ ~ \_\> ^ <
     ||  (  _  )
     ||   /  |
     || /
  ahhhhhhh...'

'     /\
    / !! \  /| |\
   / MINE \ ( ^ ^ )
  /________\ > o <
     ||     (  _  )
     ||      |   /\
     ||
  territory: marked'
)

# wolfpack_splash ROLE   — print the static wolf header for a phase
wolfpack_splash() {
  local role="$1"
  if [[ "${NO_ANIMATION:-}" == "1" ]]; then return 0; fi
  local var="SPLASH_${role}"
  local splash="${!var:-}"
  if [[ -n "$splash" ]]; then
    printf '\033[1;36m%s\033[0m\n' "$splash"
  fi
}

# ──────────────────────────────────────────────────────────────
# Animation runner
# ──────────────────────────────────────────────────────────────

# Module-level state for the animation subprocess
_WOLFPACK_ANIM_PID=""
_WOLFPACK_ANIM_STATUS_ROW=""

# wolfpack_animate ANIMATION_NAME "status text"
# Starts a background loop that cycles frames of the named animation.
# Call wolfpack_animate_stop to halt it.
wolfpack_animate() {
  local anim_name="$1"
  local status_text="${2:-}"

  if [[ "${NO_ANIMATION:-}" == "1" ]] || [[ ! -t 1 ]] || ! command -v tput >/dev/null 2>&1; then
    # Fallback: simple text spinner
    _wolfpack_spinner_start "$status_text"
    return
  fi

  local var_ref="ANIM_${anim_name}[@]"
  local -a frames=("${!var_ref}")
  if [[ ${#frames[@]} -eq 0 ]]; then
    echo "wolfpack_animate: unknown animation '$anim_name'" >&2
    return 1
  fi

  local fps="${ANIM_FPS:-2.5}"
  local delay
  delay=$(awk -v f="$fps" 'BEGIN{printf "%.3f", 1.0/f}')

  # Clear a working region (10 lines) and remember its top row
  tput civis  # hide cursor
  for i in 1 2 3 4 5 6 7 8 9 10; do echo; done
  tput cuu 10

  (
    local frame_idx=0
    local n_frames=${#frames[@]}
    local start_ts
    start_ts=$(date +%s)

    while true; do
      local frame="${frames[$((frame_idx % n_frames))]}"
      local elapsed=$(( $(date +%s) - start_ts ))

      # Save cursor, render frame, render status, restore
      tput sc
      # Clear 10 lines
      for i in 1 2 3 4 5 6 7 8 9 10; do
        tput el
        echo
      done
      tput rc
      printf "%s\n" "$frame"
      printf "    [%s] %s (elapsed %ds)\n" "$anim_name" "$status_text" "$elapsed"
      tput rc

      sleep "$delay"
      frame_idx=$((frame_idx + 1))
    done
  ) &

  _WOLFPACK_ANIM_PID=$!
  disown 2>/dev/null || true
}

wolfpack_animate_stop() {
  if [[ -n "$_WOLFPACK_ANIM_PID" ]] && kill -0 "$_WOLFPACK_ANIM_PID" 2>/dev/null; then
    kill "$_WOLFPACK_ANIM_PID" 2>/dev/null || true
    wait "$_WOLFPACK_ANIM_PID" 2>/dev/null || true
    _WOLFPACK_ANIM_PID=""
  fi
  _wolfpack_spinner_stop
  # Move past the 10-line animation region and reset cursor
  tput cnorm 2>/dev/null || true
  # Move down past the animation area so subsequent output doesn't overwrite
  for i in 1 2 3 4 5 6 7 8 9 10 11; do echo; done
}

# Fallback text spinner (used when terminal doesn't support cursor positioning)
_WOLFPACK_SPINNER_PID=""
_wolfpack_spinner_start() {
  local status_text="$1"
  (
    local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
    local i=0
    while true; do
      printf "\r  %s  %s  " "${frames[$((i % 10))]}" "$status_text"
      i=$((i + 1))
      sleep 0.15
    done
  ) &
  _WOLFPACK_SPINNER_PID=$!
  disown 2>/dev/null || true
}

_wolfpack_spinner_stop() {
  if [[ -n "$_WOLFPACK_SPINNER_PID" ]] && kill -0 "$_WOLFPACK_SPINNER_PID" 2>/dev/null; then
    kill "$_WOLFPACK_SPINNER_PID" 2>/dev/null || true
    wait "$_WOLFPACK_SPINNER_PID" 2>/dev/null || true
    _WOLFPACK_SPINNER_PID=""
    printf "\r%*s\r" 80 ""  # clear the spinner line
  fi
}

# Play a one-shot animation (not looping) — useful for bug chase transitions
# wolfpack_animate_once ANIMATION_NAME
wolfpack_animate_once() {
  local anim_name="$1"
  if [[ "${NO_ANIMATION:-}" == "1" ]] || [[ ! -t 1 ]] || ! command -v tput >/dev/null 2>&1; then
    return 0
  fi

  local var_ref="ANIM_${anim_name}[@]"
  local -a frames=("${!var_ref}")
  if [[ ${#frames[@]} -eq 0 ]]; then return 1; fi

  tput civis
  for i in 1 2 3 4 5 6 7 8 9 10; do echo; done
  tput cuu 10

  local fps="${ANIM_FPS:-2.5}"
  local delay
  delay=$(awk -v f="$fps" 'BEGIN{printf "%.3f", 1.0/f}')

  for frame in "${frames[@]}"; do
    tput sc
    for i in 1 2 3 4 5 6 7 8 9 10; do tput el; echo; done
    tput rc
    printf "%s\n" "$frame"
    tput rc
    sleep "$delay"
  done

  tput cnorm
  for i in 1 2 3 4 5 6 7 8 9 10 11; do echo; done
}

# Cleanup on any exit — kill background animation processes
wolfpack_animate_cleanup() {
  wolfpack_animate_stop
  tput cnorm 2>/dev/null || true
}
trap wolfpack_animate_cleanup EXIT INT TERM
