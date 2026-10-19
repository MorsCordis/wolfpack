# Wolfpack Project Configuration

Copy this file to your project root as `wolfpack-config.md` and fill in your project-specific details. Every Wolfpack role reads this file to adapt the pipeline to your codebase.

The pipeline itself (router, `hunt-pipeline`, `campaign-runner`) reads the machine-consumed keys through ONE deterministic reader, `scripts/wolfpack-config.mjs`. A key is a `- **Name:** value` (or `- Name: value`) bullet inside its `## Section`; the first backticked span is the value for command/file keys, and `none` means "not applicable". Validate the file with `node scripts/wolfpack-config.mjs --json` — it exits 0 when complete and names every missing key otherwise (the pipeline refuses to start on an incomplete config rather than guess). REQUIRED keys: Project Identity → **Name** and **Test command**; Compliance Requirements → **Compliance areas** and **Risk-surface paths** (either may be `none`); Model Pool → the `judgment` and `reviewer-a` lines.

---

## Project Identity

- **Name:** My Project
- **Language/Framework:** Python/Django, TypeScript/Next.js, Go, etc.
- **Repo root:** (auto-detected from git)
- **Test command:** `./scripts/run_tests.sh` or `npm test` or `go test ./...` — REQUIRED; the first backticked span is the command the pipeline runs (Tracker) and forbids Shepherd from running. Follow it with any notes on narrowing.
- **Worktree links:** (optional; backticked main-repo paths symlinked into each worktree, e.g. `.env`, or none)
- **Deploy command (dev):** `deploy-dev` or `npm run deploy:staging` or `kubectl apply -f ...`
- **Deploy command (prod):** USER ONLY — describe the process here so agents know not to run it
- **Vault root:** `~/Vault` — absolute path to the Obsidian vault that holds `project-notes/<project>/` (session notes, `/memory` project/lesson/reference notes, `/recall` search). Must NOT be inside the code repo or its parent workspace.

## Hard Rules (agents will be fired for violating these)

List your project's non-negotiable rules. These are enforced by every pipeline phase.

```markdown
1. Never deploy to production. Agents may deploy to dev/staging only.
2. Never `git add .` or `git add -A`. Stage files by name only.
3. (Add your project-specific hard rules here)
```

## Compliance Requirements (if any)

Describe regulatory or compliance constraints that affect code review and testing. The two keys below are read by the pipeline (Spec's compliance_critical call and the post-certify compliance-review gate); write `none` for each if no regulated area applies.

- **Compliance areas:** (REQUIRED — plain-language list, or `none`)
- **Risk-surface paths:** (REQUIRED — backticked paths; a trailing / = whole directory; or `none`)

Keep **Risk-surface paths** NARROW — genuinely risk-bearing modules only. A certified hunt whose diff touches one parks for human sign-off before release; a pervasive directory glob would park most hunts and turn the checkpoint into noise.

```markdown
- (e.g., HIPAA: medical records must be encrypted at rest and in transit)
- (e.g., PCI DSS: payment card data must never be stored in application code)
- (e.g., GDPR: user data deletion must be complete within 30 days of request)
- (e.g., SOC 2: all data access must be audit-logged)
```

## Code Review Checklist (Pointer uses this)

Project-specific items Pointer should check during code review, beyond the universal checks (security, performance, correctness, error handling).

```markdown
### Framework Conventions
- (e.g., All database queries must use the ORM, no raw SQL)
- (e.g., All API endpoints must have permission classes)
- (e.g., Foreign keys must always specify `on_delete` and `related_name`)

### Template / Frontend Conventions
- (e.g., No inline `<script>` blocks — use external JS files)
- (e.g., All user-facing text must go through i18n)
- (e.g., CSS must use design tokens, not hardcoded colors)

### Testing Conventions
- (e.g., Every new model/endpoint/view gets a test)
- (e.g., Use factories, not fixtures)
- (e.g., Integration tests must use a real database, not mocks)

### Error Handling
- (e.g., Business values must never silently default — fail loud)
- (e.g., User-facing errors must be non-technical)
```

## Plan Review Checklist (Bloodhound uses this)

Project-specific items Bloodhound should check during plan review.

```markdown
- (e.g., New database models must specify which schema they belong to)
- (e.g., New API endpoints must include rate limiting consideration)
- (e.g., Migrations must be backward-compatible for zero-downtime deploys)
```

## Multi-Tenancy (if applicable)

```markdown
- Architecture: (e.g., schema-per-tenant, row-level isolation, separate databases)
- Tenant context: (how tenant is determined — subdomain, header, URL path)
- Shared vs tenant data: (what lives in shared schema vs tenant schema)
- Migration command: (e.g., `python manage.py migrate_schemas` not `migrate`)
```

## Model Pool

Wolfpack is model-agnostic. The pipeline reasons about model **families** by role, not by brand:

- **judgment** — strongest reasoning family. Fixed for the planner (Alpha); used for heavy/compliance implementation and test authoring (Tracker).
- **work-horse** — cheap, high-throughput implementer family (default Shepherd on light tiers).
- **reviewer-a** — primary reviewer family + verify specialist (Watchdog).
- **reviewer-b** — secondary reviewer family (cross-family alternate), optional.
- **reviewer-c** — optional third reviewer family; slots into the examiner chain between reviewer-a and reviewer-b.
- **coder-alt** — optional non-default implementer for NON-heavy tiers (often the same family as reviewer-c — a model that can both code and review). Heavy/compliance tiers still force judgment.

Map each family onto a concrete model you have. The router (`scripts/wolfpack-routing.mjs`) reads this mapping and the pedigree history to pick a model per role per hunt. The brand names below are fill-in EXAMPLES — replace them with whatever models your harness can reach.

```markdown
### Family → model mapping (EXAMPLES — fill in your own)
- judgment    → claude:opus:high          # e.g. Opus, GPT-5, Gemini Pro
- work-horse  → claude:sonnet             # e.g. Sonnet, GPT-5-mini, a local 70B
- reviewer-a  → gemini:flash              # any family ≠ your implementers
- reviewer-b  → mistral:large             # optional second cross-family reviewer
- reviewer-c  → glm:5.3                   # optional third reviewer (chain: a → c → b)
- coder-alt   → glm:5.3                   # optional non-Claude implementer; fallback = work-horse

### Hard constraints (enforced by the router — never relax)
- Alpha is ALWAYS the judgment family (load-bearing planner).
- Reviewers (Bloodhound, Pointer, Watchdog) are NEVER an implementer family —
  adversarial review must be CROSS-FAMILY from the implementer.
- Pointer/Watchdog family ≠ Shepherd family.
- CHAIN RULE: each review seat walks the ordered examiner chain (reviewer-a → reviewer-c →
  reviewer-b, filtered by what is enabled) with the WRITER's family removed, falling to the
  next link on a rate limit; chain exhausted → park. A coder-alt Shepherd therefore removes
  its own family from the Pointer/Watchdog chains. A seat never reviews its own family's work.

### Overrides (optional)
- (e.g., Red tier / compliance hunts: force judgment family for Shepherd)
- (e.g., EXCEPTION — usage offload: when the window gate reports weekly pace > 15 points ahead
  (`metadata.usage_offload` set), the Shepherd is the coder-alt family on every tier,
  Red/Orange/compliance included; on Red or compliance-critical hunts a judgment-family final
  review pass follows the cross-family Pointer review. Reviewers still walk the chain with the
  coder-alt family removed.)
- (e.g., UI-heavy hunts: pin reviewer-a as the visual-review specialist)
```

## Deployment Notes

Information the pipeline needs about your deployment process.

```markdown
- Dev/staging URL: (e.g., https://staging.myapp.com)
- Prod URL: (e.g., https://myapp.com)
- Migration process: (e.g., migrations run automatically on deploy, or must be triggered manually)
- Pre-deploy backup: (e.g., `gcloud sql backups create ...` or N/A)
- Smoke test access: (how to reach the deployed app for manual verification)
```

`/merge` reads the following to build its hand-off. Leave a field blank and `/merge`
simply omits that step from the finishing message.

```markdown
- Dev deploy command: (e.g., `deploy-dev`, `npm run deploy:staging`, or blank if deploys are automatic)
- Migration command: (e.g., `gcloud run jobs execute migrate-dev --region us-central1 --wait`, `rails db:migrate`, or blank)
- Migration file pattern: (path fragment identifying a migration in a diff — e.g., `/migrations/`, `db/migrate/`)
- Deploy-before-migrate: (yes/no — yes if the migration runner must use the image built by the deploy)
- Changelog file: (e.g., `CHANGELOG.md`, or blank if the project keeps no changelog)
- Backlog file: (e.g., `TODO.md`, or blank)
- Tag pattern: (e.g. `v[0-9]*`)
- Dev URL / Prod URL / Never-smoke hosts: (e.g. `staging.myapp.example` / `myapp.example` / `myapp-marketing.example`; `/smoke-wave` smokes only the Dev URL, never Prod or a never-smoke host; `none` when nothing is deployed)
```

`Dev deploy command: none` tells the pipeline there is no deploy step: Verify reports the hunt
certified (next step `/merge`) and the wave-close commands skip deploy and `/smoke-wave`.

### Feature-branch deploy (Verify)

Optional. When present, the Verify phase surfaces these commands (user-run, never by an agent)
to deploy a certified FEATURE BRANCH for pre-merge smoke, with `{worktree}` → the hunt's
worktree path and `{slug}` → the hunt slug. Without it, Verify surfaces the Dev deploy command
and warns that it may deploy the main checkout instead of the branch.

```bash
cd {worktree}
VERSION=$(git describe --tags --always 2>/dev/null || echo "dev-{slug}")
./deploy.sh staging --version "$VERSION"     # your project's branch-deploy command(s)
```

**Deploy-before-migrate** exists because some deployment models pin the migration
runner to a built artifact. If the migration job runs the *previously* deployed image,
migrating first silently applies the old schema. Set `yes` and `/merge` will order the
hand-off deploy-then-migrate and refuse to offer migrations earlier.

## Module Map

`/hunt` uses this to pre-fill a hunt's `target_surface` from its description, so a
well-described hunt scaffolds without interactive scope questions. List each module
agents should recognize, with the words a human would actually use for it.

```markdown
- `billing` ← "invoice", "invoicing", "payment", "charge"
- `scheduler` ← "appointment", "calendar", "booking"
- `inventory` ← "stock", "supply"
```

Also list any non-source areas worth recognizing as a surface (e.g., `scripts/`,
`.agents/`, docs) and any feature-area names that don't map to a single directory.
The more complete this map, the fewer questions `/hunt` has to ask.

## Existing Patterns

Point agents to canonical implementations they should mirror when adding new features.

```markdown
- Modal pattern: (e.g., see `components/AddUserModal.tsx` for the standard modal structure)
- List view pattern: (e.g., see `views/CustomerListView.py` for sortable/filterable lists)
- API endpoint pattern: (e.g., see `api/invoices.py` for standard CRUD ViewSet)
- Test pattern: (e.g., see `tests/test_billing.py` for the standard test structure)
```
