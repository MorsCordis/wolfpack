#!/usr/bin/env node
// wolfpack-release-notes.mjs — deterministic engine for audience-facing release notes.
//
// Turns the engineering CHANGELOG (maintained by the pipeline: `## [x.y.z] — date`
// headings, `### Changed/Fixed`, `<!-- hunt:slug -->` markers) into a SAFE, pre-filtered
// list of customer-facing changes between the prod version and dev. A model then translates
// that short safe list into audience prose; this engine does the parts a model must NOT be
// trusted with — parsing, and the safety-critical judgment of what to SUPPRESS.
//
// WHY deterministic: a local (small) model can't be trusted to (a) parse a changelog or
// (b) decide that "fixed DEA retention bug" must never reach a customer email. Those are
// code. The model's only job is rewriting the safe bullets in the project's voice. A final
// post-check (--check) scans the drafted note for suppressed terms and fails loud — a net
// so a model slip can't leak internal/compliance/security detail into a customer artifact.
//
// Pipeline:  extract (here) → classify+filter (here) → MODEL translates → post-check (here)
//
// PURE/deterministic and testable build-only (no git, no model needed): parse functions take
// text; only the CLI touches the filesystem.

import fs from 'node:fs';

// ─── parse ────────────────────────────────────────────────────────────────────
// Splits a Keep-a-Changelog file into sections. Each `## ` heading is classified:
//   version    → `## [1.2.3] — 2026-01-01`
//   unreleased → `## [Unreleased]`
//   tooling    → `## Tooling (unversioned …)`  (never customer-facing)
//   other      → anything else (top matter etc.)
// `### X` sets the category for following `- ` bullets; `<!-- hunt:slug -->` is captured.
export function parseChangelog(text) {
  const lines = String(text).split('\n');
  const sections = [];
  let section = null, category = null, entry = null;
  const closeEntry = () => { if (entry) { section.entries.push(entry); entry = null; } };

  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      closeEntry();
      const title = h2[1].trim();
      let kind = 'other', version = null, date = null;
      const vm = /^\[([^\]]+)\]\s*(?:[—–-]\s*(.*))?$/.exec(title);
      if (vm) {
        if (/^unreleased$/i.test(vm[1])) kind = 'unreleased';
        else { kind = 'version'; version = vm[1].replace(/^v/i, ''); date = (vm[2] || '').trim() || null; }
      } else if (/^tooling\b/i.test(title)) kind = 'tooling';
      section = { title, kind, version, date, entries: [] };
      sections.push(section);
      category = null;
      continue;
    }
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) { closeEntry(); category = h3[1].trim(); continue; }

    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b && section) {
      closeEntry();
      const hunt = /<!--\s*hunt:([^\s>]+)\s*-->/.exec(line);
      entry = {
        category,
        text: b[1].replace(/<!--.*?-->/g, '').trim(),
        hunt: hunt ? hunt[1] : null,
        section: section.kind,
      };
      continue;
    }
    // wrapped continuation of a bullet (not a heading/quote/blank)
    if (entry && line.trim() && !/^#{1,6}\s/.test(line) && !/^>/.test(line)) {
      entry.text += ' ' + line.replace(/<!--.*?-->/g, '').trim();
    } else if (!line.trim()) {
      closeEntry();
    }
  }
  closeEntry();
  return { sections };
}

// ─── version compare (semver-ish; ignores pre-release suffixes) ────────────────
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ─── select the prod→dev range ────────────────────────────────────────────────
// Entries from version sections strictly newer than `fromVersion` (prod) and not beyond
// `toVersion`, plus [Unreleased]. Tooling/other sections are excluded outright.
export function selectRange({ sections }, { fromVersion = null, toVersion = null, includeUnreleased = true } = {}) {
  const out = [];
  for (const s of sections) {
    if (s.kind === 'tooling' || s.kind === 'other') continue;
    if (s.kind === 'unreleased') { if (includeUnreleased) out.push(...s.entries); continue; }
    if (s.kind === 'version') {
      if (fromVersion && compareVersions(s.version, fromVersion) <= 0) continue; // already on prod
      if (toVersion && compareVersions(s.version, toVersion) > 0) continue;        // beyond target
      out.push(...s.entries);
    }
  }
  return out;
}

// ─── classify / filter ────────────────────────────────────────────────────────
// Generic internal markers (engineering noise no customer cares about) ship as defaults.
// Project-specific compliance/security terms come from the consumer's wolfpack-config.md.
export const DEFAULT_INTERNAL_MARKERS = [
  'refactor', 'behavior-preserving', 'behaviour-preserving', 'service-layer', 'service layer',
  'thin-view', 'thin view', 'thin dispatcher', 'dispatcher', 'extracted ', 'no migrations',
  'single source of truth', 'single-source', 'n+1', 'view-agnostic',
];
// Categories never appropriate in a customer release note. Matched by PREFIX so verbose
// real-world headings like "### Tooling (no APP_VERSION bump — …)" or "### Docs (…)" match.
export const DEFAULT_SUPPRESS_CATEGORIES = ['Security', 'Tooling', 'Docs', 'Documentation', 'Chore', 'Internal'];

// Regulatory/compliance markers. A real compliance CHANGE is surfaced in its own bucket —
// never silently dropped. WHERE it's surfaced is a project policy (see wolfpack-config
// `compliance_visibility`): to the END USER when they are the regulated party (PawPIMS — the
// vet holds the DEA registration, is the SAQ merchant, owns the TCPA numbers), or to an
// internal compliance owner otherwise. Generic defaults; the project adds its own (DEA, NM
// Board, SAQ, controlled substance, …). Non-issue for projects with no regulated domain (chispa).
export const DEFAULT_COMPLIANCE_TERMS = ['compliance', 'regulatory', 'HIPAA', 'PCI', 'GDPR', 'SOC 2', 'audit trail', 'retention'];

export function classifyEntry(entry, {
  denylist = [], complianceTerms = DEFAULT_COMPLIANCE_TERMS,
  internalMarkers = DEFAULT_INTERNAL_MARKERS, suppressCategories = DEFAULT_SUPPRESS_CATEGORIES,
} = {}) {
  const reasons = [];
  let complianceHit = false;
  const hay = (entry.text || '').toLowerCase();
  if (entry.category && suppressCategories.some((c) => entry.category.toLowerCase().startsWith(c.toLowerCase()))) {
    reasons.push(`category:${entry.category.split(/[\s(]/)[0]}`);
  }
  for (const term of complianceTerms) if (term && hay.includes(term.toLowerCase())) { reasons.push(`compliance:${term}`); complianceHit = true; }
  for (const term of denylist) if (term && hay.includes(term.toLowerCase())) reasons.push(`denylist:${term}`);
  for (const m of internalMarkers) if (m && hay.includes(m.toLowerCase())) reasons.push(`internal:${m.trim()}`);
  // Distinguish a real compliance CHANGE (surface it) from a behavior-preserving refactor that
  // merely touches compliance code (an internal/category marker present → just noise).
  const internalNoise = reasons.some((r) => r.startsWith('internal:') || r.startsWith('category:'));
  const compliance = complianceHit && !internalNoise;
  return { ...entry, suppressed: reasons.length > 0, compliance, reasons };
}

export function filterForAudience(entries, config = {}) {
  const classified = entries.map((e) => classifyEntry(e, config));
  return {
    included: classified.filter((e) => !e.suppressed),
    suppressed: classified.filter((e) => e.suppressed),
    compliance: classified.filter((e) => e.compliance),   // surfaced subset — NOT dropped
  };
}

// ─── post-check (the safety net) ──────────────────────────────────────────────
// Scan a model-drafted note for any suppressed term. Non-empty result = a leak; the CLI
// exits non-zero so the note never ships uninspected.
export function postCheck(noteText, denylist = []) {
  const hay = (noteText || '').toLowerCase();
  return denylist.filter((t) => t && hay.includes(t.toLowerCase()));
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
// Extract:  node wolfpack-release-notes.mjs --from 1.2.0 [--to 1.3.0] [--changelog PATH] [--denylist PCI,DEA] [--json]
// Check:    node wolfpack-release-notes.mjs --check draft.md --denylist PCI,DEA   (exit 1 on leak)
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = { changelog: 'CHANGELOG.md', from: null, to: null, denylist: [], compliance: [], json: false, check: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--changelog') opt.changelog = args[++i];
    else if (a === '--from') opt.from = args[++i].replace(/^v/i, '');
    else if (a === '--to') opt.to = args[++i].replace(/^v/i, '');
    else if (a === '--denylist') opt.denylist = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--compliance') opt.compliance = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json') opt.json = true;
    else if (a === '--check') opt.check = args[++i];
  }

  if (opt.check) {
    // a compliance term leaking into a customer draft is the harm — check both lists
    const violations = postCheck(fs.readFileSync(opt.check, 'utf8'), [...opt.denylist, ...opt.compliance]);
    if (violations.length) {
      process.stderr.write(`FAIL: draft contains suppressed terms: ${violations.join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write('OK: no suppressed terms in draft\n');
    process.exit(0);
  }

  const parsed = parseChangelog(fs.readFileSync(opt.changelog, 'utf8'));
  const range = selectRange(parsed, { fromVersion: opt.from, toVersion: opt.to });
  const { included, suppressed, compliance } = filterForAudience(range, {
    denylist: opt.denylist, complianceTerms: opt.compliance.length ? opt.compliance : undefined,
  });

  if (opt.json) { process.stdout.write(JSON.stringify({ included, suppressed, compliance }, null, 2) + '\n'); process.exit(0); }

  process.stderr.write(`# release-notes: ${included.length} customer-facing / ${compliance.length} compliance / ${suppressed.length} suppressed (from ${opt.from || 'beginning'} to ${opt.to || 'dev'})\n`);
  process.stdout.write('## Customer-facing\n');
  if (!included.length) {
    process.stdout.write('(none — every change in this range was internal / compliance / suppressed)\n');
  } else {
    for (const e of included) process.stdout.write(`- [${e.category || '?'}] ${e.text}${e.hunt ? `  (hunt:${e.hunt})` : ''}\n`);
  }
  if (compliance.length) {
    // SURFACED, never dropped — for the compliance owner, never for customers
    process.stdout.write(`\n## ⚠ Compliance / regulatory updates — review (NOT for customers)\n`);
    for (const e of compliance) process.stdout.write(`- ${e.text}${e.hunt ? `  (hunt:${e.hunt})` : ''}\n`);
  }
  if (suppressed.length) {
    process.stderr.write(`\n# suppressed detail (${suppressed.length}):\n`);
    for (const e of suppressed) process.stderr.write(`  - ${e.reasons.join(',')}: ${e.text.slice(0, 70)}…\n`);
  }
}
