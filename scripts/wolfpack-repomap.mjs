#!/usr/bin/env node
// wolfpack-repomap.mjs — ranked, hunt-scoped symbol map for context-bounded agents.
//
// WHY: a local model with a small window can't be handed the whole tree. A role needs
// the *most-relevant* slice — the hunt's own files plus the symbols those files lean on.
// This builds an aider-style repo map: extract defs per file, link files by symbol
// reference, PageRank the reference graph (personalized toward the hunt's seed files),
// and emit a compact "file → top defs" map sized to a budget. DevDen owns this because
// the bought runtime (NemoClaw) supplies agents/sandboxes/policy but NOT repo navigation.
//
// PROTOTYPE SCOPE — the load-bearing, novel pieces are here and fully tested:
//   • reference-graph construction      (defs precise, refs = global-token intersection)
//   • personalized PageRank ranking     (hunt seeds bias the random-restart vector)
//   • hunt scoping + budgeted rendering  (seeds always kept, neighbors by rank)
//   • incremental re-parse on write      (stat-keyed cache; only touched files re-extract)
// The SYMBOL EXTRACTOR is deliberately a swappable seam (regex/heuristic for the
// prototype). Production swaps in tree-sitter (web-tree-sitter wasm — pure-JS, ARM-safe,
// no native compile) behind the same `extractSymbols(path, source)` contract. The graph /
// rank / scope / cache machinery above is extractor-agnostic and does not change.
//
// DETERMINISTIC by design (no Math.random): power-iteration PageRank + order-stable
// tie-breaks, preserving the framework's resume-clean invariant (cf. wolfpack-bandit.mjs).

import fs from 'node:fs';
import path from 'node:path';

// ─── Symbol extraction (the swappable seam) ──────────────────────────────────
// Per-language DEF patterns are precise; REFS are derived globally (any identifier
// token that matches a def name defined elsewhere), which is language-agnostic and
// self-filtering — noise tokens that nobody defines simply never form an edge.

const DEF_PATTERNS = {
  py: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
    [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
  ],
  js: [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/, 'function'],
  ],
};
DEF_PATTERNS.mjs = DEF_PATTERNS.cjs = DEF_PATTERNS.jsx = DEF_PATTERNS.ts = DEF_PATTERNS.tsx = DEF_PATTERNS.js;

const TOKEN_RE = /[A-Za-z_$][\w$]*/g;

export function langOf(filePath) {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return DEF_PATTERNS[ext] ? ext : null;
}

/**
 * Extract definitions and reference tokens from one file's source.
 *   returns { defs: [{ name, kind, line }], tokens: Set<string> }
 * SWAP POINT: replace the body with a tree-sitter query keeping this return shape.
 */
export function extractSymbols(filePath, source) {
  const lang = langOf(filePath);
  const defs = [];
  const tokens = new Set();
  if (!lang) return { defs, tokens };
  const patterns = DEF_PATTERNS[lang];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [re, kind] of patterns) {
      const m = re.exec(line);
      if (m) { defs.push({ name: m[1], kind, line: i + 1 }); break; }
    }
    let t;
    while ((t = TOKEN_RE.exec(line)) !== null) tokens.add(t[0]);
  }
  return { defs, tokens };
}

// ─── Incremental, stat-keyed extraction cache ────────────────────────────────
// On a write, the file's mtimeMs/size change → the cache entry misses → only that
// file re-extracts. Every untouched file reuses its cached symbol table. The cache
// is a plain object so it serializes cleanly into orchestrator state.

export function extractWithCache(root, file, cache) {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  let stat;
  try { stat = fs.statSync(abs); } catch { return { defs: [], tokens: new Set() }; }
  const sig = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache[file];
  if (hit && hit.sig === sig) return hit.symbols;
  const symbols = extractSymbols(file, fs.readFileSync(abs, 'utf8'));
  cache[file] = { sig, symbols };
  return symbols;
}

// ─── Reference graph ─────────────────────────────────────────────────────────
// Edge F → D weighted by how many of F's reference tokens are DEFINED in D, scaled
// by 1/(#files defining that symbol) so a symbol defined everywhere (idf-low) carries
// less linking weight than a uniquely-defined one. Self-edges dropped.

export function buildGraph(symbolsByFile) {
  const definers = new Map();          // symbol name → Set<file>
  for (const [file, { defs }] of Object.entries(symbolsByFile)) {
    for (const d of defs) {
      if (!definers.has(d.name)) definers.set(d.name, new Set());
      definers.get(d.name).add(file);
    }
  }
  const edges = {};                    // file → { targetFile → weight }
  for (const [file, { tokens }] of Object.entries(symbolsByFile)) {
    edges[file] ||= {};
    for (const tok of tokens) {
      const defs = definers.get(tok);
      if (!defs) continue;
      const w = 1 / defs.size;
      for (const target of defs) {
        if (target === file) continue;
        edges[file][target] = (edges[file][target] || 0) + w;
      }
    }
  }
  return { edges, definers };
}

// ─── Personalized PageRank (deterministic power iteration) ───────────────────
// `personalization` (file → weight, normalized internally) biases the random restart
// toward the hunt's seed files — that is the "scoped to a hunt" lever. Dangling nodes
// (no out-edges) redistribute by the personalization vector, not uniformly, so seeds
// stay central even in sparse graphs.

export function pageRank(edges, { d = 0.85, iterations = 40, personalization = null } = {}) {
  const nodes = Object.keys(edges);
  const n = nodes.length;
  if (n === 0) return {};

  let p = {};
  if (personalization) {
    const total = nodes.reduce((s, f) => s + (personalization[f] || 0), 0);
    if (total > 0) for (const f of nodes) p[f] = (personalization[f] || 0) / total;
    else for (const f of nodes) p[f] = 1 / n;
  } else {
    for (const f of nodes) p[f] = 1 / n;
  }

  const outSum = {};
  for (const f of nodes) outSum[f] = Object.values(edges[f]).reduce((a, b) => a + b, 0);

  let rank = {};
  for (const f of nodes) rank[f] = p[f];

  for (let it = 0; it < iterations; it++) {
    const next = {};
    for (const f of nodes) next[f] = (1 - d) * p[f];
    let dangling = 0;
    for (const f of nodes) if (outSum[f] === 0) dangling += rank[f];
    for (const f of nodes) {
      // dangling mass flows along the personalization vector (deterministic)
      if (dangling > 0) next[f] += d * dangling * p[f];
      const out = edges[f];
      if (outSum[f] === 0) continue;
      for (const target of Object.keys(out)) {
        next[target] += d * rank[f] * (out[target] / outSum[f]);
      }
    }
    rank = next;
  }
  return rank;
}

// ─── Hunt-scoped repo map ─────────────────────────────────────────────────────

/**
 * Build a ranked, hunt-scoped symbol map.
 *   opts = {
 *     root,                  // repo root (absolute or cwd-relative)
 *     files,                 // [relPath] candidate universe to map
 *     seeds = [],            // [relPath] the hunt's own files (always kept; bias PageRank)
 *     maxFiles = 25,         // budget: seeds + top-ranked neighbors
 *     maxDefsPerFile = 12,   // defs shown per file in the rendered text
 *     cache = {},            // incremental extraction cache (mutated in place)
 *     seedWeight = 100,      // personalization mass per seed vs 1 per non-seed
 *   }
 * Returns { ranked: [{ file, score, isSeed, defs }], text, cache }.
 */
export function buildRepoMap(opts) {
  const {
    root = process.cwd(), files = [], seeds = [],
    maxFiles = 25, maxDefsPerFile = 12, cache = {}, seedWeight = 100,
  } = opts;

  const seedSet = new Set(seeds);
  const universe = Array.from(new Set([...files, ...seeds]));
  const symbolsByFile = {};
  for (const f of universe) symbolsByFile[f] = extractWithCache(root, f, cache);

  const { edges } = buildGraph(symbolsByFile);
  for (const f of universe) edges[f] ||= {};   // ensure every file is a node

  const personalization = {};
  for (const f of universe) personalization[f] = seedSet.has(f) ? seedWeight : 1;
  const rank = pageRank(edges, { personalization });

  // Seeds first (kept regardless of budget), then highest-ranked neighbors.
  const ranked = universe
    .map((file) => ({ file, score: rank[file] || 0, isSeed: seedSet.has(file), defs: symbolsByFile[file].defs }))
    .sort((a, b) => {
      if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;   // order-stable tie-break
    })
    .slice(0, maxFiles);

  const text = renderMap(ranked, maxDefsPerFile);
  return { ranked, text, cache };
}

export function renderMap(ranked, maxDefsPerFile = 12) {
  const out = [];
  for (const { file, isSeed, defs } of ranked) {
    out.push(isSeed ? `${file}  (seed)` : file);
    const shown = defs.slice(0, maxDefsPerFile);
    for (const d of shown) out.push(`  ${d.kind} ${d.name}  :${d.line}`);
    if (defs.length > shown.length) out.push(`  … +${defs.length - shown.length} more`);
  }
  return out.join('\n');
}

// ─── CLI ───────────────────────────────────────────────────────────────────
// node wolfpack-repomap.mjs --root . --seed a.js --seed b.py --max 25 [files…]
// With no explicit files, walks the root for supported extensions (skips dot-dirs,
// node_modules, common virtualenvs).
function walk(root) {
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'paw_env', '.venv', 'staticfiles', 'dist', 'build']);
  const out = [];
  (function rec(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) rec(abs);
      else if (langOf(e.name)) out.push(path.relative(root, abs));
    }
  })(root);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const seeds = [];
  let root = process.cwd(), maxFiles = 25;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i] === '--seed') seeds.push(argv[++i]);
    else if (argv[i] === '--max') maxFiles = Number(argv[++i]);
    else files.push(argv[i]);
  }
  const universe = files.length ? files : walk(root);
  const { text, ranked } = buildRepoMap({ root, files: universe, seeds, maxFiles });
  process.stderr.write(`# repo map: ${ranked.length}/${universe.length} files (${seeds.length} seed)\n`);
  process.stdout.write(text + '\n');
}
