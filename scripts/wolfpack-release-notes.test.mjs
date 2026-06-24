// Tests for wolfpack-release-notes.mjs — run: node --test scripts/wolfpack-release-notes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChangelog, compareVersions, selectRange,
  classifyEntry, filterForAudience, postCheck,
} from './wolfpack-release-notes.mjs';

const SAMPLE = `# Changelog

## [Unreleased]

## [1.3.0] — 2026-02-01

### Added
- Clients can now book appointments online from the clinic website. <!-- hunt:online-booking -->

### Fixed
- Closed an authorization gap on the DEA Form 222 export endpoint. <!-- hunt:auth-gap -->

## [1.2.0] — 2026-01-01

### Changed
- Refactored billing into a service-layer (behavior-preserving, no migrations). <!-- hunt:billing-extract -->

### Added
- Invoices now email automatically to the client when finalized. <!-- hunt:invoice-email -->

## Tooling (unversioned — ships on merge)

- Wolfpack hunt-watcher stale-data filter. <!-- hunt:watch-filter -->
`;

// ─── parse ───────────────────────────────────────────────────────────────────
test('parse: sections classified; entries carry category + hunt', () => {
  const { sections } = parseChangelog(SAMPLE);
  const kinds = sections.map((s) => s.kind);
  assert.deepEqual(kinds, ['unreleased', 'version', 'version', 'tooling']);
  const v130 = sections.find((s) => s.version === '1.3.0');
  assert.equal(v130.date, '2026-02-01');
  assert.equal(v130.entries[0].category, 'Added');
  assert.equal(v130.entries[0].hunt, 'online-booking');
  assert.ok(!v130.entries[0].text.includes('<!--'));   // marker stripped from text
});

// ─── version compare ─────────────────────────────────────────────────────────
test('compareVersions: numeric, multi-part, prefix-stripped by caller', () => {
  assert.equal(compareVersions('1.3.0', '1.2.0'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('0.30.5', '0.30.10'), -1);
});

// ─── range selection ─────────────────────────────────────────────────────────
test('selectRange: only versions newer than prod + unreleased; tooling excluded', () => {
  const parsed = parseChangelog(SAMPLE);
  const entries = selectRange(parsed, { fromVersion: '1.2.0' });
  // 1.3.0's two entries only (1.2.0 is "on prod", tooling excluded, unreleased empty)
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.section === 'version'));
  assert.ok(!entries.some((e) => e.hunt === 'watch-filter'));   // tooling never included
  assert.ok(!entries.some((e) => e.hunt === 'invoice-email'));  // 1.2.0 already on prod
});

test('selectRange: from an older prod pulls both releases', () => {
  const parsed = parseChangelog(SAMPLE);
  const entries = selectRange(parsed, { fromVersion: '1.1.0' });
  assert.equal(entries.length, 4); // 1.3.0 (2) + 1.2.0 (2)
});

// ─── classify / filter ───────────────────────────────────────────────────────
test('classify: internal refactor marker suppresses', () => {
  const c = classifyEntry({ text: 'Refactored billing into a service-layer', category: 'Changed' });
  assert.equal(c.suppressed, true);
  assert.ok(c.reasons.some((r) => r.startsWith('internal:')));
});

test('classify: project denylist term (DEA) suppresses', () => {
  const c = classifyEntry({ text: 'Closed an authorization gap on the DEA Form 222 export', category: 'Fixed' }, { denylist: ['DEA', 'PCI'] });
  assert.equal(c.suppressed, true);
  assert.ok(c.reasons.includes('denylist:DEA'));
});

test('classify: Security category suppressed by default', () => {
  assert.equal(classifyEntry({ text: 'patched XSS', category: 'Security' }).suppressed, true);
});

test('classify: verbose Tooling/Docs categories suppressed by prefix', () => {
  assert.equal(classifyEntry({ text: 'worktree runner', category: 'Tooling (no APP_VERSION bump — hunt x)' }).suppressed, true);
  assert.equal(classifyEntry({ text: 'help index', category: 'Docs (no APP_VERSION bump — hunt y)' }).suppressed, true);
  assert.equal(classifyEntry({ text: 'invoices email', category: 'Added' }).reasons.filter((r) => r.startsWith('category')).length, 0);
});

test('classify: genuine user-facing feature passes', () => {
  const c = classifyEntry({ text: 'Clients can now book appointments online', category: 'Added' }, { denylist: ['DEA', 'PCI'] });
  assert.equal(c.suppressed, false);
  assert.equal(c.reasons.length, 0);
});

test('filterForAudience: splits a real range into included/suppressed', () => {
  const parsed = parseChangelog(SAMPLE);
  const range = selectRange(parsed, { fromVersion: '1.1.0' });
  const { included, suppressed } = filterForAudience(range, { denylist: ['DEA', 'PCI'] });
  assert.deepEqual(included.map((e) => e.hunt), ['online-booking', 'invoice-email']);
  assert.deepEqual(suppressed.map((e) => e.hunt).sort(), ['auth-gap', 'billing-extract']);
});

// ─── post-check (safety net) ─────────────────────────────────────────────────
test('postCheck: catches a leaked suppressed term, passes a clean draft', () => {
  assert.deepEqual(postCheck('We strengthened DEA reporting controls.', ['DEA', 'PCI']), ['DEA']);
  assert.deepEqual(postCheck('Online booking is here, and invoices email automatically.', ['DEA', 'PCI']), []);
});
