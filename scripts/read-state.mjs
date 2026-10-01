// Reads a spec issue, its sub-issue graph, branches, PRs, and comment markers from
// GitHub, and prints the state JSON from docs/contracts.md. Plain code, no LLM.
import { parseArgs } from 'node:util'
import { makeGh } from './lib/gh.mjs'
import { isMain, runCli, usageError, parseRepo } from './lib/cli.mjs'
import { analyzeGraph } from './lib/graph.mjs'
import {
  markersFromComments, decisionsFromComments, computeFindings, isReportComment,
  parseMarkers, lastMarker, isAfter,
} from './lib/markers.mjs'

const USAGE = 'node read-state.mjs --spec N (--repo owner/name | --repo-dir PATH)'

const ISSUE_COMMENT = 'databaseId url body createdAt author { login }'
const PAGE = 'pageInfo { hasNextPage endCursor }'

const SUB_ISSUE_FIELDS = `
  id number title body state url
  repository { nameWithOwner }
  blockedBy(first: 100) { nodes { number repository { nameWithOwner } } }
  comments(first: 100) { ${PAGE} nodes { ${ISSUE_COMMENT} } }`

export const SPEC_QUERY = `
query($owner: String!, $name: String!, $spec: Int!, $refQuery: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner deleteBranchOnMerge viewerPermission
    defaultBranchRef { name target { oid } }
    refs(refPrefix: "refs/heads/", query: $refQuery, first: 100) { ${PAGE} nodes { name target { oid } } }
    issue(number: $spec) {
      id number title body url state
      comments(first: 100) { ${PAGE} nodes { ${ISSUE_COMMENT} } }
      subIssues(first: 100) { ${PAGE} nodes { ${SUB_ISSUE_FIELDS} } }
    }
  }
}`

const SUB_ISSUES_PAGE_QUERY = `
query($id: ID!, $after: String) {
  node(id: $id) { ... on Issue { subIssues(first: 100, after: $after) { ${PAGE} nodes { ${SUB_ISSUE_FIELDS} } } } }
}`

const REFS_PAGE_QUERY = `
query($owner: String!, $name: String!, $refQuery: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", query: $refQuery, first: 100, after: $after) { ${PAGE} nodes { name target { oid } } }
  }
}`

const COMMENTS_PAGE_QUERY = `
query($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue { comments(first: 100, after: $after) { ${PAGE} nodes { ${ISSUE_COMMENT} } } }
    ... on PullRequest { comments(first: 100, after: $after) { ${PAGE} nodes { ${ISSUE_COMMENT} } } }
  }
}`

const PR_FIELDS = `
  id number url state merged mergedAt createdAt baseRefName headRefName headRefOid
  mergeCommit { oid parents(first: 2) { nodes { oid } } }
  comments(first: 100) { ${PAGE} nodes { ${ISSUE_COMMENT} } }
  reviewThreads(first: 100) { nodes { comments(first: 50) { nodes { databaseId url body createdAt author { login } } } } }`

// PRs are looked up by head branch name. Branch names go in as variables.
export function prQuery(branches) {
  const vars = branches.map((_, i) => `$b${i}: String!`).join(', ')
  const fields = branches.map((_, i) => `
    p${i}: pullRequests(headRefName: $b${i}, first: 20, states: [OPEN, MERGED, CLOSED], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ${PR_FIELDS} }
    }`).join('')
  return `query($owner: String!, $name: String!${vars ? `, ${vars}` : ''}) {
  repository(owner: $owner, name: $name) {${fields}
  }
}`
}

const PR_BATCH = 20

async function allPages(gh, first, fetchPage) {
  const nodes = [...(first.nodes || [])]
  let page = first.pageInfo
  while (page && page.hasNextPage) {
    const next = fetchPage(page.endCursor)
    nodes.push(...(next.nodes || []))
    page = next.pageInfo
  }
  return nodes
}

function commentsOf(gh, node) {
  return allPages(gh, node.comments || { nodes: [] }, after =>
    gh.graphql(COMMENTS_PAGE_QUERY, { id: node.id, after }).node.comments)
}

// Picks the PR that represents a branch: open first, then the newest merged, then the newest closed.
export function pickPr(prs) {
  const byNewest = [...prs].sort((a, b) => (isAfter(a.createdAt, b.createdAt) ? -1 : 1))
  return byNewest.find(p => p.state === 'OPEN') || byNewest.find(p => p.merged) || byNewest[0] || null
}

// Blocker type 8 is "the sub-issue was closed by hand with no merged PR". It only
// counts while the issue is closed; other blocker types only count while it is open.
export const CLOSED_BLOCKER_TYPE = 8
const isClosedBlocker = m => !!(m.data && m.data.type === CLOSED_BLOCKER_TYPE)

export function computeStatus({ pr, markers, decisions, state }) {
  if (pr && pr.merged) return 'merged'
  const answeredAfter = b => (decisions || []).some(d => isAfter(d.createdAt, b.createdAt))
  if (state === 'CLOSED') {
    // Closed by hand with no merged PR: the workflow asks the user (blocker type 8).
    const asked = lastMarker(markers, 'blocker', isClosedBlocker)
    if (!asked) return 'closed'
    if (!answeredAfter(asked)) return 'blocked'
    // The workflow posts a `done` marker with pr null when a Decision says to treat it as done.
    if (lastMarker(markers, 'done', m => isAfter(m.createdAt, asked.createdAt))) return 'closed-done'
    return 'answered'
  }
  const done = lastMarker(markers, 'done')
  if (done && pr && pr.state === 'OPEN') return 'done'
  const blocker = lastMarker(markers, 'blocker', m => !isClosedBlocker(m))
  if (blocker) return answeredAfter(blocker) ? 'answered' : 'blocked'
  if (lastMarker(markers, 'progress') || lastMarker(markers, 'interrupted')) return 'interrupted'
  return 'todo'
}

function shapePr(pr, comments) {
  if (!pr) return null
  const all = [
    ...comments,
    ...((pr.reviewThreads && pr.reviewThreads.nodes) || []).flatMap(t => (t.comments && t.comments.nodes) || []),
  ]
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    merged: !!pr.merged,
    mergedAt: pr.mergedAt || null,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    mergedWithMergeCommit: mergedWithMergeCommit(pr),
    findings: computeFindings(all),
  }
}

// A merge commit has the PR head as a parent. A squash or rebase merge doesn't. null if not merged.
export function mergedWithMergeCommit(pr) {
  if (!pr.merged) return null
  const parents = (pr.mergeCommit && pr.mergeCommit.parents && pr.mergeCommit.parents.nodes) || []
  return parents.some(p => p.oid === pr.headRefOid)
}

// A parent PR merged by squash or rebase, while a dependent branch still has the parent's original
// commits. /build needs merge commits in human-in-loop=true mode and refuses to repair this.
function findBadMerges(gh, owner, name, issues) {
  const out = []
  for (const parent of issues) {
    if (!parent.pr || parent.pr.mergedWithMergeCommit !== false) continue
    for (const child of issues) {
      if (!child.blockedBy.includes(parent.number) || !child.branch.exists) continue
      if (child.pr && child.pr.merged) continue
      // "ahead" or "identical": the child branch contains the parent PR's head commit.
      const status = gh.run(['api', `repos/${owner}/${name}/compare/${parent.pr.headRefOid}...${child.branch.oid}`, '--jq', '.status']).trim()
      if (status === 'ahead' || status === 'identical') {
        out.push({ issue: parent.number, pr: parent.pr.number, dependent: child.number, branch: child.branch.name })
      }
    }
  }
  return out
}

// gh: from makeGh(). Returns the state object.
export async function readState(gh, { repo, spec }) {
  const { owner, name } = parseRepo(repo)
  const specNum = Number(spec)
  if (!Number.isInteger(specNum) || specNum <= 0) throw usageError(`--spec must be an issue number, got "${spec}"`)
  const refQuery = `build/${specNum}-`

  const data = gh.graphql(SPEC_QUERY, { owner, name, spec: specNum, refQuery })
  const r = data.repository
  if (!r) throw new Error(`Repo ${repo} not found, or gh can't see it.`)
  if (!r.issue) throw new Error(`Issue #${specNum} not found in ${repo}.`)

  const refs = (await allPages(gh, r.refs, after =>
    gh.graphql(REFS_PAGE_QUERY, { owner, name, refQuery, after }).repository.refs))
    .filter(ref => ref.name.startsWith(refQuery))
  const refMap = new Map(refs.map(ref => [ref.name, ref.target ? ref.target.oid : null]))
  const branchInfo = n => ({ name: n, exists: refMap.has(n), oid: refMap.get(n) || null })

  const specComments = await commentsOf(gh, r.issue)
  const reportComments = specComments.filter(c => isReportComment(c.body))
  const report = reportComments[0] || null
  const runMarker = report ? parseMarkers(report.body).find(m => m.type === 'run') : null
  const plainSpecComments = specComments.filter(c => !isReportComment(c.body))

  const subNodes = await allPages(gh, r.issue.subIssues, after =>
    gh.graphql(SUB_ISSUES_PAGE_QUERY, { id: r.issue.id, after }).node.subIssues)

  const graph = analyzeGraph(
    subNodes.map(s => ({
      number: s.number,
      repo: s.repository ? s.repository.nameWithOwner : null,
      blockedByAll: ((s.blockedBy && s.blockedBy.nodes) || []).map(b => ({
        number: b.number, repo: b.repository ? b.repository.nameWithOwner : null,
      })),
    })),
    { specRepo: r.nameWithOwner, specNumber: specNum },
  )
  const graphErrors = [...graph.errors]
  if (subNodes.length === 0) graphErrors.push(`Spec #${specNum} has no sub-issues. Run /break-down first.`)

  const specBranchName = `build/${specNum}-spec`
  const issueNums = subNodes.filter(s => graph.blockedBy.has(s.number)).map(s => s.number)
  const branches = [...issueNums.map(n => `build/${specNum}-${n}`), specBranchName]

  const prsByBranch = new Map()
  for (let i = 0; i < branches.length; i += PR_BATCH) {
    const batch = branches.slice(i, i + PR_BATCH)
    const vars = { owner, name }
    batch.forEach((b, j) => { vars[`b${j}`] = b })
    const res = gh.graphql(prQuery(batch), vars).repository
    batch.forEach((b, j) => prsByBranch.set(b, (res[`p${j}`] && res[`p${j}`].nodes) || []))
  }

  async function prFor(branch) {
    const raw = pickPr(prsByBranch.get(branch) || [])
    if (!raw) return null
    return shapePr(raw, await commentsOf(gh, raw))
  }

  const issues = []
  for (const s of subNodes) {
    if (!graph.blockedBy.has(s.number)) continue
    const comments = await commentsOf(gh, s)
    const markers = markersFromComments(comments)
    const decisions = decisionsFromComments(comments)
    const branchName = `build/${specNum}-${s.number}`
    const pr = await prFor(branchName)
    issues.push({
      number: s.number,
      title: s.title,
      body: s.body,
      state: s.state,
      url: s.url,
      blockedBy: graph.blockedBy.get(s.number),
      decisions,
      markers,
      branch: branchInfo(branchName),
      pr,
      allPrs: (prsByBranch.get(branchName) || []).map(p => ({ number: p.number, state: p.state, merged: !!p.merged, baseRefName: p.baseRefName })),
      status: computeStatus({ pr, markers, decisions, state: s.state }),
    })
  }
  const byNum = new Map(issues.map(i => [i.number, i]))
  const specPrs = prsByBranch.get(specBranchName) || []

  return {
    repo: r.nameWithOwner,
    defaultBranch: r.defaultBranchRef ? r.defaultBranchRef.name : null,
    defaultBranchOid: r.defaultBranchRef && r.defaultBranchRef.target ? r.defaultBranchRef.target.oid : null,
    deleteBranchOnMerge: !!r.deleteBranchOnMerge,
    viewerPermission: r.viewerPermission || null,
    spec: {
      number: r.issue.number,
      title: r.issue.title,
      body: r.issue.body,
      url: r.issue.url,
      state: r.issue.state,
      decisions: decisionsFromComments(plainSpecComments),
      markers: markersFromComments(plainSpecComments),
      reportCommentId: report ? report.databaseId : null,
      lastRun: runMarker ? runMarker.data : null,
    },
    specBranch: {
      ...branchInfo(specBranchName),
      prs: specPrs.map(p => ({ number: p.number, url: p.url, state: p.state, merged: !!p.merged, baseRefName: p.baseRefName })),
    },
    issues: graph.order.filter(n => byNum.has(n)).map(n => byNum.get(n)),
    order: graph.order,
    graphErrors,
    badMerges: findBadMerges(gh, owner, name, issues),
  }
}

export async function resolveRepo(gh, repoDir) {
  const out = gh.json(['repo', 'view', '--json', 'nameWithOwner'], { cwd: repoDir })
  if (!out || !out.nameWithOwner) throw new Error(`Couldn't find the GitHub repo for ${repoDir}.`)
  return out.nameWithOwner
}

export async function main(argv, gh = makeGh()) {
  const { values } = parseArgs({
    args: argv,
    options: { spec: { type: 'string' }, repo: { type: 'string' }, 'repo-dir': { type: 'string' } },
  })
  if (!values.spec) throw usageError('--spec is required')
  const repo = values.repo || (values['repo-dir'] ? await resolveRepo(gh, values['repo-dir']) : null)
  if (!repo) throw usageError('--repo or --repo-dir is required')
  return { output: await readState(gh, { repo, spec: values.spec }) }
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)), USAGE)
