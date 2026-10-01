// Graph checks and ordering for a spec's sub-issues.

// issues: [{number, repo, blockedByAll: [{number, repo}]}]
// specRepo: "owner/name". specNumber: the spec issue number.
// Returns {blockedBy: Map<number, number[]>, order: number[], errors: string[]}.
export function analyzeGraph(issues, { specRepo, specNumber }) {
  const errors = []
  const inSpec = new Set()
  for (const i of issues) {
    if (i.repo && specRepo && i.repo !== specRepo) {
      errors.push(`Sub-issue ${i.repo}#${i.number} is in a different repo. /build only works sub-issues in ${specRepo}.`)
      continue
    }
    inSpec.add(i.number)
  }

  const blockedBy = new Map()
  for (const i of issues) {
    if (!inSpec.has(i.number)) continue
    const parents = []
    for (const b of i.blockedByAll || []) {
      const sameRepo = !b.repo || !specRepo || b.repo === specRepo
      if (sameRepo && inSpec.has(b.number)) {
        if (b.number === i.number) errors.push(`#${i.number} is blocked by itself.`)
        else if (!parents.includes(b.number)) parents.push(b.number)
      } else {
        const where = sameRepo ? `#${b.number}` : `${b.repo}#${b.number}`
        const what = sameRepo && b.number === specNumber ? 'the spec issue itself' : 'not a sub-issue of this spec'
        errors.push(`#${i.number} is blocked by ${where}, which is ${what}. Every "blocked by" link must point to a sub-issue of spec #${specNumber}.`)
      }
    }
    blockedBy.set(i.number, parents.sort((a, b) => a - b))
  }

  const { order, cycle } = topoOrder(blockedBy)
  if (cycle.length) {
    errors.push(`The "blocked by" links form a cycle among ${cycle.map(n => `#${n}`).join(', ')}.`)
  }
  return { blockedBy, order, errors }
}

// Kahn's algorithm. Ties go to the lowest issue number. Nodes left over are in or
// behind a cycle; they're appended in number order so `order` still lists everything.
export function topoOrder(blockedBy) {
  const nodes = [...blockedBy.keys()].sort((a, b) => a - b)
  const remaining = new Map(nodes.map(n => [n, (blockedBy.get(n) || []).filter(p => blockedBy.has(p)).length]))
  const children = new Map(nodes.map(n => [n, []]))
  for (const n of nodes) for (const p of blockedBy.get(n) || []) if (children.has(p)) children.get(p).push(n)

  const ready = nodes.filter(n => remaining.get(n) === 0)
  const order = []
  while (ready.length) {
    ready.sort((a, b) => a - b)
    const n = ready.shift()
    order.push(n)
    for (const c of children.get(n)) {
      remaining.set(c, remaining.get(c) - 1)
      if (remaining.get(c) === 0) ready.push(c)
    }
  }
  const cycle = nodes.filter(n => !order.includes(n))
  return { order: [...order, ...cycle], cycle }
}
