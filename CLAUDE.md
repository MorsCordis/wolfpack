# Wolfpack — the pack itself (public repo)

Everything tracked here is world-readable. For pipeline runs, `wolfpack-config.md` is the authority (identity, hard rules, compliance, Model Pool, deployment notes). `README.md` and `SETUP.md` are for humans; `TODO.md` is the backlog.

## Hard rules
1. No private identifiers in any tracked file (no consuming-project names, private domains, home-directory paths, operator emails or orgs); `scripts/wolfpack-leak-grep.sh` enforces it.
2. Conventional commits (`feat|fix|test|docs|chore(scope): …`).
3. Merge with `--no-ff`; never commit to `main` directly — branch first.
4. Push to `origin` only.
5. Stage files by name — never `git add .` / `-A` / `--all`.
6. Fail loud: a missing config key, shim, script or seat is a visible error or park, never a silent default or a Claude substitution.

Tests: `bash scripts/test-all.sh` (every node and shell test plus the leak grep).
