# Wolfpack Project Configuration

Copy this file to your project root as `wolfpack-config.md` and fill in your project-specific details. Every Wolfpack role reads this file to adapt the pipeline to your codebase.

---

## Project Identity

- **Name:** My Project
- **Language/Framework:** Python/Django, TypeScript/Next.js, Go, etc.
- **Repo root:** (auto-detected from git)
- **Test command:** `./scripts/run_tests.sh` or `npm test` or `go test ./...`
- **Deploy command (dev):** `deploy-dev` or `npm run deploy:staging` or `kubectl apply -f ...`
- **Deploy command (prod):** USER ONLY — describe the process here so agents know not to run it

## Hard Rules (agents will be fired for violating these)

List your project's non-negotiable rules. These are enforced by every pipeline phase.

```markdown
1. Never deploy to production. Agents may deploy to dev/staging only.
2. Never `git add .` or `git add -A`. Stage files by name only.
3. (Add your project-specific hard rules here)
```

## Compliance Requirements (if any)

Describe regulatory or compliance constraints that affect code review and testing. Leave empty if none apply.

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

## Model Pool Preferences

Customize which models are available and any project-specific routing rules.

```markdown
### Fixed assignments
- Alpha: claude:opus:high (always)
- Tracker: claude:opus:high (always — test writing needs the strongest model)

### Pool (available for pedigree-driven selection)
- Opus, Sonnet, Gemini, Mistral

### Overrides
- (e.g., Red tier / compliance hunts: always Opus for Shepherd)
- (e.g., Bloodhound: prefer Mistral for cross-model from Opus Alpha)
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

## Existing Patterns

Point agents to canonical implementations they should mirror when adding new features.

```markdown
- Modal pattern: (e.g., see `components/AddUserModal.tsx` for the standard modal structure)
- List view pattern: (e.g., see `views/CustomerListView.py` for sortable/filterable lists)
- API endpoint pattern: (e.g., see `api/invoices.py` for standard CRUD ViewSet)
- Test pattern: (e.g., see `tests/test_billing.py` for the standard test structure)
```
