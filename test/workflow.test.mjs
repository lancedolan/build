// Runs workflows/build-graph.js with stub globals. No agent ever runs: agent() returns
// canned results picked by opts.label.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const SOURCE = readFileSync(join(ROOT, 'workflows', 'build-graph.js'), 'utf8')
const META_RE = /^export const meta = \{[\s\S]*?\n\}\n/
const BODY = SOURCE.replace(META_RE, '')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const SCRIPT = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', BODY)

// Label format from docs/contracts.md.
const ISSUE_ROLE = '(?:scout|test-writer|implementer|verifier|review:\\S+|merger|rebaser|git|decision-reader)'
const SPEC_ROLE = '(?:start-verifier|recheck|rebaser|git)'
const LABEL_RE = new RegExp(`^(?:#\\d+ ${ISSUE_ROLE}|#spec ${SPEC_ROLE})(?: r\\d+(?: c\\d+)?)?$`)

const common = () => ({ judgmentCalls: [], recommendations: [], blocker: null })

// Canned results by role. `n` is the issue number from the label (or 'spec').
function defaultResult(label, prompt) {
  const m = /^#(\S+) (\S+)/.exec(label)
  const n = m[1]
  const role = m[2]
  if (role === 'scout') return { brief: `# Brief for issue #${n}`, verifyCommands: ['npm test'], ...common() }
  if (role === 'test-writer') return { testCommit: `tests${n}`, testFiles: ['t.test.js'], failureCheck: 'fails: missing', pureRefactor: false, untestedCases: [], ...common() }
  if (role === 'implementer') return { headCommit: `head${n}`, summary: `summary ${n}`, testChanges: [], replies: [], ...common() }
  if (role === 'verifier' || role === 'start-verifier') {
    return { passed: true, headCommit: n === 'spec' ? 'start-sha' : `head${n}`, commandsRun: ['npm test'], failures: '', mainCheckoutClean: true, testDiffOk: true }
  }
  if (role.startsWith('review:')) return { findings: [], verdicts: [], ...common() }
  if (role === 'merger') return { merged: true, mergeCommit: `merge${n}`, error: '' }
  if (role === 'rebaser') return { rebased: [], conflicts: [], verifyFailed: [] }
  if (role === 'recheck') return { affected: [], ...common() }
  if (role === 'git') {
    if (prompt.includes('Check the parent PRs')) return { merged: [], badMerges: [], error: '' }
    if (n === 'spec') return prompt.includes('Final PR for spec') ? { ok: true, error: '', prNumber: 900 } : { ok: true, error: '' }
    return { ok: true, error: '', prNumber: 100 + Number(n), prUrl: `https://x/pull/${100 + Number(n)}` }
  }
  throw new Error(`no canned result for ${label}`)
}

// Same contract as the real globals: a thunk that throws gives null.
const parallel = thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
async function pipeline(items, ...stages) {
  return Promise.all(items.map(async item => {
    let v = item
    try {
      for (const s of stages) v = await s(v)
      return v
    } catch {
      return null
    }
  }))
}

function issue(number, extra = {}) {
  return {
    number, title: `Issue ${number}`, body: `body ${number}`, state: 'OPEN',
    blockedBy: [], decisions: [], markers: [],
    branch: { name: `build/40-${number}`, exists: false, oid: null },
    pr: null, status: 'todo', url: `https://x/issues/${number}`, allPrs: [],
    ...extra,
  }
}

function makeArgs(issues, { humanInLoop = true, spec = {}, ...rest } = {}) {
  return {
    state: {
      repo: 'acme/shop', defaultBranch: 'main', defaultBranchOid: 'main-sha', deleteBranchOnMerge: true, viewerPermission: 'ADMIN',
      spec: { number: 40, title: 'Spec', body: 'spec body', url: 'https://x/issues/40', decisions: [], markers: [], reportCommentId: null, lastRun: null, ...spec },
      specBranch: { name: 'build/40-spec', exists: false, oid: null, prs: [] },
      issues,
      order: issues.map(i => i.number),
      graphErrors: [],
    },
    worktree: '/w/shop.build-40', mainCheckout: '/w/shop',
    ports: { base: 3110, list: [3110, 3111] },
    humanInLoop,
    reportFile: '/home/u/.claude/build/acme-shop-40/report.md',
    reviewers: ['build:fallback-reviewer'],
    isRerun: false, needsStartVerify: true, mainCheckoutBaseline: '',
    ...rest,
  }
}

// Runs the script. `respond(label, prompt, opts)` may return a result; undefined falls back to the default.
async function run(args, respond = () => undefined) {
  const calls = []
  const phases = []
  const logs = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt, opts })
    const r = respond(opts.label, prompt, opts)
    return r !== undefined ? r : defaultResult(opts.label, prompt)
  }
  const saved = { now: Date.now, random: Math.random }
  Date.now = () => { throw new Error('the workflow script must not call Date.now') }
  Math.random = () => { throw new Error('the workflow script must not call Math.random') }
  try {
    const out = await SCRIPT(agent, parallel, pipeline, p => phases.push(p), m => logs.push(m), args, { spent: () => 0, total: null })
    return { out, calls, phases, logs, labels: calls.map(c => c.label) }
  } finally {
    Date.now = saved.now
    Math.random = saved.random
  }
}

const byNum = out => Object.fromEntries(out.issues.map(i => [i.number, i]))
const callFor = (calls, label) => calls.find(c => c.label === label)

test('script body has no fs, imports, clock, or randomness', () => {
  assert.match(SOURCE, META_RE, 'the meta block is found and stripped')
  assert.doesNotMatch(BODY, /export const meta/)
  assert.doesNotMatch(BODY, /\bimport\s*\(|^\s*import\s|\brequire\(|\bprocess\.|Date\.now|new Date\(|Math\.random/m)
})

test('happy path, 2 issues, humanInLoop true: the second PR stacks on the first branch', async () => {
  const { out, calls, labels, phases } = await run(makeArgs([issue(41), issue(42, { blockedBy: [41] })]))
  assert.deepEqual(labels, [
    '#spec start-verifier',
    '#41 scout', '#41 test-writer', '#41 implementer r0', '#41 verifier r0 c1', '#41 git',
    '#41 review:build:fallback-reviewer r1', '#41 git',
    '#42 git',
    '#42 scout', '#42 test-writer', '#42 implementer r0', '#42 verifier r0 c1', '#42 git',
    '#42 review:build:fallback-reviewer r1', '#42 git',
  ])
  assert.deepEqual(phases, ['Startup', 'Issue #41', 'Issue #42'])
  const r = byNum(out)
  assert.deepEqual(r[41], { number: 41, outcome: 'done', pr: 141, base: 'main', waitingOn: [], blocker: null })
  assert.deepEqual(r[42], { number: 42, outcome: 'done', pr: 142, base: 'build/40-41', waitingOn: [], blocker: null })
  assert.equal(out.stopped, null)
  assert.equal(out.startOid, 'start-sha')
  assert.equal(out.finalPr, null)
  assert.equal(out.agentCount, calls.length)

  // #42 starts from #41's branch and its PR targets it.
  const tw = callFor(calls, '#42 test-writer').prompt
  assert.match(tw, /checkout -b build\/40-42 origin\/build\/40-41/)
  const publish = calls.filter(c => c.label === '#42 git')[1].prompt
  assert.match(publish, /--base build\/40-41/)
  assert.match(publish, /Stacked on PR #141 \(`build\/40-41`\)/)
  // #41's PR targets main.
  assert.match(calls.filter(c => c.label === '#41 git')[0].prompt, /--base main/)
  // The brief goes first in the test-writer, implementer, and verifier prompts.
  for (const l of ['#42 test-writer', '#42 implementer r0', '#42 verifier r0 c1']) {
    assert.ok(callFor(calls, l).prompt.startsWith('# Brief for issue #42'), l)
  }
  // Reviewers never get the brief.
  assert.doesNotMatch(callFor(calls, '#42 review:build:fallback-reviewer r1').prompt, /# Brief for issue/)
  assert.equal(callFor(calls, '#42 review:build:fallback-reviewer r1').opts.agentType, 'build:fallback-reviewer')
})

test('diamond: C depends on unmerged A and B', async () => {
  const { out, calls } = await run(makeArgs([issue(41), issue(42), issue(43, { blockedBy: [41, 42] })]))
  const r = byNum(out)
  assert.equal(r[43].outcome, 'done')
  assert.equal(r[43].base, 'build/40-42', 'targets the last parent in order')
  const tw = callFor(calls, '#43 test-writer').prompt
  assert.match(tw, /checkout -b build\/40-43 origin\/build\/40-42/)
  assert.match(tw, /Merge `origin\/build\/40-41` into it with a merge commit/)
  const body = calls.filter(c => c.label === '#43 git')[1].prompt
  assert.match(body, /--base build\/40-42/)
  assert.match(body, /Merge order: #141 \(issue #41\), then #142 \(issue #42\), then this PR\./)
  assert.match(body, /its diff also includes the changes from #141/)
  // Both open parents are checked before #43 starts.
  assert.match(callFor(calls, '#43 git').prompt, /--parents 41:141,42:142/)
})

test('humanInLoop false: merges into the spec branch, then opens the final PR', async () => {
  const { out, calls, labels, phases } = await run(makeArgs([issue(41), issue(42, { blockedBy: [41] })], { humanInLoop: false }))
  assert.equal(labels[0], '#spec git', 'creates the spec branch first')
  assert.match(calls[0].prompt, /refs\/heads\/build\/40-spec/)
  assert.equal(labels[1], '#spec start-verifier')
  assert.match(calls[1].prompt, /origin\/build\/40-spec/)
  assert.ok(!calls.some(c => c.prompt.includes('Check the parent PRs')), 'no parent checks in false mode')
  assert.ok(labels.indexOf('#41 merger') < labels.indexOf('#42 scout'), 'parent merged before the child starts')
  const r = byNum(out)
  assert.deepEqual([r[41].outcome, r[41].base, r[42].outcome, r[42].base], ['merged', 'build/40-spec', 'merged', 'build/40-spec'])
  for (const n of [41, 42]) {
    const publish = calls.find(c => c.label === `#${n} git`).prompt
    assert.match(publish, /--base build\/40-spec/)
    assert.match(callFor(calls, `#${n} merger`).prompt, new RegExp(`gh pr merge ${100 + n} -R acme/shop --merge`))
  }
  const final = calls[calls.length - 1]
  assert.equal(final.label, '#spec git')
  assert.match(final.prompt, /--head build\/40-spec --base main/)
  assert.match(final.prompt, /- #41 → PR #141\n- #42 → PR #142/)
  assert.equal(out.finalPr, 900)
  assert.equal(out.stopped, null)
  assert.ok(phases.includes('Finish'))
})

test('blocker 7 after 3 verify-repair cycles; dependents wait', async () => {
  const fail = { passed: false, headCommit: 'bad', commandsRun: ['npm test'], failures: 'npm test exited 1', mainCheckoutClean: true, testDiffOk: true }
  const { out, labels, calls } = await run(
    makeArgs([issue(41), issue(42, { blockedBy: [41] }), issue(43, { blockedBy: [42] }), issue(44)]),
    label => (label.startsWith('#41 verifier') ? fail : undefined),
  )
  assert.deepEqual(labels.filter(l => l.startsWith('#41 verifier') || l.startsWith('#41 implementer')), [
    '#41 implementer r0',
    '#41 verifier r0 c1', '#41 implementer r0 c1',
    '#41 verifier r0 c2', '#41 implementer r0 c2',
    '#41 verifier r0 c3', '#41 implementer r0 c3',
    '#41 verifier r0 c4',
  ])
  const posted = calls[labels.lastIndexOf('#41 git')].prompt
  assert.match(posted, /build:blocker \{"issue":41,"type":7,"scope":"branch"/)
  const r = byNum(out)
  assert.equal(r[41].outcome, 'blocked')
  assert.equal(r[41].blocker.type, 7)
  assert.deepEqual(r[42], { number: 42, outcome: 'waiting', pr: null, base: null, waitingOn: [41], blocker: null })
  assert.deepEqual(r[43].waitingOn, [41], 'waits on the stuck issue, not its direct parent')
  assert.equal(r[44].outcome, 'done', 'an unrelated issue keeps going')
  assert.equal(out.stopped, null)
})

test('a graph-scope blocker from an agent stops all work', async () => {
  const graph = { type: 1, scope: 'graph', question: 'spec contradicts itself', options: ['A) x', 'B) y'], recommendation: 'A' }
  const { out, labels } = await run(
    makeArgs([issue(41), issue(42)]),
    label => (label === '#41 scout' ? { brief: 'b', verifyCommands: [], judgmentCalls: [], recommendations: [], blocker: graph } : undefined),
  )
  assert.equal(labels[labels.length - 1], '#41 scout', 'no agent starts after the blocker')
  assert.equal(out.stopped, 'graph-blocker')
  assert.deepEqual(out.graphBlocker, graph)
  const r = byNum(out)
  assert.equal(r[41].outcome, 'blocked')
  assert.equal(r[42].outcome, 'waiting')
  assert.deepEqual(r[42].waitingOn, [])
  assert.match(r[42].reason, /graph-blocker/)
})

test('an unanswered graph blocker on the spec issue starts no agents', async () => {
  const data = { issue: 40, type: 4, scope: 'graph', question: 'main is red', options: [], recommendation: 'A' }
  const { out, calls } = await run(makeArgs([issue(41)], {
    spec: { markers: [{ type: 'blocker', data, createdAt: '2026-01-01T00:00:00Z', commentId: 1 }] },
  }))
  assert.equal(calls.length, 0)
  assert.equal(out.stopped, 'graph-blocker')
  assert.deepEqual(out.graphBlocker, data)
})

test('an agent returning null marks the issue interrupted and stops with usage-limit', async () => {
  const { out, labels } = await run(makeArgs([issue(41), issue(42)]), label => (label === '#41 implementer r0' ? null : undefined))
  assert.equal(labels[labels.length - 1], '#41 implementer r0', 'no agent starts after the null result')
  assert.equal(out.stopped, 'usage-limit')
  const r = byNum(out)
  assert.equal(r[41].outcome, 'interrupted')
  assert.equal(r[42].outcome, 'waiting')
  assert.match(r[42].reason, /usage-limit/)
  assert.ok(out.notes.some(n => n.includes('#41 implementer r0')))
})

test('a null reviewer result inside parallel also stops the run', async () => {
  const { out } = await run(makeArgs([issue(41)]), label => (label.startsWith('#41 review:') ? null : undefined))
  assert.equal(out.stopped, 'usage-limit')
  assert.equal(byNum(out)[41].outcome, 'interrupted')
})

test('stops at the agent-count limit', async () => {
  const many = Array.from({ length: 140 }, (_, i) => issue(1000 + i))
  const { out, calls, logs } = await run(makeArgs(many))
  assert.equal(calls.length, 900)
  assert.equal(out.agentCount, 900)
  assert.equal(out.stopped, 'agent-limit')
  const outcomes = out.issues.map(i => i.outcome)
  const firstNotDone = outcomes.findIndex(o => o !== 'done')
  assert.equal(outcomes[firstNotDone], 'interrupted')
  assert.ok(outcomes.slice(firstNotDone + 1).every(o => o === 'waiting'))
  assert.ok(out.notes.some(n => n.startsWith('STOPPED: 900 agents started')))
  assert.ok(logs.some(l => l.startsWith('STOPPED')))
})

test('every agent label matches the contract format', async () => {
  const fail = { passed: false, headCommit: 'bad', commandsRun: [], failures: 'x', mainCheckoutClean: true, testDiffOk: true }
  let reviewCalls = 0
  const finding = { id: 'build:fallback-reviewer-r1-1', severity: 'high', title: 't', detail: 'd' }
  const all = []
  const runs = [
    run(makeArgs([issue(41), issue(42), issue(43, { blockedBy: [41, 42] })])),
    run(makeArgs([issue(41), issue(42, { blockedBy: [41] })], { humanInLoop: false })),
    run(makeArgs([issue(41), issue(42)]), l => (l.startsWith('#41 verifier') ? fail : undefined)),
    // Review rounds with findings, repairs inside rounds, and blocker 5.
    run(makeArgs([issue(41)]), (l) => {
      if (l.startsWith('#41 review:')) {
        reviewCalls++
        return { findings: [{ ...finding, id: `build:fallback-reviewer-r${reviewCalls}-1` }], verdicts: [], judgmentCalls: [], recommendations: [], blocker: null }
      }
      if (l === '#41 implementer r1') return { headCommit: 'h', summary: 's', testChanges: [], replies: [{ finding: finding.id, action: 'fixed', text: 'ok' }], judgmentCalls: [], recommendations: [], blocker: null }
      if (l === '#41 verifier r1 c1') return fail
      return undefined
    }),
    // Rerun: recheck.
    run(makeArgs([
      issue(41, { state: 'OPEN', status: 'merged', pr: { number: 141, state: 'MERGED', merged: true, baseRefName: 'main', headRefName: 'build/40-41', headRefOid: 'p41', findings: [] } }),
      issue(42, { blockedBy: [41], status: 'done', markers: [{ type: 'done', data: { issue: 42, pr: 142 }, createdAt: '2026-01-02T00:00:00Z' }], branch: { name: 'build/40-42', exists: true, oid: 'o42' }, pr: { number: 142, state: 'OPEN', merged: false, baseRefName: 'build/40-41', headRefName: 'build/40-42', headRefOid: 'o42', findings: [] } }),
    ], { isRerun: true, spec: { decisions: [{ body: 'Decision: A', createdAt: '2026-01-03T00:00:00Z', author: 'u' }] } })),
  ]
  for (const r of await Promise.all(runs)) all.push(...r.labels)
  for (const want of ['#spec recheck', '#41 implementer r1', '#41 verifier r1 c1', '#41 implementer r1 c1', '#41 git r1', '#41 merger']) {
    assert.ok(all.includes(want), `covers ${want}`)
  }
  for (const l of all) assert.match(l, LABEL_RE, `label "${l}"`)
})

// ---------- sub-issue closed by hand with no merged PR: blocker type 8 ----------

const closed = (n, extra = {}) => issue(n, { state: 'CLOSED', status: 'closed', ...extra })
const b8 = { issue: 41, type: 8, scope: 'branch', question: 'Issue #41 was closed by hand.', options: ['A) Treat it as done', 'B) Reopen it and build it', 'C) Other'], recommendation: 'A' }
const b8Marker = { type: 'blocker', data: b8, createdAt: '2026-01-01T00:00:00Z', commentId: 1 }
const decision = body => ({ body, createdAt: '2026-01-02T00:00:00Z', author: 'u' })
const answeredClosed = (n, body) => closed(n, { status: 'answered', markers: [b8Marker], decisions: [decision(body)] })
const reading = action => ({ action, reason: `read as ${action}` })

test('a closed issue gets a type-8 blocker; it and its dependents pause, others keep going', async () => {
  const { out, calls, labels } = await run(makeArgs([closed(41), issue(42, { blockedBy: [41] }), issue(43, { blockedBy: [42] }), issue(44)]))
  const mine = labels.filter(l => l.startsWith('#41 '))
  assert.deepEqual(mine, ['#41 git'], 'no agent builds it; one step posts the blocker')
  const posted = callFor(calls, '#41 git').prompt
  assert.match(posted, /issue #41 \(`gh issue comment`\)/)
  assert.match(posted, /build:blocker \{"issue":41,"type":8,"scope":"branch"/)
  assert.match(posted, /closed by hand/)
  const r = byNum(out)
  assert.equal(r[41].outcome, 'blocked')
  assert.equal(r[41].blocker.type, 8)
  assert.equal(r[41].blocker.scope, 'branch')
  assert.ok(r[41].blocker.options.length >= 3)
  assert.match(r[41].blocker.options.join(' '), /treat it as done/i)
  assert.match(r[41].blocker.options.join(' '), /reopen/i)
  assert.ok(r[41].blocker.recommendation)
  assert.deepEqual(r[42].waitingOn, [41])
  assert.deepEqual(r[43].waitingOn, [41])
  assert.equal(r[44].outcome, 'done', 'an unrelated issue keeps going')
  assert.equal(out.stopped, null)
})

test('an unanswered type-8 blocker is not posted again on a rerun', async () => {
  const { out, labels } = await run(makeArgs([closed(41, { status: 'blocked', markers: [b8Marker] }), issue(42, { blockedBy: [41] })], { isRerun: true }))
  assert.ok(!labels.some(l => l.startsWith('#41 ')), 'no agent touches #41')
  const r = byNum(out)
  assert.equal(r[41].outcome, 'blocked')
  assert.deepEqual(r[41].blocker, b8)
  assert.deepEqual(r[42].waitingOn, [41])
})

test('answered "treat as done": records it, and dependents continue from main', async () => {
  const { out, calls, labels } = await run(
    makeArgs([answeredClosed(41, 'Decision: A, it was done in another PR'), issue(42, { blockedBy: [41] })], { isRerun: true }),
    l => (l === '#41 decision-reader' ? reading('treat-as-done') : undefined),
  )
  const reader = callFor(calls, '#41 decision-reader')
  assert.equal(reader.opts.model, 'sonnet')
  assert.match(reader.prompt, /Decision: A, it was done in another PR/, 'decision copied word for word')
  assert.match(reader.prompt, /Issue #41 was closed by hand\./, 'the reader sees the question it answers')
  assert.ok(!labels.includes('#41 scout'), 'not built')
  const git = calls.filter(c => c.label === '#41 git').map(c => c.prompt)
  assert.equal(git.length, 1)
  assert.match(git[0], /build:done \{"issue":41,"pr":null\}/)
  assert.doesNotMatch(git[0], /gh issue reopen/)
  const r = byNum(out)
  assert.equal(r[41].outcome, 'closed-done')
  assert.equal(r[41].pr, null)
  assert.equal(r[42].outcome, 'done')
  assert.equal(r[42].base, 'main', 'nothing to stack on')
})

test('a closed issue already treated as done starts no agents for it', async () => {
  const done = { type: 'done', data: { issue: 41, pr: null }, createdAt: '2026-01-03T00:00:00Z' }
  const { out, labels } = await run(makeArgs([
    closed(41, { status: 'closed-done', markers: [b8Marker, done], decisions: [decision('Decision: A')] }),
    issue(42, { blockedBy: [41] }),
  ], { isRerun: true }))
  assert.ok(!labels.some(l => l.startsWith('#41 ')))
  assert.equal(byNum(out)[41].outcome, 'closed-done')
  assert.equal(byNum(out)[42].outcome, 'done')
})

test('answered "build": reopens the issue and works it normally', async () => {
  const { out, calls, labels } = await run(
    makeArgs([answeredClosed(41, 'Decision: B'), issue(42, { blockedBy: [41] })], { isRerun: true }),
    l => (l === '#41 decision-reader' ? reading('build') : undefined),
  )
  const reopen = labels.indexOf('#41 git')
  assert.ok(reopen > labels.indexOf('#41 decision-reader') && reopen < labels.indexOf('#41 scout'))
  assert.match(calls[reopen].prompt, /gh issue reopen 41 -R acme\/shop/)
  assert.match(callFor(calls, '#41 scout').prompt, /Decision: B/, 'the decision still reaches the agents')
  const r = byNum(out)
  assert.equal(r[41].outcome, 'done')
  assert.equal(r[41].pr, 141)
  assert.equal(r[42].outcome, 'done')
  assert.equal(r[42].base, 'build/40-41')
})

test('answered but unclear: posts a new type-8 blocker', async () => {
  const { out, calls, labels } = await run(
    makeArgs([answeredClosed(41, 'Decision: hmm, not sure'), issue(42, { blockedBy: [41] })], { isRerun: true }),
    l => (l === '#41 decision-reader' ? reading('unclear') : undefined),
  )
  assert.ok(!labels.includes('#41 scout'))
  const posted = callFor(calls, '#41 git').prompt
  assert.match(posted, /build:blocker \{"issue":41,"type":8,"scope":"branch"/)
  assert.match(posted, /read as unclear/, 'says why the answer was unclear')
  const r = byNum(out)
  assert.equal(r[41].outcome, 'blocked')
  assert.equal(r[41].blocker.type, 8)
  assert.deepEqual(r[42].waitingOn, [41])
})

test('humanInLoop false: the final PR lists a closed issue treated as done, not "PR #null"', async () => {
  const { out, calls } = await run(
    makeArgs([answeredClosed(41, 'Decision: A'), issue(42, { blockedBy: [41] })], { humanInLoop: false, isRerun: true }),
    l => (l === '#41 decision-reader' ? reading('treat-as-done') : undefined),
  )
  assert.equal(out.finalPr, 900)
  const final = calls[calls.length - 1].prompt
  assert.doesNotMatch(final, /PR #null|skipped/)
  assert.match(final, /- #41 → closed by hand, treated as done \(no PR\)/)
  assert.match(final, /- #42 → PR #142/)
})

test('humanInLoop false: no final PR while a closed issue waits on its blocker', async () => {
  const { out } = await run(makeArgs([closed(41), issue(42)], { humanInLoop: false }))
  assert.equal(out.finalPr, null)
  assert.equal(byNum(out)[41].outcome, 'blocked')
})

// ---------- fix: resume at the code-pushed step ----------

test('resume at code-pushed: the verifier diffs tests from the last verified commit', async () => {
  const markers = [
    { type: 'progress', data: { issue: 41, step: 'tests-committed', round: 0, commit: 'tests41', pr: null }, createdAt: '2026-01-01T00:00:00Z' },
    { type: 'progress', data: { issue: 41, step: 'code-pushed', round: 0, commit: 'pushed41', pr: null }, createdAt: '2026-01-01T01:00:00Z' },
  ]
  const { out, calls, labels } = await run(makeArgs([issue(41, {
    status: 'interrupted', markers, branch: { name: 'build/40-41', exists: true, oid: 'pushed41' },
  })]))
  assert.ok(!labels.includes('#41 test-writer') && !labels.includes('#41 implementer r0'), 'skips finished steps')
  const v = callFor(calls, '#41 verifier r0 c1').prompt
  // Test changes up to pushed41 already passed a verifier (with their reasons) before the push.
  assert.match(v, /git -C \/w\/shop\.build-40 diff --stat pushed41 HEAD/)
  assert.doesNotMatch(v, /diff --stat tests41/)
  // Implementers still must not change the test commit itself.
  assert.equal(byNum(out)[41].outcome, 'done')
})

test('resume at review-round: the verifier diffs from that round\'s verified commit', async () => {
  const markers = [
    { type: 'progress', data: { issue: 41, step: 'tests-committed', round: 0, commit: 'tests41', pr: null }, createdAt: '2026-01-01T00:00:00Z' },
    { type: 'progress', data: { issue: 41, step: 'code-pushed', round: 0, commit: 'pushed41', pr: null }, createdAt: '2026-01-01T01:00:00Z' },
    { type: 'progress', data: { issue: 41, step: 'pr-opened', round: 0, commit: 'pushed41', pr: 141 }, createdAt: '2026-01-01T01:01:00Z' },
    { type: 'progress', data: { issue: 41, step: 'review-round', round: 1, commit: 'round1', pr: 141 }, createdAt: '2026-01-01T02:00:00Z' },
  ]
  const finding = { id: 'build:fallback-reviewer-r2-1', severity: 'low', title: 't', detail: 'd' }
  let reviews = 0
  const { calls } = await run(makeArgs([issue(41, {
    status: 'interrupted', markers, branch: { name: 'build/40-41', exists: true, oid: 'round1' },
    pr: { number: 141, state: 'OPEN', merged: false, baseRefName: 'main', headRefName: 'build/40-41', headRefOid: 'round1', findings: [] },
  })]), (l) => {
    if (l.startsWith('#41 review:') && ++reviews === 1) return { findings: [finding], verdicts: [], judgmentCalls: [], recommendations: [], blocker: null }
    if (l === '#41 implementer r2') return { headCommit: 'h', summary: 's', testChanges: [], replies: [{ finding: finding.id, action: 'fixed', text: 'ok' }], judgmentCalls: [], recommendations: [], blocker: null }
    return undefined
  })
  assert.match(callFor(calls, '#41 implementer r2').prompt, /Don't change the test commit tests41/)
  assert.match(callFor(calls, '#41 verifier r2 c1').prompt, /diff --stat round1 HEAD/)
})

test('an argued finding that still stands is shown to the implementer as argued before', async () => {
  const finding = { id: 'build:fallback-reviewer-r1-1', severity: 'medium', title: 'naming', detail: 'd' }
  const c = { judgmentCalls: [], recommendations: [], blocker: null }
  const { calls, out } = await run(makeArgs([issue(41)]), (l) => {
    if (l === '#41 review:build:fallback-reviewer r1') return { findings: [finding], verdicts: [], ...c }
    if (l === '#41 review:build:fallback-reviewer r2') return { findings: [], verdicts: [{ finding: finding.id, verdict: 'stands' }], ...c }
    if (l === '#41 review:build:fallback-reviewer r3') return { findings: [], verdicts: [{ finding: finding.id, verdict: 'withdrawn' }], ...c }
    if (l.startsWith('#41 implementer r') && !l.endsWith('r0')) return { headCommit: 'h', summary: 's', testChanges: [], replies: [{ finding: finding.id, action: 'argued', text: 'it is fine' }], ...c }
    return undefined
  })
  assert.doesNotMatch(callFor(calls, '#41 implementer r1').prompt, /You argued this before/)
  assert.match(callFor(calls, '#41 implementer r2').prompt, /You argued this before and the reviewer said it still stands/)
  assert.equal(byNum(out)[41].outcome, 'done')
})

// ---------- a parent PR merges during the run ----------

// #41's PR is open at the start. #42 is stacked on it and crashed after its push.
function stackedOnOpen(branch42 = true) {
  return [
    issue(41, {
      status: 'done', markers: [{ type: 'done', data: { issue: 41, pr: 141 }, createdAt: '2026-01-01T00:00:00Z' }],
      branch: { name: 'build/40-41', exists: true, oid: 'p41' },
      pr: { number: 141, state: 'OPEN', merged: false, baseRefName: 'main', headRefName: 'build/40-41', headRefOid: 'p41', findings: [] },
    }),
    branch42
      ? issue(42, {
        blockedBy: [41], status: 'interrupted',
        markers: [
          { type: 'progress', data: { issue: 42, step: 'tests-committed', round: 0, commit: 'tests42', pr: null }, createdAt: '2026-01-01T00:00:00Z' },
          { type: 'progress', data: { issue: 42, step: 'code-pushed', round: 0, commit: 'pushed42', pr: null }, createdAt: '2026-01-01T01:00:00Z' },
        ],
        branch: { name: 'build/40-42', exists: true, oid: 'pushed42' },
        pr: { number: 142, state: 'OPEN', merged: false, baseRefName: 'build/40-41', headRefName: 'build/40-42', headRefOid: 'pushed42', findings: [] },
      })
      : issue(42, { blockedBy: [41] }),
  ]
}
const parentCheck = res => (l, prompt) => (prompt.includes('Check the parent PRs') ? res : undefined)

test('parent merged with a merge commit: the stacked branch is used as is, no rebase', async () => {
  const { out, calls, labels } = await run(makeArgs(stackedOnOpen(), { isRerun: true }), parentCheck({ merged: [41], badMerges: [], error: '' }))
  assert.ok(!labels.some(l => l.endsWith('rebaser')))
  assert.match(callFor(calls, '#42 verifier r0 c1').prompt, /diff --stat pushed42 HEAD/)
  assert.equal(byNum(out)[41].outcome, 'merged')
  assert.equal(byNum(out)[42].outcome, 'done')
})

test('parent squash-merged under an existing branch: the issue stops with a blocker', async () => {
  const { out, calls, labels } = await run(makeArgs(stackedOnOpen(), { isRerun: true, pluginRoot: '/p/build' }), parentCheck({ merged: [41], badMerges: [41], error: '' }))
  assert.match(callFor(calls, '#42 git').prompt, /node \/p\/build\/scripts\/check-parents\.mjs --repo acme\/shop --branch build\/40-42 --parents 41:141/)
  assert.ok(!labels.includes('#42 scout'), 'no work on the branch')
  const r = byNum(out)[42]
  assert.equal(r.outcome, 'blocked')
  assert.equal(r.blocker.type, 1)
  assert.match(r.blocker.question, /PR #141 \(issue #41\) was merged with squash or rebase/)
  const posted = calls.filter(c => c.label === '#42 git')[1].prompt
  assert.match(posted, /build:blocker \{"issue":42,"type":1/)
})

test('parent squash-merged before the issue has a branch: it starts from main', async () => {
  // The script finds no branch, so it reports no bad merge.
  const { out, calls } = await run(makeArgs(stackedOnOpen(false), { isRerun: true }), parentCheck({ merged: [41], badMerges: [], error: '' }))
  assert.match(callFor(calls, '#42 test-writer').prompt, /origin\/main/)
  assert.equal(byNum(out)[42].base, 'main')
})

test('a failed parent check stops the issue with a blocker', async () => {
  const { out, labels } = await run(makeArgs(stackedOnOpen(), { isRerun: true }), parentCheck({ merged: [], badMerges: [], error: 'gh: HTTP 502' }))
  assert.ok(!labels.includes('#42 scout'))
  assert.match(byNum(out)[42].blocker.question, /Checking the parent PRs of issue #42 failed: gh: HTTP 502/)
})
