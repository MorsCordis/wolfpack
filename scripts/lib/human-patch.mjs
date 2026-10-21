// scripts/lib/human-patch.mjs — the pure core of the human-patch gate: which repo a staged
// patch targets, and the commands the park prints for it.
//
// A Shepherd stages a change to a protected agent-config path as a patch (the permission
// classifier refuses agent edits there). A patch under human-patches/ targets the hunt worktree;
// a patch under human-patches/consumer/ targets the consumer worktree recorded in
// metadata.consumer_worktree. The block below is mirrored byte-identically (minus `export`) in
// the hunt-pipeline workflow, which has no filesystem access and cannot import (Hard Rule 7);
// scripts/wolfpack-hunt-pipeline.test.mjs enforces it. No fs, no Date, no imports.

// ── BEGIN wolfpack-human-patch core (keep byte-identical: scripts/lib/human-patch.mjs ⇄ hunt-pipeline.js) ──
export const HUMAN_PATCH_TARGETS = ['hunt', 'consumer']
// rel = the patch path relative to human-patches/ ("01-x.patch" | "consumer/01-x.patch")
export function humanPatchTarget(rel) {
  const s = String(rel || '')
  if (/^consumer\/[^/]+\.patch$/.test(s)) return 'consumer'
  if (/^[^/]+\.patch$/.test(s)) return 'hunt'
  throw new Error(`human patch ${JSON.stringify(s)}: not <name>.patch or consumer/<name>.patch`)
}
// The repo a target's patches are checked and applied in. Consumer without a recorded worktree → throw.
export function humanPatchRepo(target, { worktreePath, consumer }) {
  if (target === 'hunt') return worktreePath
  if (target === 'consumer') {
    if (!consumer || typeof consumer.path !== 'string' || !consumer.path.startsWith('/'))
      throw new Error('a consumer-targeted human patch needs metadata.consumer_worktree.path (absolute) — the Shepherd records it when it creates the consumer worktree')
    return consumer.path
  }
  throw new Error(`unknown human-patch target ${JSON.stringify(target)}`)
}
// Park text: per-repo apply / add / commit lines, and the branch each repo's commit lands on.
// pending = [{ patch, paths, applies, target }]; hunt patches first, then consumer patches.
export function humanPatchApplySteps(pending, { worktreePath, consumer, slug }) {
  const lines = []
  const branches = []
  for (const target of HUMAN_PATCH_TARGETS) {
    const group = pending.filter(x => x.target === target)
    if (group.length === 0) continue
    const repo = humanPatchRepo(target, { worktreePath, consumer })
    for (const x of group) {
      lines.push(`  git -C ${repo} apply ${x.patch}${x.applies ? '' : '   # does NOT apply cleanly: inspect it first'}`)
    }
    const files = [...new Set(group.flatMap(x => x.paths || []))]
    lines.push(`  git -C ${repo} add ${files.join(' ')}`)
    lines.push(`  git -C ${repo} commit -m "fix(hooks): apply the Shepherd's staged patch"`)
    if (target === 'hunt') branches.push(`feat/${slug} (hunt worktree)`)
    else branches.push(`${(consumer && consumer.branch) || `feat/${slug}`} (consumer worktree ${repo})`)
  }
  return { steps: lines.join('\n'), branches }
}
// ── END wolfpack-human-patch core ──
