// Tests for wolfpack-repomap.mjs — run: node --test scripts/wolfpack-repomap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractSymbols, langOf, buildGraph, pageRank,
  buildRepoMap, extractWithCache, renderMap,
} from './wolfpack-repomap.mjs';

// ─── extraction ──────────────────────────────────────────────────────────────
test('extract: python defs + classes with line numbers', () => {
  const src = ['import os', 'class Vet:', '    def heal(self):', '        return treat(self)', 'async def fetch():', '    pass'].join('\n');
  const { defs } = extractSymbols('a.py', src);
  assert.deepEqual(defs.map((d) => [d.kind, d.name, d.line]), [
    ['class', 'Vet', 2], ['function', 'heal', 3], ['function', 'fetch', 5],
  ]);
});

test('extract: js function / class / arrow-const / function-expr', () => {
  const src = [
    'export function alpha() {}',
    'class Pack {}',
    'const bravo = (x) => x + 1;',
    'let charlie = function () {};',
  ].join('\n');
  const { defs } = extractSymbols('a.js', src);
  assert.deepEqual(defs.map((d) => d.name).sort(), ['Pack', 'alpha', 'bravo', 'charlie']);
});

test('extract: unsupported extension → empty', () => {
  assert.equal(langOf('notes.md'), null);
  const { defs, tokens } = extractSymbols('notes.md', 'def not_code():');
  assert.equal(defs.length, 0);
  assert.equal(tokens.size, 0);
});

// ─── graph ─────────────────────────────────────────────────────────────────
test('graph: edge from referencer to definer, idf-weighted, no self-edge', () => {
  const symbols = {
    'lib.py': { defs: [{ name: 'treat', kind: 'function', line: 1 }], tokens: new Set(['treat']) },
    'app.py': { defs: [{ name: 'main', kind: 'function', line: 1 }], tokens: new Set(['treat', 'main']) },
  };
  const { edges } = buildGraph(symbols);
  assert.equal(edges['app.py']['lib.py'], 1);      // app references treat → edge to lib
  assert.equal(edges['lib.py']?.['app.py'], undefined); // lib doesn't reference main
  assert.equal(edges['app.py']['app.py'], undefined);   // self-edge dropped
});

test('graph: symbol defined in many files gets down-weighted (1/definers)', () => {
  const symbols = {
    'one.py': { defs: [{ name: 'util', kind: 'function', line: 1 }], tokens: new Set() },
    'two.py': { defs: [{ name: 'util', kind: 'function', line: 1 }], tokens: new Set() },
    'use.py': { defs: [], tokens: new Set(['util']) },
  };
  const { edges } = buildGraph(symbols);
  assert.equal(edges['use.py']['one.py'], 0.5);
  assert.equal(edges['use.py']['two.py'], 0.5);
});

// ─── pagerank ────────────────────────────────────────────────────────────────
test('pagerank: a widely-referenced file outranks a leaf', () => {
  const edges = { a: { core: 1 }, b: { core: 1 }, c: { core: 1 }, core: {} };
  const r = pageRank(edges);
  assert.ok(r.core > r.a && r.core > r.b && r.core > r.c);
});

test('pagerank: personalization biases mass toward seeds', () => {
  const edges = { a: { b: 1 }, b: {}, c: {} };
  const flat = pageRank(edges);
  const biased = pageRank(edges, { personalization: { c: 1, a: 0, b: 0 } });
  assert.ok(biased.c > flat.c);   // seeding c lifts it
});

test('pagerank: deterministic — identical input, identical output', () => {
  const edges = { a: { b: 1, c: 1 }, b: { c: 1 }, c: {} };
  assert.deepEqual(pageRank(edges), pageRank(edges));
});

// ─── end-to-end repo map (real temp files) ───────────────────────────────────
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repomap-'));
  fs.writeFileSync(path.join(dir, 'core.py'), 'def treat(p):\n    return p\ndef dose(p):\n    return p\n');
  fs.writeFileSync(path.join(dir, 'app.py'), 'from core import treat\ndef main():\n    return treat(1)\n');
  fs.writeFileSync(path.join(dir, 'lonely.py'), 'def unused():\n    return 0\n');
  return dir;
}

test('buildRepoMap: seeds kept first, neighbors ranked, budget enforced', () => {
  const root = mkRepo();
  const files = ['core.py', 'app.py', 'lonely.py'];
  const { ranked } = buildRepoMap({ root, files, seeds: ['app.py'], maxFiles: 2 });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].file, 'app.py');       // seed first
  assert.equal(ranked[0].isSeed, true);
  assert.equal(ranked[1].file, 'core.py');      // core referenced by the seed → top neighbor over lonely
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderMap: seed marker + def lines + truncation note', () => {
  const text = renderMap([
    { file: 'app.py', isSeed: true, defs: [{ name: 'main', kind: 'function', line: 2 }] },
    { file: 'core.py', isSeed: false, defs: Array.from({ length: 14 }, (_, i) => ({ name: `f${i}`, kind: 'function', line: i + 1 })) },
  ], 12);
  assert.match(text, /app\.py {2}\(seed\)/);
  assert.match(text, /function main {2}:2/);
  assert.match(text, /… \+2 more/);            // 14 defs, 12 shown
});

// ─── incremental cache ───────────────────────────────────────────────────────
test('extractWithCache: reuses on unchanged stat, re-extracts after a write', () => {
  const root = mkRepo();
  const cache = {};
  const first = extractWithCache(root, 'core.py', cache);
  assert.equal(first.defs.length, 2);
  const sig1 = cache['core.py'].sig;

  // unchanged → same cached object identity (no re-parse)
  const second = extractWithCache(root, 'core.py', cache);
  assert.equal(second, first);

  // write (bump mtime + size) → cache misses → re-extract picks up the new def
  const p = path.join(root, 'core.py');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\ndef euthanize(p):\n    return p\n');
  const future = Date.now() / 1000 + 5;
  fs.utimesSync(p, future, future);
  const third = extractWithCache(root, 'core.py', cache);
  assert.notEqual(cache['core.py'].sig, sig1);
  assert.equal(third.defs.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildRepoMap: missing file degrades to empty symbols, does not throw', () => {
  const root = mkRepo();
  const { ranked } = buildRepoMap({ root, files: ['core.py', 'ghost.py'], seeds: [] });
  const ghost = ranked.find((r) => r.file === 'ghost.py');
  assert.equal(ghost.defs.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
