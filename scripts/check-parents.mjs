// Checks an issue's parent PRs before the workflow starts the issue (human-in-loop=true).
// Prints {merged, badMerges}: issue numbers of merged parents, and of parents merged with
// squash or rebase whose head commit is still on the issue's branch.
import { parseArgs } from 'node:util'
import { makeGh } from './lib/gh.mjs'
import { isMain, runCli, usageError, parseRepo } from './lib/cli.mjs'
import { mergedWithMergeCommit, hasCommit } from './read-state.mjs'

const USAGE = 'node check-parents.mjs --repo owner/name --branch build/<spec>-<issue> --parents <issue>:<pr>[,<issue>:<pr>...]'

export function parseParents(text) {
  if (!text) throw usageError('--parents is required')
  return text.split(',').map((pair) => {
    const m = /^(\d+):(\d+)$/.exec(pair.trim())
    if (!m) throw usageError(`--parents entries must look like 41:141, got "${pair}"`)
    return { issue: Number(m[1]), pr: Number(m[2]) }
  })
}

function prsQuery(parents) {
  const fields = parents.map((p, i) => `
    p${i}: pullRequest(number: ${p.pr}) { merged headRefOid mergeCommit { oid parents(first: 2) { nodes { oid } } } }`).join('')
  return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {${fields}
  }
}`
}

// The branch head, or null when the branch doesn't exist.
function branchOid(gh, owner, name, branch) {
  const r = gh.tryRun(['api', `repos/${owner}/${name}/git/ref/heads/${branch}`, '--jq', '.object.sha'])
  if (r.ok) return r.stdout.trim() || null
  if (/Not Found|HTTP 404/.test(r.stderr)) return null
  throw new Error(`couldn't read branch ${branch}: ${r.stderr.trim()}`)
}

export function checkParents(gh, { repo, branch, parents }) {
  const { owner, name } = parseRepo(repo)
  const data = gh.graphql(prsQuery(parents), { owner, name }).repository
  const merged = []
  const bad = []
  let head
  parents.forEach((p, i) => {
    const pr = data[`p${i}`]
    if (!pr) throw new Error(`PR #${p.pr} not found in ${repo}`)
    if (!pr.merged) return
    merged.push(p.issue)
    if (mergedWithMergeCommit(pr)) return
    if (head === undefined) head = branchOid(gh, owner, name, branch)
    if (head && hasCommit(gh, owner, name, head, pr.headRefOid)) bad.push(p.issue)
  })
  return { merged, badMerges: bad }
}

export async function main(argv, gh = makeGh()) {
  const { values } = parseArgs({
    args: argv,
    options: { repo: { type: 'string' }, branch: { type: 'string' }, parents: { type: 'string' } },
  })
  if (!values.repo) throw usageError('--repo is required')
  if (!values.branch) throw usageError('--branch is required')
  return { output: checkParents(gh, { repo: values.repo, branch: values.branch, parents: parseParents(values.parents) }) }
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)), USAGE)
