// Tests for wolfpack-pedigree.mjs — run: node --test scripts/wolfpack-pedigree.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOverall, gradeConvergence, gradeCatchRate, applyOutcome, validate, buildRecord,
} from './wolfpack-pedigree.mjs';

test('gradeConvergence: configurable floor/span calibrates for local models', () => {
  assert.equal(gradeConvergence({ rounds: 5, tier: 'Yellow' }), 0);            // frontier default annihilates a 5-round hunt
  assert.ok(gradeConvergence({ rounds: 5, tier: 'Yellow', span: 10 }) > 0.5);  // wide span → 5 rounds is par for local, not broken
  assert.equal(gradeConvergence({ rounds: 4, tier: 'Yellow', floor: 4 }), 1);  // raised floor → 4 rounds is "expected"
});

test('buildRecord: convergenceSpan flows through (slow-but-correct local hunt not zeroed)', () => {
  const r = buildRecord({ huntId: 'h', routing: { a: 'x' }, tier: 'Yellow', rounds: 5, caught: 2, convergenceSpan: 10 });
  assert.ok(r.dimensions.convergence.score > 0.5);
  assert.ok(r.overall > 0.7);   // correct + caught + slow ≠ broken
});

test('buildRecord: clean run → computed dims, geometric overall, provisional, valid', () => {
  const r = buildRecord({ huntId: 'h', tier: 'Yellow', routing: { shepherd: 'work-horse' }, rounds: 1, caught: 2, slipped: 0 });
  assert.equal(r.schema_version, 2);
  assert.equal(r.dimensions.convergence.score, 1.0);   // rounds 1 ≤ Yellow floor 1
  assert.equal(r.dimensions.catch_rate.score, 1.0);
  assert.equal(r.dimensions.convergence.source, 'computed');
  assert.equal(r.provisional, true);
  assert.equal(validate(r).ok, true);
});

test('buildRecord: rework + a slip differentiate (the anti-5/5/5 gradient)', () => {
  const r = buildRecord({ huntId: 'h', tier: 'Yellow', routing: { a: 'x' }, rounds: 3, caught: 1, slipped: 1 });
  assert.equal(r.dimensions.convergence.score, 0.5);   // 1 - (3-1)/4
  assert.equal(r.dimensions.catch_rate.score, 0.5);    // 1 of 2 caught
  assert.ok(r.overall < 1);                            // no longer a flat 5
});

test('buildRecord: compliance fail vetoes — overall null + blocked, never a stamp', () => {
  const r = buildRecord({ huntId: 'h', routing: { a: 'x' }, complianceStatus: 'fail' });
  assert.equal(r.overall, null);
  assert.equal(r.blocked_reason, 'compliance_veto');
});

test('buildRecord: revert forces correctness 0 → overall 0', () => {
  const r = buildRecord({ huntId: 'h', routing: { a: 'x' }, reverted: true, caught: 1 });
  assert.equal(r.dimensions.correctness.score, 0);
  assert.equal(r.overall, 0);
});

test('computeOverall: geometric mean of numeric dims', () => {
  const all1 = { correctness: { score: 1 }, completeness: { score: 1 }, convergence: { score: 1 }, catch_rate: { score: 1 } };
  assert.equal(computeOverall(all1).overall, 1);
  // geo mean of 0.9 and 0.4 = sqrt(0.36) = 0.6
  assert.equal(computeOverall({ correctness: { score: 0.9 }, completeness: { score: 0.4 } }).overall, 0.6);
});

test('computeOverall: a zero dimension forces overall to 0 (no trading off a failure)', () => {
  assert.equal(computeOverall({ correctness: { score: 0 }, completeness: { score: 1 } }).overall, 0);
});

test('computeOverall: compliance fail is a VETO (blocked, null overall)', () => {
  const r = computeOverall({ correctness: { score: 1 }, compliance: { status: 'fail' } });
  assert.equal(r.overall, null);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'compliance_veto');
});

test('computeOverall: compliance pass does not enter the mean', () => {
  const withPass = computeOverall({ correctness: { score: 0.8 }, compliance: { status: 'pass' } });
  const without = computeOverall({ correctness: { score: 0.8 } });
  assert.equal(withPass.overall, without.overall);
});

test('gradeCatchRate: caught vs slipped; clean run = 1.0', () => {
  assert.equal(gradeCatchRate({ caught: 2, slipped: 0 }), 1);
  assert.equal(gradeCatchRate({ caught: 1, slipped: 1 }), 0.5);
  assert.equal(gradeCatchRate({ caught: 0, slipped: 0 }), 1);
  assert.equal(gradeCatchRate({ caught: 0, slipped: 3 }), 0);
});

test('gradeConvergence: fewer rounds better, tier-aware', () => {
  assert.equal(gradeConvergence({ rounds: 0, tier: 'Green' }), 1);
  assert.equal(gradeConvergence({ rounds: 1, tier: 'Yellow' }), 1); // at floor
  assert.ok(gradeConvergence({ rounds: 3, tier: 'Yellow' }) < 1);
  assert.equal(gradeConvergence({ rounds: 99, tier: 'Yellow' }), 0);
});

test('applyOutcome: a slipped smoke finding lowers catch_rate, clears provisional, recomputes overall', () => {
  const rec = {
    schema_version: 2, hunt_id: 'h', routing: {}, provisional: true,
    dimensions: {
      correctness: { score: 1 }, completeness: { score: 1 }, convergence: { score: 1 },
      catch_rate: { score: 1, caught: 2, slipped_smoke: 0 },
    },
  };
  const after = applyOutcome(rec, { slippedSmoke: 1 });
  assert.equal(after.provisional, false);
  assert.equal(after.dimensions.catch_rate.score, 0.667); // 2/(2+1)
  assert.ok(after.overall < 1);
  assert.equal(rec.provisional, true); // input not mutated
});

test('applyOutcome: a revert zeroes correctness -> overall 0', () => {
  const rec = { schema_version: 2, hunt_id: 'h', routing: {}, dimensions: { correctness: { score: 1 }, completeness: { score: 1 } } };
  const after = applyOutcome(rec, { reverted: true });
  assert.equal(after.dimensions.correctness.score, 0);
  assert.equal(after.overall, 0);
});

test('validate: accepts a good record, rejects bad ones', () => {
  assert.equal(validate({ schema_version: 2, hunt_id: 'h', routing: {}, dimensions: {} }).ok, true);
  assert.equal(validate({ schema_version: 1, hunt_id: 'h', routing: {}, dimensions: {} }).ok, false);
  assert.equal(validate({ schema_version: 2, hunt_id: 'h', routing: {}, dimensions: { correctness: { score: 5 } } }).ok, false);
  assert.equal(validate({ schema_version: 2, hunt_id: 'h', routing: {}, dimensions: { compliance: { status: 'maybe' } } }).ok, false);
});

// ════════════════════════════════════════════════════════════════════════════
// consolidation-acceptance AC10 — `index-row`: the ONE validated writer of .wolfpack/pedigree/index.md
// rows. A pedigree.json without the Watchdog scores (or certifier_verdict) is REFUSED, naming every
// missing field; a dashed row is never written. AC9 — the merge-and-state-hygiene row carries scores.
// ════════════════════════════════════════════════════════════════════════════
import { indexRow, applyIndexRow, INDEX_SCORE_FIELDS, INDEX_COLUMNS, INDEX_VERDICTS } from './wolfpack-pedigree.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PED_CLI = join(dirname(fileURLToPath(import.meta.url)), 'wolfpack-pedigree.mjs');
const REAL_INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', '.wolfpack', 'pedigree', 'index.md');
const sc = (score) => ({ score, rationale: 'r', tags: [] });
// The Watchdog skill's pedigree.json shape.
const canonical = (over = {}) => ({
  certifier_verdict: 'pass',
  execution_scores: {
    plan_adherence: sc(5), code_quality: sc(4), implementation_judgment: sc(4), test_result: sc(5),
    code_review_quality: sc(3), test_authoring_quality: sc(4),
    rework_rounds: 1, pointer_rounds: 2, tracker_rounds: 1, human_interventions: 0,
  },
  process_value_add: { pointer_value_add: sc(4), tracker_value_add: sc(3), cycle_efficiency: sc(2) },
  notes: 'did the thing',
  ...over,
});
const META = { feature: 'h', tier: 'Yellow', model_assignments: { shepherd: 'claude:opus:high', pointer: 'glm:5.3', tracker: 'claude:opus:high' } };
const deep = (o) => JSON.parse(JSON.stringify(o));
const cellsOf = (row) => row.replace(/^\| /, '').replace(/ \|$/, '').split(' | ');
const ALL_SCORE_MISSING = [...INDEX_SCORE_FIELDS.map(([c, p]) => `${c} (${p})`), 'Rework (execution_scores.rework_rounds)'];

test('consolidation-acceptance AC10: a canonical pedigree.json → one 21-column row with numbers, matching the real index header', () => {
  const r = indexRow({ pedigree: canonical(), meta: META, date: '2026-10-21', duration: '1h 2m 3s' });
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  const cells = cellsOf(r.row);
  assert.equal(cells.length, 21);
  assert.equal(INDEX_COLUMNS.length, 21);
  assert.deepEqual(cells, ['2026-10-21', 'h', 'Yellow', 'claude', 'glm', 'claude', 'PASS',
    '5', '4', '4', '5', '3', '4', '4', '3', '2', '1', '2', '1', '0', 'did the thing; duration 1h 2m 3s']);
  // the column list IS the real index header (the row lines up with the table)
  const header = readFileSync(REAL_INDEX, 'utf8').split('\n').find((l) => l.startsWith('| Date |'));
  assert.deepEqual(cellsOf(header), INDEX_COLUMNS);
  // bare numbers are accepted as well as {score}
  const bare = deep(canonical());
  bare.execution_scores.plan_adherence = 3;
  assert.equal(cellsOf(indexRow({ pedigree: bare, meta: META, date: '2026-10-21' }).row)[7], '3');
  assert.deepEqual(INDEX_VERDICTS, ['pass', 'rework', 'flawed_plan']);
});

test('consolidation-acceptance AC10: the merge-and-state-hygiene-shaped pedigree (no execution_scores) is refused, naming all 9 scores + Rework', () => {
  const ped = {
    slug: 'merge-and-state-hygiene', hunt_tier: 'Yellow', certifier: 'glm', seat: 'wolfpack-watchdog-glm', verdict: 'PASS',
    certified_at_commit: 'x', checklist: {}, test_record: {}, tool_access: { shell: 'ok' }, timing: {},
  };
  const r = indexRow({ pedigree: ped, meta: { ...META, feature: 'merge-and-state-hygiene', pointer_round: 2, tracker_round: 2 }, date: '2026-10-21' });
  assert.equal(r.ok, false);
  for (const m of ALL_SCORE_MISSING) assert.ok(r.missing.includes(m), `missing names ${m}: ${r.missing}`);
  assert.ok(r.missing.includes('Verdict (certifier_verdict)'), 'a top-level `verdict` is NOT certifier_verdict');
  assert.ok(r.missing.includes('Human (execution_scores.human_interventions)'), 'Human has no metadata fallback');
  assert.ok(!r.missing.some((m) => m.startsWith('PtrRnd') || m.startsWith('TrkRnd')), 'the round counters fall back to metadata');
  assert.equal('row' in r, false);
});

test('consolidation-acceptance AC10: the run-observability-shaped pedigree (scores:{…}) is refused', () => {
  const ped = { certifier_verdict: 'pass', scores: { plan_adherence: 5, code_quality: 4, rework: 0 } };
  const r = indexRow({ pedigree: ped, meta: META, date: '2026-10-21' });
  assert.equal(r.ok, false);
  for (const m of ALL_SCORE_MISSING) assert.ok(r.missing.includes(m), m);
});

test('consolidation-acceptance AC10: certifier_verdict is required and validated (no metadata fallback); case-insensitive → uppercased', () => {
  for (const bad of [undefined, null, '', 'maybe', 'PASSED', 5, { v: 'pass' }]) {
    const ped = canonical({ certifier_verdict: bad });
    if (bad === undefined) delete ped.certifier_verdict;
    const r = indexRow({ pedigree: ped, meta: { ...META, verdict: 'PASS', status: 'certified' }, date: '2026-10-21' });
    assert.equal(r.ok, false, String(bad));
    assert.deepEqual(r.missing, ['Verdict (certifier_verdict)'], String(bad));
  }
  for (const [v, want] of [['pass', 'PASS'], ['PASS', 'PASS'], [' Rework ', 'REWORK'], ['flawed_plan', 'FLAWED_PLAN']]) {
    assert.equal(cellsOf(indexRow({ pedigree: canonical({ certifier_verdict: v }), meta: META, date: '2026-10-21' }).row)[6], want);
  }
});

test('consolidation-acceptance AC10: a score must be an integer 1–5 — 0 / 6 / 4.5 / "5" / null / "N/A" are refused (non-Green)', () => {
  for (const bad of [0, 6, 4.5, '5', null, 'N/A', -1, true, [], {}, { score: '4' }, { score: 7 }]) {
    const ped = canonical();
    ped.execution_scores.code_quality = bad;
    const r = indexRow({ pedigree: ped, meta: META, date: '2026-10-21' });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.deepEqual(r.missing, ['Quality (execution_scores.code_quality)'], JSON.stringify(bad));
  }
  // Rework / Human: integer ≥ 0 (0 is fine, a fraction or negative is not)
  for (const [k, col] of [['rework_rounds', 'Rework'], ['human_interventions', 'Human']]) {
    for (const bad of [-1, 1.5, '0', null]) {
      const ped = canonical();
      ped.execution_scores[k] = bad;
      const r = indexRow({ pedigree: ped, meta: META, date: '2026-10-21' });
      assert.equal(r.ok, false, `${k}=${bad}`);
      assert.deepEqual(r.missing, [`${col} (execution_scores.${k})`]);
    }
    const ok = canonical();
    ok.execution_scores[k] = 0;
    assert.equal(indexRow({ pedigree: ok, meta: META, date: '2026-10-21' }).ok, true);
  }
});

test('consolidation-acceptance AC10: PtrRnd / TrkRnd fall back to metadata.{pointer_round,tracker_round}; absent everywhere → refused', () => {
  const ped = canonical();
  delete ped.execution_scores.pointer_rounds;
  delete ped.execution_scores.tracker_rounds;
  const r = indexRow({ pedigree: ped, meta: { ...META, pointer_round: 3, tracker_round: 0 }, date: '2026-10-21' });
  assert.equal(r.ok, true);
  const c = cellsOf(r.row);
  assert.equal(c[17], '3');
  assert.equal(c[18], '0');
  const r2 = indexRow({ pedigree: ped, meta: META, date: '2026-10-21' });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.missing, ['PtrRnd (execution_scores.pointer_rounds)', 'TrkRnd (execution_scores.tracker_rounds)']);
});

test('consolidation-acceptance AC10: Green PtrRnd/TrkRnd get NO N/A allowance — the metadata fallback covers a Green scorecard without counters', () => {
  const ped = canonical();
  ped.execution_scores.code_review_quality = 'N/A';
  ped.execution_scores.test_authoring_quality = null;
  ped.process_value_add.pointer_value_add = 'N/A';
  ped.process_value_add.tracker_value_add = null;
  delete ped.execution_scores.pointer_rounds;
  delete ped.execution_scores.tracker_rounds;
  const green = { ...META, tier: 'Green', pointer_round: 0, tracker_round: 0 };
  const ok = indexRow({ pedigree: ped, meta: green, date: '2026-10-21' });
  assert.equal(ok.ok, true, JSON.stringify(ok.missing));
  const c = cellsOf(ok.row);
  assert.deepEqual(c.slice(17, 19), ['0', '0'], 'Green rounds come from metadata, never a dash');
  // no counters and no metadata fallback: refused, even on Green
  const bare = indexRow({ pedigree: ped, meta: { ...META, tier: 'Green' }, date: '2026-10-21' });
  assert.equal(bare.ok, false);
  assert.deepEqual(bare.missing, ['PtrRnd (execution_scores.pointer_rounds)', 'TrkRnd (execution_scores.tracker_rounds)']);
  // an explicit "N/A" counter on Green is refused too
  const na = deep(ped);
  na.execution_scores.pointer_rounds = 'N/A';
  na.execution_scores.tracker_rounds = 'N/A';
  const rn = indexRow({ pedigree: na, meta: green, date: '2026-10-21' });
  assert.equal(rn.ok, false);
  assert.deepEqual(rn.missing, ['PtrRnd (execution_scores.pointer_rounds)', 'TrkRnd (execution_scores.tracker_rounds)']);
});

test('consolidation-acceptance AC10: Green may leave the four Pointer/Tracker scores N/A (→ "—"); non-Green may not', () => {
  const ped = canonical();
  ped.execution_scores.code_review_quality = 'N/A';
  ped.execution_scores.test_authoring_quality = null;
  ped.process_value_add.pointer_value_add = { score: 'n/a', rationale: 'Green' };
  delete ped.process_value_add.tracker_value_add;
  const green = { ...META, tier: 'Green', model_assignments: { shepherd: 'claude:opus:high', pointer: null, tracker: null } };
  const r = indexRow({ pedigree: ped, meta: green, date: '2026-10-21' });
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  const c = cellsOf(r.row);
  assert.deepEqual(c.slice(3, 6), ['claude', '—', '—'], 'null Pointer/Tracker family → —');
  assert.deepEqual(c.slice(11, 15), ['—', '—', '—', '—']);
  assert.equal(c[15], '2', 'CycleEff is still required on Green');
  // the same pedigree on Yellow is refused, naming exactly the four
  const y = indexRow({ pedigree: ped, meta: META, date: '2026-10-21' });
  assert.equal(y.ok, false);
  assert.deepEqual(y.missing, [
    'CodeRev (execution_scores.code_review_quality)', 'TestAuth (execution_scores.test_authoring_quality)',
    'PtrVal (process_value_add.pointer_value_add)', 'TrkVal (process_value_add.tracker_value_add)',
  ]);
  // Green never excuses the core scores
  const core = deep(ped);
  core.execution_scores.plan_adherence = 'N/A';
  const gc = indexRow({ pedigree: core, meta: green, date: '2026-10-21' });
  assert.equal(gc.ok, false);
  assert.deepEqual(gc.missing, ['Adherence (execution_scores.plan_adherence)']);
});

test('consolidation-acceptance AC10: Feature / Tier / Date are required; notes are escaped and collapsed; --notes overrides pedigree.notes', () => {
  const r = indexRow({ pedigree: canonical(), meta: { model_assignments: {} }, date: '21/10/2026' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['Feature (metadata.feature)', 'Tier (metadata.tier)', 'Date (--date YYYY-MM-DD)']);
  const n = indexRow({ pedigree: canonical({ notes: 'a | b\nc   d' }), meta: META, date: '2026-10-21' });
  assert.equal(cellsOf(n.row.replace(/\\\|/g, '¦'))[20], 'a ¦ b c d');
  assert.ok(n.row.includes('a \\| b c d'), 'a literal | is escaped as \\|');
  assert.equal(n.row.split('\n').length, 1, 'one line');
  const o = indexRow({ pedigree: canonical(), meta: META, date: '2026-10-21', notes: 'from flag' });
  assert.equal(cellsOf(o.row)[20], 'from flag');
  const none = indexRow({ pedigree: canonical({ notes: undefined }), meta: META, date: '2026-10-21', duration: '5m' });
  assert.equal(cellsOf(none.row)[20], 'duration 5m', 'no leading "; " when there are no notes');
});

test('consolidation-acceptance AC10: applyIndexRow appends, refuses a duplicate, and --replace swaps exactly one row', () => {
  const head = '| Date | Feature | Tier |\n|---|---|---|\n';
  const a = '| 2026-01-01 | a | Yellow |';
  const b = '| 2026-01-02 | b | Yellow |';
  assert.equal(applyIndexRow(head + a, 'b', b), `${head}${a}\n${b}\n`, 'a missing trailing newline is added');
  assert.equal(applyIndexRow(`${head}${a}\n`, 'b', b), `${head}${a}\n${b}\n`);
  assert.throws(() => applyIndexRow(`${head}${a}\n`, 'a', a), /a row for a already exists \(use --replace/);
  const repl = '| 2026-02-02 | a | Green |';
  assert.equal(applyIndexRow(`${head}${a}\n${b}\n`, 'a', repl, { replace: true }), `${head}${repl}\n${b}\n`);
  assert.throws(() => applyIndexRow(`${head}${b}\n`, 'a', repl, { replace: true }), /exactly one existing row for a \(found 0\)/);
  assert.throws(() => applyIndexRow(`${head}${a}\n${a}\n`, 'a', repl, { replace: true }), /found 2/);
  // a slug that only appears in another row's Notes cell is not a match
  const c = '| 2026-01-03 | c | Yellow | follows a |';
  assert.equal(applyIndexRow(`${head}${c}\n`, 'a', a), `${head}${c}\n${a}\n`);
});

// ─── CLI ───
const DIRS = [];
process.on('exit', () => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });
function planDir({ pedigree = canonical(), meta = META } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'wpped-'));
  DIRS.push(d);
  const p = join(d, 'plan');
  mkdirSync(p);
  if (pedigree !== null) writeFileSync(join(p, 'pedigree.json'), typeof pedigree === 'string' ? pedigree : JSON.stringify(pedigree, null, 2));
  if (meta !== null) writeFileSync(join(p, 'metadata.json'), JSON.stringify(meta, null, 2));
  const index = join(d, 'index.md');
  writeFileSync(index, '# Wolfpack Pedigree Index\n\n| Date | Feature |\n|---|---|\n| 2026-01-01 | other | Yellow |\n');
  return { plan: p, index };
}
const pedCli = (...args) => spawnSync(process.execPath, [PED_CLI, ...args], { encoding: 'utf8' });

test('consolidation-acceptance AC10 CLI: index-row appends a valid row; a second call refuses (exit 2, file byte-identical)', () => {
  const { plan, index } = planDir();
  const r = pedCli('index-row', '--plan-dir', plan, '--index', index, '--date', '2026-10-21', '--duration', '4m 2s');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /index-row: appended the h row/);
  const text = readFileSync(index, 'utf8');
  const last = text.trimEnd().split('\n').pop();
  assert.equal(last, '| 2026-10-21 | h | Yellow | claude | glm | claude | PASS | 5 | 4 | 4 | 5 | 3 | 4 | 4 | 3 | 2 | 1 | 2 | 1 | 0 | did the thing; duration 4m 2s |');
  assert.ok(text.endsWith('\n'));
  const again = pedCli('index-row', '--plan-dir', plan, '--index', index, '--date', '2026-10-22');
  assert.equal(again.status, 2);
  assert.match(again.stderr, /^index-row: a row for h already exists/);
  assert.equal(readFileSync(index, 'utf8'), text, 'byte-identical after a refusal');
  // --date defaults to today (UTC)
  const { plan: p2, index: i2 } = planDir();
  assert.equal(pedCli('index-row', '--plan-dir', p2, '--index', i2).status, 0);
  assert.match(readFileSync(i2, 'utf8'), new RegExp(`\\| ${new Date().toISOString().slice(0, 10)} \\| h \\|`));
});

test('consolidation-acceptance AC10 CLI: a score-less pedigree.json exits 2 naming the missing fields; index.md untouched', () => {
  const { plan, index } = planDir({ pedigree: { verdict: 'PASS', checklist: {}, test_record: {} } });
  const before = readFileSync(index, 'utf8');
  const r = pedCli('index-row', '--plan-dir', plan, '--index', index, '--date', '2026-10-21', '--duration', '1m');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^index-row: missing or invalid pedigree scores: /);
  for (const m of [...ALL_SCORE_MISSING, 'Verdict (certifier_verdict)']) assert.ok(r.stderr.includes(m), m);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(index, 'utf8'), before);
  assert.doesNotMatch(readFileSync(index, 'utf8'), /—/, 'no dashed row was written');
});

test('consolidation-acceptance AC10 CLI: --replace rewrites exactly one row; with --notes and no --duration no "; duration" is added', () => {
  const { plan, index } = planDir();
  writeFileSync(index, '| Date | Feature |\n|---|---|\n| 2026-01-01 | h | Yellow | — | — | old notes; duration 3h 25m 5s |\n| 2026-01-02 | z | Yellow |\n');
  const r = pedCli('index-row', '--plan-dir', plan, '--index', index, '--replace', '--date', '2026-10-21',
    '--notes', 'old notes | pipe; duration 3h 25m 5s; scored after the fact by glm');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /index-row: replaced the h row/);
  const lines = readFileSync(index, 'utf8').split('\n');
  assert.equal(lines.length, 5);
  const row = lines[2];
  assert.ok(row.startsWith('| 2026-10-21 | h | Yellow | claude |'));
  assert.ok(row.endsWith('| old notes \\| pipe; duration 3h 25m 5s; scored after the fact by glm |'));
  assert.equal((row.match(/duration 3h 25m 5s/g) || []).length, 1, 'duration not duplicated');
  assert.doesNotMatch(row.replace(/\| — \|/g, ''), /—/);
  assert.equal(lines[3], '| 2026-01-02 | z | Yellow |', 'other rows untouched');
  // 0 matches → exit 2, byte-identical
  const { plan: p0, index: i0 } = planDir();
  const before = readFileSync(i0, 'utf8');
  const z = pedCli('index-row', '--plan-dir', p0, '--index', i0, '--replace', '--date', '2026-10-21');
  assert.equal(z.status, 2);
  assert.match(z.stderr, /exactly one existing row for h \(found 0\)/);
  assert.equal(readFileSync(i0, 'utf8'), before);
});

test('consolidation-acceptance AC10 CLI: missing --index / pedigree.json / metadata.json / unreadable index all exit 2 without writing', () => {
  const { plan, index } = planDir();
  const before = readFileSync(index, 'utf8');
  const noIdx = pedCli('index-row', '--plan-dir', plan, '--date', '2026-10-21');
  assert.equal(noIdx.status, 2);
  assert.match(noIdx.stderr, /--index <index\.md> is required/);
  const { plan: np, index: ni } = planDir({ pedigree: null });
  const r1 = pedCli('index-row', '--plan-dir', np, '--index', ni, '--date', '2026-10-21');
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /no readable pedigree\.json/);
  const { plan: bp, index: bi } = planDir({ pedigree: '{not json' });
  assert.equal(pedCli('index-row', '--plan-dir', bp, '--index', bi, '--date', '2026-10-21').status, 2);
  const { plan: mp, index: mi } = planDir({ meta: null });
  const r2 = pedCli('index-row', '--plan-dir', mp, '--index', mi, '--date', '2026-10-21');
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /no readable metadata\.json/);
  const r3 = pedCli('index-row', '--plan-dir', plan, '--index', join(plan, 'nope', 'index.md'), '--date', '2026-10-21');
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /cannot read/);
  const r4 = pedCli('index-row', '--plan-dir', plan, '--index', index, '--date', 'yesterday');
  assert.equal(r4.status, 2);
  assert.match(r4.stderr, /Date \(--date YYYY-MM-DD\)/);
  assert.equal(readFileSync(index, 'utf8'), before);
  assert.equal(pedCli('frobnicate', '--plan-dir', plan).status, 2);
});

test('consolidation-acceptance AC9: the merge-and-state-hygiene row in the real index carries scores — no dash, 21 cells, integers', () => {
  const rows = readFileSync(REAL_INDEX, 'utf8').split('\n').filter((l) => l.split('|')[2] && l.split('|')[2].trim() === 'merge-and-state-hygiene');
  assert.equal(rows.length, 1, 'exactly one row');
  assert.doesNotMatch(rows[0], /—/);
  const c = cellsOf(rows[0]);
  assert.equal(c.length, 21);
  for (let i = 7; i <= 15; i++) assert.match(c[i], /^[1-5]$/, `${INDEX_COLUMNS[i]} is a 1–5 score`);
  for (let i = 16; i <= 19; i++) assert.match(c[i], /^\d+$/, `${INDEX_COLUMNS[i]} is an integer`);
  assert.equal((c[20].match(/duration 3h 25m 5s/g) || []).length, 1, 'duration appears once');
  assert.match(c[20], /scored after the fact by (glm|mistral) \(consolidation-acceptance\)/, 'a cross-family seat scored it');
});
