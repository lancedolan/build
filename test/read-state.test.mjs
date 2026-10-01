import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readState, computeStatus, pickPr, prQuery, main } from '../scripts/read-state.mjs'
import { formatMarker } from '../scripts/lib/markers.mjs'
import { loadJson, clone, fixtureGh, fixtureRunner } from './helpers.mjs'
import { makeGh } from '../scripts/lib/gh.mjs'

const spec40 = () => clone(loadJson('gh-spec40.json'))
const subIssue = (fx, n) => fx.spec.data.repository.issue.subIssues.nodes.find(s => s.number === n)

test('recorded empty case (lancedolan/build#1): no sub-issues is a graph error, no crash', async () => {
  const recorded = loadJson('gh-recorded-empty.json')
  let i = 0
  const gh = makeGh((args, opts) => {
    const want = recorded[i++]
    assert.deepEqual(JSON.parse(opts.input).variables, want.variables)
    return { status: 0, stdout: JSON.stringify(want.response), stderr: '' }
  })
  const s = await readState(gh, { repo: 'lancedolan/build', spec: 1 })
  assert.equal(i, recorded.length)
  assert.deepEqual(s.issues, [])
  assert.deepEqual(s.graphErrors, ['Spec #1 has no sub-issues. Run /break-down first.'])
  assert.equal(s.defaultBranch, null)
  assert.equal(s.viewerPermission, 'ADMIN')
  assert.equal(s.spec.reportCommentId, null)
  assert.equal(s.spec.lastRun, null)
})

test('spec 40: statuses, order, branches, and spec fields', async () => {
  const s = await readState(fixtureGh(spec40()), { repo: 'acme/shop', spec: 40 })
  assert.deepEqual(s.order, [41, 42, 43, 44, 45])
  assert.deepEqual(s.graphErrors, [])
  assert.deepEqual(Object.fromEntries(s.issues.map(i => [i.number, i.status])), {
    41: 'merged', 42: 'done', 43: 'blocked', 44: 'answered', 45: 'interrupted',
  })
  const by = Object.fromEntries(s.issues.map(i => [i.number, i]))
  assert.deepEqual(by[44].blockedBy, [42, 43])
  assert.deepEqual(by[42].branch, { name: 'build/40-42', exists: true, oid: 'oid42' })
  assert.deepEqual(by[41].branch, { name: 'build/40-41', exists: false, oid: null })
  assert.equal(by[42].pr.number, 47, 'the open PR wins over an older closed one')
  assert.equal(by[42].allPrs.length, 2)
  assert.equal(by[44].decisions[0].body, 'Decision: A')
  assert.equal(s.defaultBranch, 'main')
  assert.equal(s.deleteBranchOnMerge, true)
  assert.equal(s.spec.reportCommentId, 9001)
  assert.deepEqual(s.spec.lastRun, { humanInLoop: true, startOid: 'aaa111', stopped: null, resetsAt: null })
  assert.deepEqual(s.spec.decisions.map(d => d.body), ['Decision: use the brand colors from the style guide'])
  assert.deepEqual(s.spec.markers, [], 'markers in the report comment are not spec markers')
  assert.deepEqual(s.specBranch, { name: 'build/40-spec', exists: false, oid: null, prs: [] })
})

test('spec 40: findings from PR comments and review threads', async () => {
  const s = await readState(fixtureGh(spec40()), { repo: 'acme/shop', spec: 40 })
  const f = Object.fromEntries(s.issues.find(i => i.number === 42).pr.findings.map(x => [x.id.split('-').pop(), x]))
  assert.equal(f[1].open, false)
  assert.equal(f[1].status, 'fixed')
  assert.equal(f[2].open, false)
  assert.equal(f[2].status, 'withdrawn')
  assert.equal(f[2].argued, true)
  assert.equal(f[3].open, true, 'argued, then "stands": still open')
  assert.equal(f[4].open, true, 'inline review-thread finding')
})

test('a sub-issue closed by hand with no merged PR has status closed', async () => {
  const fx = spec40()
  subIssue(fx, 43).state = 'CLOSED'
  const s = await readState(fixtureGh(fx), { repo: 'acme/shop', spec: 40 })
  assert.equal(s.issues.find(i => i.number === 43).status, 'closed')
})

test('a closed sub-issue with a merged PR is merged, not closed', async () => {
  const fx = spec40()
  subIssue(fx, 41).state = 'CLOSED'
  const s = await readState(fixtureGh(fx), { repo: 'acme/shop', spec: 40 })
  assert.equal(s.issues.find(i => i.number === 41).status, 'merged')
})

test('computeStatus priority order', () => {
  const m = (type, createdAt, data = {}) => ({ type, createdAt, data })
  const openPr = { state: 'OPEN', merged: false }
  const all = [m('done', '05'), m('blocker', '04'), m('progress', '03')]
  assert.equal(computeStatus({ pr: { state: 'MERGED', merged: true }, markers: all, decisions: [] }), 'merged')
  assert.equal(computeStatus({ pr: openPr, markers: all, decisions: [] }), 'done')
  assert.equal(computeStatus({ pr: null, markers: all, decisions: [] }), 'blocked', 'done needs an open PR')
  assert.equal(computeStatus({ pr: null, markers: all, decisions: [{ createdAt: '06' }] }), 'answered')
  assert.equal(computeStatus({ pr: null, markers: all, decisions: [{ createdAt: '03' }] }), 'blocked', 'older decision does not answer')
  assert.equal(computeStatus({ pr: null, markers: [m('interrupted', '01')], decisions: [] }), 'interrupted')
  assert.equal(computeStatus({ pr: null, markers: [], decisions: [] }), 'todo')
  assert.equal(computeStatus({ pr: null, markers: [], decisions: [], state: 'CLOSED' }), 'closed')
  assert.equal(computeStatus({ pr: { state: 'MERGED', merged: true }, markers: [], decisions: [], state: 'CLOSED' }), 'merged')
})

test('computeStatus: a closed sub-issue is a type-8 blocker', () => {
  const m = (type, createdAt, data = {}) => ({ type, createdAt, data })
  const b8 = m('blocker', '05', { issue: 43, type: 8, scope: 'branch' })
  const closed = (markers, decisions = []) => computeStatus({ pr: null, markers, decisions, state: 'CLOSED' })
  assert.equal(closed([]), 'closed', 'no type-8 blocker posted yet')
  assert.equal(closed([b8]), 'blocked', 'posted, no answer')
  assert.equal(closed([b8], [{ createdAt: '04' }]), 'blocked', 'an older decision does not answer it')
  assert.equal(closed([b8], [{ createdAt: '06' }]), 'answered')
  assert.equal(closed([b8, m('done', '07', { issue: 43, pr: null })], [{ createdAt: '06' }]), 'closed-done', 'a Decision said treat it as done')
  assert.equal(closed([b8, m('blocker', '09', { issue: 43, type: 8 })], [{ createdAt: '06' }]), 'blocked', 'unclear answer: a newer blocker was posted')
  // Blockers from before the issue was closed don't count as the closed-issue question.
  assert.equal(closed([m('blocker', '01', { type: 3 })]), 'closed')
  assert.equal(closed([m('blocker', '01', { type: 3 })], [{ createdAt: '02' }]), 'closed')
  // A merged PR still wins.
  assert.equal(computeStatus({ pr: { state: 'MERGED', merged: true }, markers: [b8], decisions: [], state: 'CLOSED' }), 'merged')
  // Once the issue is open again, the type-8 question no longer applies.
  assert.equal(computeStatus({ pr: null, markers: [b8], decisions: [], state: 'OPEN' }), 'todo')
  assert.equal(computeStatus({ pr: null, markers: [m('blocker', '01', { type: 3 }), b8], decisions: [{ createdAt: '06' }], state: 'OPEN' }), 'answered')
  assert.equal(computeStatus({ pr: null, markers: [m('progress', '02'), b8], decisions: [{ createdAt: '06' }], state: 'OPEN' }), 'interrupted')
})

test('pickPr: open first, then newest merged, then newest', () => {
  const p = (number, state, merged, createdAt) => ({ number, state, merged, createdAt })
  assert.equal(pickPr([p(1, 'MERGED', true, '02'), p(2, 'OPEN', false, '01')]).number, 2)
  assert.equal(pickPr([p(1, 'CLOSED', false, '03'), p(2, 'MERGED', true, '01')]).number, 2)
  assert.equal(pickPr([p(1, 'CLOSED', false, '01'), p(2, 'CLOSED', false, '03')]).number, 2)
  assert.equal(pickPr([]), null)
})

test('pagination: spec comments, sub-issues, sub-issue comments, and refs', async () => {
  const fx = spec40()
  const repo = fx.spec.data.repository
  const issue = repo.issue
  const more = { hasNextPage: true, endCursor: 'c1' }
  const done = { hasNextPage: false, endCursor: null }

  // Sub-issue #45 moves to a second page.
  const s45 = issue.subIssues.nodes.pop()
  issue.subIssues.pageInfo = more
  // #43's blocker moves to a second comment page; the decision on #44 too.
  const s43 = subIssue(fx, 43)
  const blockerComment = s43.comments.nodes.pop()
  s43.comments.pageInfo = more
  // The spec's report comment moves to a second page.
  const report = issue.comments.nodes.shift()
  issue.comments.pageInfo = more
  // A ref moves to a second page.
  const ref45 = repo.refs.nodes.pop()
  repo.refs.pageInfo = more

  fx.pages = {
    'subIssues:I_40:c1': { pageInfo: done, nodes: [s45] },
    'comments:I_43:c1': { pageInfo: done, nodes: [blockerComment] },
    'comments:I_40:c1': { pageInfo: done, nodes: [report] },
    'refs:c1': { pageInfo: done, nodes: [ref45] },
  }
  const calls = []
  const s = await readState(makeGh(fixtureRunner(fx, { calls })), { repo: 'acme/shop', spec: 40 })
  assert.deepEqual(s.order, [41, 42, 43, 44, 45])
  assert.equal(s.issues.find(i => i.number === 43).status, 'blocked')
  assert.equal(s.issues.find(i => i.number === 45).branch.exists, true)
  assert.equal(s.spec.reportCommentId, 9001)
  assert.equal(calls.length, 6, 'spec query, 3 page queries for sub-issues/refs/spec comments, 1 for #43 comments, 1 PR batch')
})

test('PR lookups go in batches of 20 branches', async () => {
  const fx = spec40()
  const nodes = fx.spec.data.repository.issue.subIssues.nodes
  for (let n = 50; n < 75; n++) {
    nodes.push({ ...clone(nodes[0]), id: `I_${n}`, number: n, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } })
  }
  const calls = []
  await readState(makeGh(fixtureRunner(fx, { calls })), { repo: 'acme/shop', spec: 40 })
  const prCalls = calls.filter(c => c.input && c.input.includes('pullRequests(headRefName:'))
  assert.equal(prCalls.length, 2, '30 issue branches + the spec branch = 31 branches = 2 batches')
})

test('prQuery passes branch names as variables, never inline', () => {
  const q = prQuery(['build/40-41"; drop', 'x'])
  assert.ok(!q.includes('drop'))
  assert.match(q, /\$b0: String!, \$b1: String!/)
})

test('a sub-issue marker JSON with a closing --> is escaped and still parses', async () => {
  const fx = spec40()
  subIssue(fx, 43).comments.nodes[0].body = formatMarker('blocker', { issue: 43, type: 1, scope: 'branch', question: 'a --> b', options: [], recommendation: '' })
  const s = await readState(fixtureGh(fx), { repo: 'acme/shop', spec: 40 })
  assert.equal(s.issues.find(i => i.number === 43).markers[0].data.question, 'a --> b')
})

test('errors: missing issue, missing repo, bad spec number', async () => {
  const fx = spec40()
  fx.spec.data.repository.issue = null
  await assert.rejects(readState(fixtureGh(fx), { repo: 'acme/shop', spec: 40 }), /Issue #40 not found/)
  const fx2 = spec40()
  fx2.spec.data.repository = null
  await assert.rejects(readState(fixtureGh(fx2), { repo: 'acme/shop', spec: 40 }), /not found/)
  await assert.rejects(readState(fixtureGh(spec40()), { repo: 'acme/shop', spec: 'x' }), /--spec must be an issue number/)
  await assert.rejects(readState(fixtureGh(spec40()), { repo: 'acme', spec: 40 }), /owner\/name/)
})

test('GraphQL errors surface as an error', async () => {
  const gh = makeGh(() => ({ status: 0, stdout: JSON.stringify({ errors: [{ message: 'bad field' }] }), stderr: '' }))
  await assert.rejects(readState(gh, { repo: 'acme/shop', spec: 40 }), /GraphQL error: bad field/)
})

test('main resolves the repo from --repo-dir', async () => {
  const { output } = await main(['--spec', '40', '--repo-dir', '/tmp/x'], fixtureGh(spec40()))
  assert.equal(output.repo, 'acme/shop')
})

test('a squash-merged parent whose commits are still on a dependent branch is a bad merge', async () => {
  const fx = spec40()
  // PR #46 (issue #41) squashed: the merge commit's only parent is the old main.
  fx.prs['build/40-41'][0].mergeCommit.parents.nodes = [{ oid: 'main-before46' }]
  fx.compare = { 'head46...oid42': 'ahead' }
  let s = await readState(fixtureGh(fx), { repo: 'acme/shop', spec: 40 })
  assert.equal(s.issues.find(i => i.number === 41).pr.mergedWithMergeCommit, false)
  assert.deepEqual(s.badMerges, [{ issue: 41, pr: 46, dependent: 42, branch: 'build/40-42' }])
  // After a hand rebase the branch no longer has head46.
  fx.compare = { 'head46...oid42': 'diverged' }
  s = await readState(fixtureGh(fx), { repo: 'acme/shop', spec: 40 })
  assert.deepEqual(s.badMerges, [])
})

test('a merge-commit merge is not a bad merge and needs no compare call', async () => {
  const s = await readState(fixtureGh(spec40()), { repo: 'acme/shop', spec: 40 })
  assert.equal(s.issues.find(i => i.number === 41).pr.mergedWithMergeCommit, true)
  assert.deepEqual(s.badMerges, [])
})
