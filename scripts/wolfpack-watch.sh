#!/usr/bin/env bash
# wolfpack-watch.sh — live Wolfpack hunt/campaign progress, harness-independent.
#
# The pipeline runs agents INSIDE worktrees, so heartbeats land in
#   .agents/worktrees/<slug>/.wolfpack/heartbeats/<slug>.json
# NOT just the main repo's .wolfpack/heartbeats/. Watching only main makes a
# busy run look dead (this is what bit us). This script DUAL-SCANS both, takes
# the newest heartbeat per hunt, and shows how long since it last advanced.
#
# The key signal: a hunt that says "working" but hasn't moved in minutes is
# STALLED — that's when to look closer / kill. "working" + fresh = healthy.
#
# Top section is the CAMPAIGN PROGRESS BAR (which wave we're on): every wave's
# state at a glance — ✓ done · ◀ running · ◐ in progress · ⏸ parked · ◻ queued —
# derived from the campaign.md wave layout + each hunt's metadata status. Below
# it, live per-hunt heartbeats with slugs tinted by tier.
#
# Modes:
#   ./scripts/wolfpack-watch.sh              one-shot snapshot
#   ./scripts/wolfpack-watch.sh --loop [N]   self-redrawing every N sec (default 5);
#                                            the sandbox launcher starts this for you
#   ./scripts/wolfpack-watch.sh --scroll [N] scrollable curses UI refreshing every N sec —
#                                            j/k or ↑/↓ scroll, PgUp/PgDn page, g/G top/bottom,
#                                            r refresh, q quit. Use this for long hunt lists.
#
# Env:
#   WOLFPACK_STALL_SECS (default 300)   — "working" older than this => STALLED.
#   WOLFPACK_HIDE_SECS  (default 21600) — heartbeats older than this (6h) are hidden as dead-run
#                                         leftovers; set 0 to show everything that ever ran.

set -uo pipefail
cd "$(dirname "$0")/.."

STALL_SECS=${WOLFPACK_STALL_SECS:-300}

render() {
  local now cstat color
  now=$(date +%s)
  # ANSI tier colors: auto on a real terminal; force with WOLFPACK_WATCH_COLOR=1 (e.g. under
  # `watch -c`, where stdout isn't a tty), or disable with =0.
  color=0; [ -t 1 ] && color=1
  case "${WOLFPACK_WATCH_COLOR:-}" in 1) color=1 ;; 0) color=0 ;; esac
  if command -v podman >/dev/null 2>&1 && \
     podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^wolfpack-pipeline$'; then
    cstat="RUNNING"
  else
    cstat="stopped"
  fi
  printf 'wolfpack-watch  %s   container=%s\n' "$(date '+%H:%M:%S')" "$cstat"
  printf -- '----------------------------------------------------------------------\n'

  now="$now" stall="$STALL_SECS" color="$color" python3 - <<'PY'
import os, json, glob

now   = int(os.environ["now"])
stall = int(os.environ["stall"])
color = os.environ.get("color") == "1"

# Hunt scale (tier) colors — the tier names ARE colors, so tint the SLUG itself by its tier
# (Green/Blue/Yellow/Orange/Red) instead of adding a column.
TIER_ANSI = {"green": "32", "blue": "34", "yellow": "33", "orange": "38;5;208", "red": "31"}
def slug_cell(slug, tier):
    cell = f"{slug:30}"                       # pad PLAIN text so columns align with/without color
    code = TIER_ANSI.get((tier or "").lower())
    return f"\033[{code}m{cell}\033[0m" if (color and code) else cell

paths = (glob.glob(".wolfpack/heartbeats/*.json")
         + glob.glob(".agents/worktrees/*/.wolfpack/heartbeats/*.json"))

best = {}  # slug -> (mtime, path)
for p in paths:
    try:
        m = os.path.getmtime(p)
    except OSError:
        continue
    slug = os.path.basename(p)[:-5]
    if slug not in best or m > best[slug][0]:
        best[slug] = (m, p)

# Drop heartbeats from dead/old runs. A merged hunt leaves its main-repo heartbeat behind
# FOREVER (nothing prunes .wolfpack/heartbeats/ after /merge), so without this the watcher
# accumulates every hunt that ever ran — 20+ stale rows from past campaigns. Anything not
# touched within HIDE_SECS is not part of a live run. Tunable; 0 disables the cutoff.
HIDE_SECS = int(os.environ.get("WOLFPACK_HIDE_SECS", "21600"))  # 6h
if HIDE_SECS > 0:
    best = {s: (m, p) for s, (m, p) in best.items() if (now - m) <= HIDE_SECS}

# ── Campaign progress bar ──────────────────────────────────────────
# "which wave are we on" — shows every wave's state at a glance, even between
# waves when nothing is churning. `wave` is NOT stored per-hunt, and metadata's
# `campaign` is sometimes null, so we map slug→campaign + slug→wave by scanning
# the campaign.md files (the authoritative wave layout).
import re

def read_meta(slug):
    for cand in (sorted(glob.glob(f".agents/worktrees/{slug}/.wolfpack/plans/{slug}/metadata.json"))
                 + [f".wolfpack/plans/{slug}/metadata.json"]):
        try:
            return json.load(open(cand))
        except Exception:
            continue
    return {}

hb_agent = {}
for s, (m, p) in best.items():
    try:
        hb_agent[s] = json.load(open(p)).get("agent", "?")
    except Exception:
        hb_agent[s] = "?"
active_slugs = {s for s, a in hb_agent.items() if a == "working"}

def scan_campaigns():
    out, slug2camp, slug2tier, slug2wave = {}, {}, {}, {}
    for path in glob.glob(".wolfpack/campaigns/*/campaign.md"):
        camp = path.split("/")[2]
        try:
            lines = open(path).read().splitlines()
        except Exception:
            continue
        waves, cur = {}, None
        for ln in lines:
            mh = re.match(r"^###\s+\d+\.\s+([A-Za-z0-9._-]+)", ln)
            if mh:
                cur = mh.group(1); slug2camp.setdefault(cur, camp); continue
            mt = re.search(r"\*\*Tier:\*\*\s*([A-Za-z]+)", ln)  # declared tier (precedes Wave)
            if mt and cur:
                slug2tier.setdefault(cur, mt.group(1))
            mw = re.search(r"\*\*Wave:\*\*\s*(\d+|BLOCKED)", ln)
            if mw and cur:
                if mw.group(1) != "BLOCKED":
                    w = int(mw.group(1)); waves.setdefault(w, [])
                    if cur not in waves[w]:
                        waves[w].append(cur)
                    slug2wave[cur] = w
                cur = None
        out[camp] = sorted(waves.items())
    return out, slug2camp, slug2tier, slug2wave

campaigns, slug2camp, slug2tier, slug2wave = scan_campaigns()

# The "current wave" = the wave of the most-recently-active hunt. A done/certified hunt is
# only hidden if it's in a wave BELOW this — prior, already-released work. A current-wave hunt
# that just certified (awaiting merge) stays on the list instead of falling off.
current_wave = None
if best:
    _newest = max(best.items(), key=lambda kv: kv[1][0])[0]
    current_wave = slug2wave.get(_newest)
cur_campaign = os.environ.get("WOLFPACK_CAMPAIGN", "").strip()
if not cur_campaign and best:
    newest = max(best.items(), key=lambda kv: kv[1][0])[0]
    cur_campaign = slug2camp.get(newest) or (read_meta(newest).get("campaign", "") or "")
if not cur_campaign and campaigns:
    cur_campaign = max(glob.glob(".wolfpack/campaigns/*/campaign.md"),
                       key=os.path.getmtime).split("/")[2]

DONE = {"merged", "certified", "certified_not_merged"}
GLYPH_ANSI = {"✓": "32", "◀": "33", "◐": "36", "⏸": "35", "◻": "2"}  # 2 = dim
def tint(s, code):
    return f"\033[{code}m{s}\033[0m" if (color and code) else s

def wave_cell(wn, slugs):
    n = len(slugs); done = started = parked = 0; active = False
    for s in slugs:
        st = read_meta(s).get("status", "")
        if s in active_slugs: active = True
        if st in DONE: done += 1
        elif st == "needs_spec" or st.startswith("parked:"): parked += 1
        elif st and st != "not_scaffolded": started += 1
    if active:            g, frac = "◀", f"{done}/{n}"
    elif done == n:       g, frac = "✓", ""
    elif done or started: g, frac = "◐", f"{done}/{n}"
    elif parked:          g, frac = "⏸", f"{parked}/{n}"
    else:                 g, frac = "◻", ""
    return tint(f"Wave {wn} {g}" + (f" {frac}" if frac else ""), GLYPH_ANSI.get(g))

waves = campaigns.get(cur_campaign, [])
if cur_campaign and waves:
    print(f"  campaign {cur_campaign}")
    print("  " + "  ·  ".join(wave_cell(wn, sl) for wn, sl in waves))
    print("  legend: ✓ done · ◀ running · ◐ in progress · ⏸ parked · ◻ queued")
    print("  " + "-" * 68)

if not best:
    print("  (no heartbeats found — nothing has run yet)")
    raise SystemExit

def ago(s):
    s = int(s)
    if s < 90:   return f"{s}s"
    if s < 5400: return f"{s//60}m"
    return f"{s//3600}h{(s%3600)//60:02d}m"

# Which role owns each phase — used to resolve the active model from the hunt's
# metadata.json model_assignments. (Heartbeats don't carry the model themselves.)
PHASE_ROLE = {"Plan": "alpha", "Debrief": "alpha", "Review": "bloodhound",
              "Implement": "shepherd", "Code Review": "pointer",
              "Test": "tracker", "Certify": "watchdog"}

def meta_for(slug, phase, detail):
    # Robust metadata lookup via read_meta (worktree-first) regardless of whether
    # the heartbeat was [wt] or [main]. The old hb_path split on "/.wolfpack/heartbeats/"
    # missed [main] heartbeats (their path has no leading slash), so tier came back "-"
    # and the slug went un-tinted. Returns (model, tier).
    meta = read_meta(slug)
    # tier: metadata first, else the campaign-declared tier (so current-wave hunts still
    # tint while parked at Spec, before Alpha writes tier into metadata).
    tier = meta.get("tier") or slug2tier.get(slug) or "-"
    ma = meta.get("model_assignments", {}) or {}
    role = PHASE_ROLE.get(phase, "")
    if phase == "Review" and "alpha" in (detail or "").lower():
        role = "alpha"        # Alpha revision rounds also live in the Review phase
    model = (ma.get(role) or "-") if role else "-"
    return model, tier

rows = []
for slug, (m, p) in best.items():
    w = slug2wave.get(slug)
    status = read_meta(slug).get("status", "")
    # "Clears after merge": a merged hunt is released — drop it from the live list immediately,
    # regardless of wave. (Certified-but-not-merged hunts stay visible — they still need action.)
    if status == "merged":
        continue
    # Hide done/certified hunts from PRIOR waves (already-released work the progress bar tallies).
    # A current-wave hunt that just certified/awaiting-merge stays visible — it shouldn't fall
    # off the list the moment it completes.
    if (status in DONE
            and current_wave is not None and w is not None and w < current_wave):
        continue
    try:
        d = json.load(open(p))
    except Exception:
        d = {}
    phase = d.get("phase", "?")
    detail = d.get("detail", "")
    model, tier = meta_for(slug, phase, detail)
    rows.append((m, slug, tier, phase, model, d.get("agent", "?"),
                 detail, "wt" if ".agents/worktrees" in p else "main"))

rows.sort(key=lambda r: -r[0])  # most-recently-active first

if not rows:
    print("  (no active hunts — committed/done hunts hidden)")

stalled = []
for m, slug, tier, phase, model, agent, detail, loc in rows:
    age = now - m
    flag = ""
    if agent == "working" and age > stall:
        flag = "  ⚠ STALLED"
        stalled.append(slug)
    elif agent == "done":
        flag = "  ✓"
    print(f"  {slug_cell(slug, tier)} {phase:10} {model:17} {agent:7} {ago(age):>6} ago [{loc}]{flag}")
    if detail:
        dd = detail if len(detail) <= 72 else detail[:71] + "…"
        print(f"      └ {dd}")

print()
if stalled:
    print(f"  ⚠  STALLED (working, >{stall//60}m no progress): {', '.join(stalled)}")
    print("     -> inspect, or stop: podman stop wolfpack-pipeline")
else:
    print("  all tracked hunts fresh or done")
PY
}

case "${1:-}" in
  --loop)
    interval="${2:-5}"
    trap 'exit 0' INT TERM
    while true; do
      [ -t 1 ] && printf '\033[H\033[2J'   # home + clear, only on a real terminal
      render
      [ -t 1 ] && printf '\n(monitor refreshes every %ss · Ctrl-C to stop the run)\n' "$interval"
      sleep "$interval"
    done
    ;;
  --scroll|-s|--interactive|-i)
    # Scrollable curses front-end. It re-invokes THIS script one-shot every interval (so all the
    # render logic above is reused verbatim, colored), captures the output, and shows it in a
    # buffer you can scroll. Background thread fetches; the UI thread stays responsive to keys.
    #
    # IMPORTANT: the curses code is written to a temp FILE and run as `python3 <file>` — NOT piped
    # via `python3 - <<EOF`. With the here-doc form, stdin IS the here-doc, so curses' getch()
    # reads keystrokes from the consumed pipe (EOF) and j/k/arrows never register. Running a file
    # leaves stdin attached to the terminal, so keys + mouse work.
    interval="${2:-5}"
    _wp_tmp="$(mktemp "${TMPDIR:-/tmp}/wolfpack-scroll.XXXXXX.py")"
    trap 'rm -f "$_wp_tmp"' EXIT
    cat > "$_wp_tmp" <<'PYCURSES'
import os, sys, re, time, threading, subprocess, curses

SELF     = os.environ["SELF"]
INTERVAL = max(1, int(os.environ.get("WOLFPACK_SCROLL_INTERVAL", "5")))

SGR_RE = re.compile(r"\033\[([0-9;]*)m")

# SGR code -> (curses color index | None, attr-or-0). 38;5;208 (orange) folds to yellow.
BASE = {"31": 1, "32": 2, "33": 4, "34": 3, "35": 5, "36": 6}  # ANSI -> our pair ids
def tokenize(line, has_colors):
    """Split a line with SGR escapes into [(text, attr)] for curses."""
    out, pos, cur = [], 0, curses.A_NORMAL
    for mobj in SGR_RE.finditer(line):
        if mobj.start() > pos:
            out.append((line[pos:mobj.start()], cur))
        codes = mobj.group(1)
        if codes in ("", "0"):
            cur = curses.A_NORMAL
        elif codes == "1":
            cur = curses.A_BOLD
        elif codes == "2":
            cur = curses.A_DIM
        elif codes.startswith("38;5;"):
            cur = (curses.color_pair(4) if has_colors else curses.A_NORMAL)  # 256-color -> yellow
        else:
            first = codes.split(";")[0]
            pid = BASE.get(first)
            cur = (curses.color_pair(pid) if (has_colors and pid) else curses.A_NORMAL)
        pos = mobj.end()
    if pos < len(line):
        out.append((line[pos:], cur))
    return out or [("", curses.A_NORMAL)]

def snapshot():
    env = dict(os.environ); env["WOLFPACK_WATCH_COLOR"] = "1"
    try:
        r = subprocess.run(["bash", SELF], capture_output=True, text=True, env=env, timeout=30)
        return (r.stdout or r.stderr or "(no output)").splitlines()
    except Exception as e:
        return [f"snapshot error: {e}"]

def main(stdscr):
    has_colors = curses.has_colors()
    if has_colors:
        curses.start_color()
        try:
            curses.use_default_colors(); bg = -1
        except curses.error:
            bg = curses.COLOR_BLACK
        for pid, col in ((1, curses.COLOR_RED), (2, curses.COLOR_GREEN), (3, curses.COLOR_BLUE),
                         (4, curses.COLOR_YELLOW), (5, curses.COLOR_MAGENTA), (6, curses.COLOR_CYAN)):
            curses.init_pair(pid, col, bg)
    curses.curs_set(0); stdscr.nodelay(True); stdscr.keypad(True)
    try:
        curses.mousemask(curses.ALL_MOUSE_EVENTS | curses.REPORT_MOUSE_POSITION)
        curses.mouseinterval(0)
    except curses.error:
        pass

    scroll = 0
    lock = threading.Lock()
    state = {"lines": ["Fetching…"], "ts": 0.0, "busy": True}
    stop = threading.Event(); kick = threading.Event()

    def fetch():
        while not stop.is_set():
            with lock: state["busy"] = True
            lines = snapshot()
            with lock:
                state["lines"] = lines; state["ts"] = time.time(); state["busy"] = False
            kick.wait(timeout=INTERVAL); kick.clear()
    t = threading.Thread(target=fetch, daemon=True); t.start()

    while True:
        h, w = stdscr.getmaxyx()
        body = max(1, h - 1)
        with lock:
            lines = list(state["lines"]); ts = state["ts"]; busy = state["busy"]
        max_scroll = max(0, len(lines) - body)
        scroll = min(scroll, max_scroll)
        stdscr.erase()
        for i in range(body):
            idx = scroll + i
            if idx >= len(lines): break
            x = 0
            for text, attr in tokenize(lines[idx], has_colors):
                if x >= w - 1: break
                text = text[:w - 1 - x]
                try: stdscr.addstr(i, x, text, attr)
                except curses.error: pass
                x += len(text)
        upd = "refreshing…" if busy else (time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "—")
        foot = f" line {scroll+1}/{max(1,len(lines))} · upd {upd} · every {INTERVAL}s · j/k ↑/↓ PgUp/Dn g/G · r refresh · q quit "
        try: stdscr.addstr(h - 1, 0, foot[:w - 1].ljust(w - 1), curses.A_REVERSE)
        except curses.error: pass
        stdscr.refresh()

        ch = stdscr.getch()
        if ch == -1:
            time.sleep(0.05); continue
        if ch in (ord('q'), ord('Q'), 27): break
        elif ch in (ord('r'), ord('R')): kick.set()
        elif ch in (curses.KEY_UP, ord('k')): scroll = max(0, scroll - 1)
        elif ch in (curses.KEY_DOWN, ord('j')): scroll = min(max_scroll, scroll + 1)
        elif ch == curses.KEY_NPAGE: scroll = min(max_scroll, scroll + body)
        elif ch == curses.KEY_PPAGE: scroll = max(0, scroll - body)
        elif ch in (curses.KEY_HOME, ord('g')): scroll = 0
        elif ch in (curses.KEY_END, ord('G')): scroll = max_scroll
        elif ch == curses.KEY_RESIZE: stdscr.clear()
        elif ch == curses.KEY_MOUSE:
            try:
                _id, mx, my, mz, bstate = curses.getmouse()
            except curses.error:
                bstate = 0
            up = getattr(curses, "BUTTON4_PRESSED", 0)
            dn = getattr(curses, "BUTTON5_PRESSED", 0)
            if up and (bstate & up):
                scroll = max(0, scroll - 3)
            elif dn and (bstate & dn):
                scroll = min(max_scroll, scroll + 3)

    stop.set(); kick.set(); t.join(timeout=1.0)

try:
    curses.wrapper(main)
except KeyboardInterrupt:
    pass
PYCURSES
    SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" \
    WOLFPACK_SCROLL_INTERVAL="$interval" \
    WOLFPACK_WATCH_COLOR="${WOLFPACK_WATCH_COLOR:-1}" \
    python3 "$_wp_tmp"
    rm -f "$_wp_tmp"; trap - EXIT
    ;;
  *)
    render
    ;;
esac
