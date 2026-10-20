# Wolfpack Pedigree Index

| Date | Feature | Tier | Shepherd | Pointer | Tracker | Verdict | Adherence | Quality | Judgment | Test | CodeRev | TestAuth | PtrVal | TrkVal | CycleEff | Rework | PtrRnd | TrkRnd | Human | Notes |
|------|---------|------|----------|---------|---------|---------|-----------|---------|----------|------|---------|----------|--------|--------|----------|--------|--------|--------|-------|-------|
| 2026-10-20 | seat-handoff-writes | Orange | claude | glm | claude | PASS | 5 | 5 | 5 | 5 | 4 | 5 | 4 | 4 | 2 | 0 | 2 | 1 | 1 | Mount-confined seat handoff: shim delivers byte-for-byte or exit 78; 6 review rounds (coupled-test inventory), all findings closed; host-run suite 31/31; duration 3h 51m 18s |
| 2026-10-20 | pack-install-model | Orange | claude | glm | claude | PASS | 5 | 4 | 5 | 4 | 4 | 5 | 3 | 4 | 4 | 0 | 1 | 0 | 1 | One install.sh + content-stamped workflow copies + worktree root from config; resumed after seat-handoff-writes rebase (4 conflicts pinned by tests); certified by GLM seat (no node in seat) + shim host re-run 32/32; 2 Pointer LOWs open; duration 4h 13m 53s |
