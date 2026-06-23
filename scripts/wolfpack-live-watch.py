#!/usr/bin/env python3
# scripts/wolfpack-live-watch.py — live unified Wolfpack progress monitor.
# Combines heartbeats, active sandbox containers, agent-harness session logs, and local model servers.
# Supports continuous loop monitoring with colors and unicode progress icons.
#
# Usage:
#   python3 scripts/wolfpack-live-watch.py [--loop [interval_sec]]
#
# Example:
#   python3 scripts/wolfpack-live-watch.py --loop 2

import os
import sys
import time
import glob
import json
import re
import subprocess
import urllib.request
from pathlib import Path

# ANSI Color Codes
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    CYAN = '\033[96m'
    BOLD = '\033[1m'
    DIM = '\033[2m'
    ENDC = '\033[0m'

# Disable colors if not on a TTY or explicitly disabled
if not sys.stdout.isatty() or os.environ.get("WOLFPACK_WATCH_COLOR") == "0":
    Colors.HEADER = ""
    Colors.BLUE = ""
    Colors.GREEN = ""
    Colors.YELLOW = ""
    Colors.RED = ""
    Colors.CYAN = ""
    Colors.BOLD = ""
    Colors.DIM = ""
    Colors.ENDC = ""

REPO_ROOT = Path(__file__).parent.parent.resolve()
WM_BIN = Path.home() / "Projects" / "local-llm" / "bin" / "wolfpack-models"

# ─── 1. Active Hunt Heartbeats ─────────────────────────────────
PHASE_ROLE = {
    "Spec": "alpha",
    "Plan": "alpha",
    "Debrief": "alpha",
    "Review": "bloodhound",
    "Implement": "shepherd",
    "Code Review": "pointer",
    "Test": "tracker",
    "Certify": "watchdog"
}

def read_meta(slug):
    # Scan worktrees first, then main repo
    candidates = sorted(glob.glob(f"{REPO_ROOT}/.agents/worktrees/{slug}/.wolfpack/plans/{slug}/metadata.json")) \
                 + [f"{REPO_ROOT}/.wolfpack/plans/{slug}/metadata.json"]
    for cand in candidates:
        try:
            with open(cand, 'r') as f:
                return json.load(f)
        except Exception:
            continue
    return {}

def get_hunts_status():
    paths = glob.glob(f"{REPO_ROOT}/.wolfpack/heartbeats/*.json") \
            + glob.glob(f"{REPO_ROOT}/.agents/worktrees/*/.wolfpack/heartbeats/*.json")
    
    best = {}  # slug -> (mtime, path)
    for p in paths:
        try:
            m = os.path.getmtime(p)
            slug = os.path.basename(p)[:-5]
            if slug not in best or m > best[slug][0]:
                best[slug] = (m, p)
        except OSError:
            continue
            
    rows = []
    now = int(time.time())
    for slug, (m, p) in best.items():
        try:
            with open(p, 'r') as f:
                d = json.load(f)
        except Exception:
            d = {}
            
        status = read_meta(slug).get("status", "")
        # Skip done hunts if they are old
        if status in ("merged", "certified") and (now - m) > 1800:
            continue
            
        phase = d.get("phase", "?")
        detail = d.get("detail", "")
        
        # Resolve active model for current phase
        meta = read_meta(slug)
        tier = meta.get("tier", "-")
        ma = meta.get("model_assignments", {}) or {}
        role = PHASE_ROLE.get(phase, "")
        if phase == "Review" and "alpha" in detail.lower():
            role = "alpha"
        model = ma.get(role) or meta.get("models", {}).get(role) or "-"
        
        loc = "wt" if ".agents/worktrees" in p else "main"
        rows.append({
            "slug": slug,
            "tier": tier,
            "phase": phase,
            "model": model,
            "agent": d.get("agent", "?"),
            "detail": detail,
            "loc": loc,
            "age": now - int(m)
        })
    # Sort by mtime (most recent first)
    rows.sort(key=lambda x: -x["age"])
    return rows

# ─── 2. Running Sandbox Containers ─────────────────────────────
def get_running_containers():
    try:
        out = subprocess.run(
            ["podman", "ps", "--format", "json"],
            capture_output=True, text=True, check=True
        )
        if not out.stdout.strip():
            return []
        data = json.loads(out.stdout)
        containers = []
        for c in data:
            names = c.get("Names", c.get("Name", ""))
            name = names[0] if isinstance(names, list) and names else names
            # TODO(de-fracture): the extra sandbox container-name token is project-specific.
            # Parameterize additional container name filters via wolfpack-config.md.
            if "wolfpack" in name:
                containers.append(c)
        return containers
    except Exception:
        return []

def get_container_harness_log(container_name):
    # Query the agent harness's internal session logs inside the container's tmpfs.
    # TODO(de-fracture): the log path (~/.vibe/logs/session/*/messages.jsonl) and its
    # JSONL schema are specific to one agent harness. Parameterize the harness log
    # location + record shape via wolfpack-config.md.
    script = """
import json, glob, os, sys
paths = glob.glob(os.path.expanduser("~/.vibe/logs/session/*/messages.jsonl"))
if not paths:
    sys.exit(0)
paths.sort(key=os.path.getmtime)
latest_path = paths[-1]
events = []
with open(latest_path) as f:
    for line in f:
        try:
            data = json.loads(line)
            role = data.get("role")
            if role == "user":
                prompt = data.get("content") or ""
                prompt_clean = prompt.strip().replace("\\n", " ")
                events.append(f"👤 User: {prompt_clean[:70]}...")
            elif role == "assistant":
                text = data.get("content") or ""
                if text.strip():
                    text_clean = text.strip().replace("\\n", " ")
                    events.append(f"💬 Assistant: {text_clean[:70]}...")
                tcalls = data.get("tool_calls")
                if tcalls:
                    for tc in tcalls:
                        func = tc.get("function", {})
                        tname = func.get("name", "?")
                        targs = func.get("arguments", "{}")
                        try:
                            args_dict = json.loads(targs)
                        except:
                            args_dict = {}
                        arg_summary = args_dict.get("command") or args_dict.get("file_path") or args_dict.get("pattern") or ""
                        events.append(f"🔧 Call {tname}: {arg_summary[:60]}")
            elif role == "tool":
                tname = data.get("name", "?")
                is_err = data.get("is_error", False)
                status = "❌ Failed" if is_err else "✅ Success"
                events.append(f"🛠️ Result {tname}: {status}")
        except Exception:
            pass
for ev in events[-4:]:
    print(ev)
"""
    try:
        out = subprocess.run(
            ["podman", "exec", container_name, "python3", "-c", script],
            capture_output=True, text=True, timeout=3
        )
        return out.stdout.strip()
    except Exception:
        return ""

# ─── 3. Local Model Servers Status ─────────────────────────────
def get_local_models_status():
    if not WM_BIN.is_file():
        # Fallback: check standard ports directly via HTTP
        status_lines = []
        ports = {"luna": 8080, "lobito": 8081, "yutu": 8082, "tiangou": 8083, "manada": 8084, "jauria": 8085, "mellum": 8086}
        for name, port in ports.items():
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=0.5) as r:
                    data = json.loads(r.read().decode())
                    model_id = data["data"][0]["id"]
                    status_lines.append(f"  {name:8} port {port}  {Colors.GREEN}YES{Colors.ENDC}  served: {model_id}")
            except Exception:
                status_lines.append(f"  {name:8} port {port}  {Colors.DIM}-{Colors.ENDC}  offline")
        return "\n".join(status_lines), "unknown"
        
    try:
        out = subprocess.run(
            [str(WM_BIN), "status"],
            capture_output=True, text=True, check=True
        )
        # Parse output and add formatting
        lines = out.stdout.strip().splitlines()
        formatted = []
        ram_line = ""
        for line in lines:
            if line.startswith("name"):
                formatted.append(f"  {Colors.BOLD}{line}{Colors.ENDC}")
            elif "YES" in line:
                formatted.append(f"  {Colors.GREEN}{line}{Colors.ENDC}")
            elif line.startswith("resident model RAM"):
                ram_line = line
            else:
                formatted.append(f"  {Colors.DIM}{line}{Colors.ENDC}")
        return "\n".join(formatted), ram_line
    except Exception as e:
        return f"  Error reading local models: {e}", "unknown"

# ─── 4. Render Dashboard ───────────────────────────────────────
def format_time(seconds):
    if seconds < 90:
        return f"{seconds}s"
    if seconds < 5400:
        return f"{seconds//60}m"
    return f"{seconds//3600}h{(seconds%3600)//60:02d}m"

def render():
    print(f"\n{Colors.HEADER}{Colors.BOLD}=== WOLFPACK LIVE MONITOR ==={Colors.ENDC}   {time.strftime('%H:%M:%S')}")
    print(f"{Colors.DIM}----------------------------------------------------------------------{Colors.ENDC}")
    
    # 1. Hunts Section
    hunts = get_hunts_status()
    print(f"{Colors.BLUE}{Colors.BOLD}[ACTIVE HUNTS & PHASES]{Colors.ENDC}")
    if not hunts:
        print("  (no active hunts running)")
    for h in hunts:
        tier_color = Colors.BOLD
        if h["tier"].lower() == "red": tier_color += Colors.RED
        elif h["tier"].lower() == "orange": tier_color += Colors.YELLOW
        elif h["tier"].lower() == "yellow": tier_color += Colors.CYAN
        elif h["tier"].lower() == "blue": tier_color += Colors.BLUE
        elif h["tier"].lower() == "green": tier_color += Colors.GREEN
        
        status_flag = ""
        if h["agent"] == "working":
            status_flag = f" {Colors.GREEN}◀ working{Colors.ENDC}"
            if h["age"] > 300: # 5 mins stall threshold
                status_flag += f"  {Colors.RED}{Colors.BOLD}⚠ STALLED{Colors.ENDC}"
        elif h["agent"] == "done":
            status_flag = f" {Colors.GREEN}✓ done{Colors.ENDC}"
        else:
            status_flag = f" {Colors.DIM}{h['agent']}{Colors.ENDC}"
            
        print(f"  {tier_color}{h['slug']:30}{Colors.ENDC} | Phase: {Colors.BOLD}{h['phase']:11}{Colors.ENDC} | Model: {h['model']:22} | {status_flag} | {format_time(h['age'])} ago [{h['loc']}]")
        if h["detail"]:
            print(f"      └ {Colors.DIM}{h['detail']}{Colors.ENDC}")
            
    print(f"{Colors.DIM}----------------------------------------------------------------------{Colors.ENDC}")
    
    # 2. Containers Section
    containers = get_running_containers()
    print(f"{Colors.GREEN}{Colors.BOLD}[ACTIVE SANDBOX RUNTIME]{Colors.ENDC}")
    if not containers:
        print("  No active agent containers running.")
    for c in containers:
        names = c.get("Names", c.get("Name", ""))
        name = names[0] if isinstance(names, list) and names else names
        cid = c.get("ID", c.get("Id", ""))[:12]
        status = c.get("Status", c.get("State", ""))
        print(f"  Container: {Colors.BOLD}{name}{Colors.ENDC} ({cid}) | Status: {status}")
        vlog = get_container_harness_log(name)
        if vlog:
            for line in vlog.splitlines():
                print(f"    └ {Colors.YELLOW}{line}{Colors.ENDC}")
                
    print(f"{Colors.DIM}----------------------------------------------------------------------{Colors.ENDC}")
    
    # 3. Model Servers Section
    print(f"{Colors.CYAN}{Colors.BOLD}[LOCAL MODEL SERVERS (Arc 140T GPU)]{Colors.ENDC}")
    m_status, ram_line = get_local_models_status()
    print(m_status)
    if ram_line:
        print(f"  {Colors.BOLD}{ram_line}{Colors.ENDC}")
    print(f"{Colors.DIM}----------------------------------------------------------------------{Colors.ENDC}")

def main():
    mode = "once"
    interval = 3
    
    args = sys.argv[1:]
    if args:
        if args[0] in ("--loop", "-l"):
            mode = "loop"
            if len(args) > 1:
                try:
                    interval = int(args[1])
                except ValueError:
                    pass
                    
    if mode == "loop":
        try:
            while True:
                # Clear terminal screen
                sys.stdout.write("\033[H\033[2J")
                sys.stdout.flush()
                render()
                print(f"\nRefreshing every {interval}s. Press Ctrl+C to exit.")
                time.sleep(interval)
        except KeyboardInterrupt:
            print("\nExiting.")
    else:
        render()

if __name__ == "__main__":
    main()
