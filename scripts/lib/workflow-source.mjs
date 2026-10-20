// Load a named workflow's source the way the Workflow runtime does: the leading
// `export const meta = { ... }` block is REMOVED (brace-matched), never rewritten. Test-only.

// Split a workflow source into { metaText, body, meta }. The meta block's header may be a `//`
// comment holding a brace, so the scan tracks string and comment state.
export function splitMeta(src) {
  if (!src.startsWith('export const meta')) throw new Error('workflow source does not start with `export const meta`')
  const open = src.indexOf('{')
  if (open < 0) throw new Error('meta block has no opening brace')
  let depth = 0, end = -1
  let str = null // current quote char
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (str) {
      if (c === '\\') i++
      else if (c === str) str = null
      continue
    }
    if (c === '/' && n === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue }
    if (c === "'" || c === '"' || c === '`') { str = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('meta block is not brace-balanced')
  if (src[end] === ';') end++
  const metaText = src.slice(0, end)
  const body = src.slice(end)
  const meta = new Function(metaText.replace(/^export const meta\s*=/, 'return '))()
  return { metaText, body, meta }
}

export function stripMeta(src) { return splitMeta(src).body }

// Hits of the bare identifier `meta` in runtime code (comments blanked, strings/templates kept:
// the bug lived inside a template literal).
export function runtimeMetaRefs(body) {
  const noComments = body
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, (m, p) => p)
  return [...noComments.matchAll(/\bmeta\b/g)].map(m => ({ index: m.index }))
}
