# Cron resume for an armed campaign

`scripts/wolfpack-cron-resume.sh` keeps a local chain campaign (`/run-campaign-local <slug> --chain`) running
while nobody watches. Every 15 minutes cron runs one **tick**. The tick acts only on an **armed** campaign. When
that campaign's runner has died, or stopped at the Claude usage limit, and the usage gate allows a start again, it
opens one new interactive `claude` session in tmux window `paw:runner` running
`/run-campaign-local <slug> --chain --unattended`. After 3 failed relaunches in a row it disarms itself. It
sends phone notifications (a private ntfy topic) on park, ready-for-release, waiting-on-you, a prolonged stall
and disarm. A notification never carries clinic, client or any other free text.

The script never edits your crontab and never arms a campaign on its own.

## Install (once per machine)

1. **Log directory** (the crontab redirect opens it before the script runs):
   ```
   mkdir -p ~/.cache/wolfpack
   ```
2. **Settings file** `~/.config/wolfpack/cron-resume.env` (or `$WOLFPACK_CRON_CONFIG`). `KEY=VALUE` lines,
   only `WOLFPACK_*` keys; the file is **parsed, never sourced**. Cron's `PATH` is `/usr/bin:/bin`, so the tool
   paths must be absolute:
   ```
   WOLFPACK_HOME=/abs/path/to/wolfpack
   WOLFPACK_CRON_NODE=/abs/path/to/node
   WOLFPACK_CRON_TMUX=/usr/bin/tmux        # tmux 3.2 or later (the relaunch uses new-window -e)
   WOLFPACK_CRON_CLAUDE=/abs/path/to/claude
   # optional, with their defaults:
   # WOLFPACK_CRON_PS=/bin/ps
   # WOLFPACK_CRON_TMUX_SESSION=paw
   # WOLFPACK_CRON_TMUX_WINDOW=runner
   # WOLFPACK_CRON_STALE_MINUTES=45
   # WOLFPACK_CRON_STALL_TICKS=4
   # WOLFPACK_CRON_PERMISSION_MODE=auto
   # WOLFPACK_CRON_LIMIT_RE=(usage limit|limit reached|resets [0-9])
   # WOLFPACK_CRON_LIMIT_LINES=12
   # WOLFPACK_CRON_PROC_RE=^(claude|node)$
   # WOLFPACK_CRON_LOCK_WAIT=30
   # WOLFPACK_CRON_LOG=~/.cache/wolfpack/cron-resume.log
   # WOLFPACK_CRON_SESSION_PATH=~/.local/bin:/usr/local/bin:/usr/bin:/bin
   # WOLFPACK_CRON_GATE=<WOLFPACK_HOME>/scripts/wolfpack-window-gate.mjs
   # WOLFPACK_NTFY_SERVER=https://ntfy.sh
   # WOLFPACK_NTFY_TOPIC_FILE=~/.secrets/wolfpack/ntfy-topic
   ```
   An environment variable of the same name overrides the file. A missing or non-executable tool is a loud
   failure: exit 4 and a `config_error` log line naming the key (never a silent "not armed").
3. **ntfy topic.** Pick a long random topic name (24–64 of `A-Z a-z 0-9 _ -`), subscribe to it in the ntfy phone
   app, and store it in a file only you can read. The notifier refuses a topic file that is not a regular file
   owned by you with mode exactly `600`:
   ```
   install -d -m 700 ~/.secrets/wolfpack
   ( umask 077; read -r -s -p 'topic: ' t; printf '%s\n' "$t" > ~/.secrets/wolfpack/ntfy-topic )
   ```
   The topic is never logged, never put on a command line and never shown by `status`.
4. **Check it reaches the phone:** `bash "$WOLFPACK_HOME/scripts/wolfpack-cron-resume.sh" --repo <repo> notify-test`
   (prints `sent` or `FAILED: <code>`).
5. **Crontab line:** print it, then add it yourself with `crontab -e`:
   ```
   bash "$WOLFPACK_HOME/scripts/wolfpack-cron-resume.sh" --repo <abs repo> --print-crontab
   */15 * * * * /bin/bash <pack>/scripts/wolfpack-cron-resume.sh --repo <repo> tick >> <home>/.cache/wolfpack/cron-resume.cron.log 2>&1
   ```
   The script writes its own structured lines to `WOLFPACK_CRON_LOG`; the redirect only catches stray errors.

## Arming

Arm at kickoff, from the consumer repo, any campaign you want resumed:

```
bash "$WOLFPACK_HOME/scripts/wolfpack-cron-resume.sh" arm <slug>
```

**Armed means "resume this campaign and page me about it", attended or not.** An armed campaign pages on park,
waiting-on-you, ready-for-release and disarm even while you watch; to stay quiet, do not arm (or `disarm`). For a
campaign that is not armed every runner event is a logged no-op, so an attended run of an unarmed campaign never
pages you. One campaign per repo can be armed (one runner per repo); arming a second is refused with the name of
the armed one.

The runner disarms the campaign itself at the end of a chain run: `completed` on `CAMPAIGN_READY_FOR_RELEASE`,
`waiting_on_human` when everything left waits on you (`CAMPAIGN_AWAITING_HUMAN`, `CAMPAIGN_PARKED_MAIN_CONFLICT`,
`WAVE_PAUSED_BUDGET`). A quota pause (`WAVE_PAUSED_QUOTA`) keeps it armed and tells the cron when to resume.

### Runners you start yourself

A runner outside `paw:runner` is safe while its campaign heartbeats are fresh: fresh heartbeats never relaunch.
When they go stale, the tick also scans the process table for a `/run-campaign-local <slug>` process anywhere on
the machine that started after the cron's cutoff (`max(session_ended_at, last_relaunch_at)`) and treats it as
live. Start your own runner as `claude "/run-campaign-local <slug> --chain"` (the prompt on the command line), or
inside `paw:runner`.

**Residual:** a runner started outside `paw:runner` by typing the command into an already-open `claude`
(the prompt is not in its argv) that then stays silent for `WOLFPACK_CRON_STALE_MINUTES` can be duplicated by a
relaunch. Avoid it with the command-line form above.

## Subcommands

`wolfpack-cron-resume.sh [--repo <abs>] <cmd>`; `--repo` defaults to the main checkout of the current repo.

| cmd | does |
|---|---|
| `tick` | the 15-minute tick (below) |
| `arm <slug>` | arm one campaign (fresh state, counters 0) |
| `disarm [<slug>] [--reason <code>]` | disarm (default reason `manual`); no notification |
| `status` | armed campaign, counters, last relaunch, last tick, `defer_until`, `session_ended_at` + last verdict, last notification failure, log path |
| `note-pause --campaign <s> --reset-at <iso>` | runner quota pause: the cron waits until `reset_at`; counts as progress |
| `note-exit --campaign <s> --verdict <token>` | the runner session ended (not progress) |
| `event <park\|ready-for-release\|waiting-on-you> --campaign <s> [--hunt <h>] [--status <st>] [--reason <code>]` | runner events: `park` pages once per park episode; the other two page, then disarm |
| `notify-test` | send one test notification; prints `sent` or `FAILED: <code>` |
| `--print-crontab` | print the crontab line; changes nothing |

`event` and `note-*` never block the runner: they exit 0 (a busy state lock logs `WARNING state lock busy` and
drops the write), except when the node module cannot run at all (exit 4). Usage errors exit 2.

## The tick

All state lives in `<repo>/.wolfpack/campaigns/<slug>/cron.json` (gitignored runtime state). The tick takes
`<repo>/.wolfpack/campaigns/.cron-resume.lock` with `flock -n`; a second tick at the same moment logs
`tick already running` and exits 0. Every other state writer waits for the same lock (`WOLFPACK_CRON_LOCK_WAIT`).

1. **No armed campaign** → `not armed`, exit 0. Nothing else runs (no tmux, claude, gate or notifier).
2. **Progress bookkeeping.** A campaign heartbeat newer than the last relaunch (and not seen by an earlier tick),
   or a quota pause recorded after it, is progress: the crash-loop counter, the stall counter and the park dedupe
   reset.
3. **Runner quota pause** in force (`defer_until` in the future) → `deferred`, exit 0.
4. **Liveness.** Heartbeats are read from `<repo>/.wolfpack/heartbeats/<hunt>.json` and both worktree layouts
   (`.claude/worktrees/<hunt>/…`, `.agents/worktrees/<hunt>/…`). The runner pane's process tree (a `claude` or
   `node` below the pane, even in a long tool call) and an outside `/run-campaign-local <slug>` process count as
   live processes.
   - the runner **ended** (a `note-pause` / `note-exit` after the last relaunch, no heartbeat since) and no newer
     outside runner → go to the gate (the overnight quota-stop path);
   - heartbeats (or the last relaunch) younger than `WOLFPACK_CRON_STALE_MINUTES` → `alive`, exit 0, whatever the
     window shows;
   - stale, a live process, no usage-limit text at the **bottom** of the `paw:runner` screen → `stalled (n/N)`,
     exit 0 (never killed). After `WOLFPACK_CRON_STALL_TICKS` stalled ticks the current relaunch counts as one
     failed relaunch (once per relaunch) and one `stalled` notification is sent (once per relaunch);
   - stale, an outside runner at the limit → not relaunched;
   - otherwise (no window, a dead pane, a pane with no `claude`/`node`, or the pane at the usage limit) → continue.
5. **Usage gate** `node <pack>/scripts/wolfpack-window-gate.mjs --json` (no `--tier`: the strictest start ceiling).
   `defer` → `defer reset_at=<t>` (`DEGRADED` when degraded), exit 0. An unreadable gate → `ERROR`, exit 1, no
   relaunch.
6. **Judge the previous relaunch** (once): no progress since it → one failed relaunch.
7. **Relaunch:** close the leftover `paw:runner` window, open exactly one new one in the repo root:
   `claude --permission-mode auto "/run-campaign-local <slug> --chain --unattended"` (interactive, no `-p`;
   project hooks apply). More or fewer than one `runner` window afterwards counts as a failed relaunch.

**Crash-loop guard:** 3 failed relaunches in a row → disarmed `crash_loop`, one `disarm` notification, later ticks
do nothing. With the defaults (45-minute stale threshold, 15-minute ticks) a failing relaunch is judged every
third tick.

## Notifications

POST to `<WOLFPACK_NTFY_SERVER>/<topic>` (`https://` only), 10-second timeout. The body is `key: value` lines
built from an allowlist only — `event`, `campaign`, `hunt`, `status`, `reason`, `usage`, `at` — and every value
must match a token pattern (slugs, status/reason codes, `5h <n>% · 7d <m>%[ DEGRADED]` or `unavailable`, ISO
time). A value that does not match is dropped with a `WARNING notify: dropped <key>` log line. No `parked.md`,
log, acceptance or clinic text can enter it. `parked:model_quota` parks do not page (they auto-resume).

A failed send (no or unsafe topic file, a non-`https` server, a non-2xx answer, a timeout, a network error) is a
`WARNING notify <event> failed: <code>` log line plus `last notify failure` in `status`. It never blocks the
runner or the tick. When the usage figures cannot be read the notification still goes out with
`usage: unavailable` and a WARNING.

## Unattended mode

`/run-campaign-local <slug> --chain --unattended` (chain mode only): no RESUME PLAN confirmation, no pre-spec
sweep, no `AskUserQuestion`; a permission refusal parks the hunt (`parked:permission_denied`) instead of
prompting. See `.agents/commands/run-campaign-local.md` § Unattended mode.
