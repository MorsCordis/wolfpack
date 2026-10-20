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
  // String-aware scan: comments are blanked only OUTSIDE string/template literals. Template
  // `${ ... }` interpolations are code again (and may nest further templates), tracked on a stack.
  let out = ''
  let str = null            // current literal quote when inside ' " or ` text
  const stack = []          // saved {depth} for each open `${` interpolation
  let depth = 0             // brace depth inside the current interpolation
  for (let i = 0; i < body.length; i++) {
    const c = body[i], n = body[i + 1]
    if (str) {
      if (c === '\\') { out += c + (n ?? ''); i++; continue }
      if (str === '`' && c === '$' && n === '{') { stack.push({ depth }); depth = 0; str = null; out += '${'; i++; continue }
      if (c === str) str = null
      else if (c === '\n' && str !== '`') str = null // ' and " literals cannot span lines
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      while (i < body.length && body[i] !== '\n') { out += ' '; i++ }
      i--
      continue
    }
    if (c === '/' && n === '*') {
      const e = body.indexOf('*/', i + 2)
      const stop = e < 0 ? body.length : e + 2
      out += body.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop - 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') { str = c; out += c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0 && stack.length) { depth = stack.pop().depth; str = '`'; out += c; continue }
      depth--
    }
    out += c
  }
  return [...out.matchAll(/\bmeta\b/g)].map(m => ({ index: m.index }))
}
