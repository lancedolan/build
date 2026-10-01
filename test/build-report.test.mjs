import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildComment, buildSummary, parseReportFile, seedLinesFromComment, seedReportFile,
  postComment, existingAgentRows, statusLine, outcomes, main,
} from '../scripts/build-report.mjs'
import { readState } from '../scripts/read-state.mjs'
import { parseMarkers } from '../scripts/lib/markers.mjs'
import { makeGh } from '../scripts/lib/gh.mjs'
import { loadJson, clone, fixtureGh, memFs } from './helpers.mjs'

const fx = () => clone(loadJson('gh-spec40.json'))
const state40 = async () => readState(fixtureGh(fx()), { repo: 'acme/shop', spec: 40 })
const existingBody = () => fx().spec.data.repository.issue.comments.nodes[0].body

const blocker43 = {
  issue: 43, type: 3, scope: 'branch',
  question: "needs a new charting library the spec didn't name.",
  options: ['A) add recharts', 'B) draw with plain SVG'],
  recommendation: 'B',
}
// The run from issue #1's example usage, step 4.
const exampleResult = {
  issues: [
    { number: 41, outcome: 'done', pr: 46, base: 'main', waitingOn: [], blocker: null },
    { number: 42, outcome: 'done', pr: 47, base: 'build/40-41', waitingOn: [], blocker: null },
    { number: 43, outcome: 'blocked', pr: null, base: null, waitingOn: [], blocker: blocker43 },
    { number: 44, outcome: 'waiting', pr: null, base: null, waitingOn: [43], blocker: null },
    { number: 45, outcome: 'waiting', pr: null, base: null, waitingOn: [43], blocker: null },
  ],
  graphBlocker: null, stopped: null, startOid: 'bbb222', finalPr: null, agentCount: 20, notes: [],
}

test('chat summary matches the format in issue #1', async () => {
  const summary = buildSummary({ state: await state40(), result: exampleResult })
  assert.equal(summary, [
    '#41 done → PR #46',
    '#42 done → PR #47 (stacked on #46)',
    "#43 BLOCKED (branch): needs a new charting library the spec didn't name.",
    '    Options: A) add recharts  B) draw with plain SVG. Recommend B.',
    '#44, #45 waiting on #43',
    'Report: comment on #40',
  ].join('\n'))
})

test('summary: usage-limit stop, final PR, and graph blocker lines', async () => {
  const state = await state40()
  const stopped = { ...exampleResult, stopped: 'usage-limit' }
  assert.match(buildSummary({ state, result: stopped, resetsAt: '3pm' }), /Stopped: usage limit, resets at 3pm\nReport: comment on #40$/)
  const fin = { ...exampleResult, finalPr: 60 }
  assert.match(buildSummary({ state, result: fin, commentUrl: 'http://c' }), /Final PR #60: build\/40-spec → main\nReport: comment on #40 \(http:\/\/c\)$/)
  const graph = { ...exampleResult, graphBlocker: { type: 4, scope: 'graph', question: 'tests fail on main', options: ['A) fix main'], recommendation: 'A' }, stopped: 'graph-blocker' }
  assert.match(buildSummary({ state, result: graph }), /^WHOLE GRAPH BLOCKED \(type 4\): tests fail on main\n {4}Options: A\) fix main\. Recommend A\./)
})

test('comment: markers, sections, judgment calls, argued-away findings', async () => {
  const state = await state40()
  const reportEntries = parseReportFile([
    '- #43 scout: judgment: chart lives in src/charts',
    '- #41 implementer: judgment: named the helper formatTotal',
    '- #41 implementer: judgment: named the helper formatTotal',
    '- #spec recheck: recommendation: split #44',
    '- #42 test-writer: recommendation: add an e2e framework',
    '  that can check styling',
  ].join('\n'))
  const body = buildComment({ state, result: exampleResult, agents: [], reportEntries, existingBody: null, humanInLoop: true })
  const lines = body.split('\n')
  assert.equal(lines[0], '<!-- build:report -->')
  const run = parseMarkers(body).find(m => m.type === 'run').data
  assert.deepEqual(run, { humanInLoop: true, startOid: 'bbb222', stopped: null, resetsAt: null })
  for (const h of ['## Build report for #40', '### Issues', '### Blockers', '### Judgment calls', '### Recommendations', '### Findings argued away', '### Agents']) {
    assert.ok(lines.includes(h), `missing ${h}`)
  }
  assert.ok(body.includes('Status: blocked: 1 issue needs a decision'))
  assert.ok(body.includes('- #42 done → PR #47 (stacked on #46)'))
  assert.ok(body.includes('**#43: blocker type 3'))
  assert.ok(body.includes('Waiting on it: #44, #45'))
  const judg = body.split('### Judgment calls')[1].split('###')[0].trim().split('\n')
  assert.deepEqual(judg, ['- #41 implementer: named the helper formatTotal', '- #43 scout: chart lives in src/charts'])
  const recs = body.split('### Recommendations')[1].split('###')[0].trim().split('\n')
  assert.deepEqual(recs, ['- spec recheck: split #44', '- #42 test-writer: add an e2e framework that can check styling'])
  const argued = body.split('### Findings argued away')[1].split('###')[0].trim()
  assert.match(argued, /^- PR #47 \(#42\), build:fallback-reviewer: rounding \(\[argument\]\(https:\/\/github.com\/acme\/shop\/issues\/x#issuecomment-\d+\)\)$/)
})

test('editing in place keeps earlier agent rows and skips agents already listed', async () => {
  const state = await state40()
  const agents = [
    { agentId: 'old0000001zzz', issue: '41', role: 'scout', round: null, cycle: null, contextTokens: 1 },
    { agentId: 'new0000003aa', issue: '43', role: 'scout', round: null, cycle: null, contextTokens: 15000 },
    { agentId: 'new0000004bb', issue: '42', role: 'verifier', round: 1, cycle: 2, contextTokens: 9000 },
    { agentId: 'new0000005cc', issue: 'spec', role: 'recheck', round: null, cycle: null, contextTokens: null },
  ]
  const body = buildComment({ state, result: exampleResult, agents, reportEntries: [], existingBody: existingBody() })
  assert.deepEqual(existingAgentRows(body), [
    '| #41 | scout |  | 12,000 |',
    '| #41 | implementer | r0 | 40,500 |',
    '| #43 | scout |  | 15,000 |',
    '| #42 | verifier | r1 c2 | 9,000 |',
    '| spec | recheck |  | ? |',
  ])
  const ids = parseMarkers(body).find(m => m.type === 'agent-ids').data
  assert.deepEqual(ids, ['old0000001', 'old0000002', 'new0000003', 'new0000004', 'new0000005'])

  // Building again from the new body with the same agents adds nothing.
  const again = buildComment({ state, result: exampleResult, agents, reportEntries: [], existingBody: body })
  assert.deepEqual(existingAgentRows(again), existingAgentRows(body))
})

test('humanInLoop and startOid fall back to the last run', async () => {
  const state = await state40()
  const body = buildComment({ state, result: { ...exampleResult, startOid: null }, agents: [], reportEntries: [], existingBody: null })
  const run = parseMarkers(body).find(m => m.type === 'run').data
  assert.equal(run.humanInLoop, true)
  assert.equal(run.startOid, 'aaa111')
})

test('status line: usage limit with reset time, agent limit, done, incomplete', async () => {
  const state = await state40()
  assert.equal(statusLine(state, { ...exampleResult, stopped: 'usage-limit' }, '3:00 PM'), 'stopped: usage limit, resets at 3:00 PM')
  assert.equal(statusLine(state, { ...exampleResult, stopped: 'usage-limit' }), 'stopped: usage limit, resets at unknown')
  assert.match(statusLine(state, { ...exampleResult, stopped: 'agent-limit' }), /1,000-agents-per-run cap/)
  const allDone = { ...exampleResult, issues: exampleResult.issues.map(i => ({ ...i, outcome: 'done', blocker: null, waitingOn: [] })) }
  assert.equal(statusLine(state, allDone), 'done')
  const oneInterrupted = { ...allDone, issues: [...allDone.issues.slice(0, 4), { ...allDone.issues[4], outcome: 'interrupted' }] }
  assert.equal(statusLine(state, oneInterrupted), 'incomplete: 1 issue not finished')
  const body = buildComment({ state, result: { ...exampleResult, stopped: 'usage-limit' }, agents: [], reportEntries: [], existingBody: null, resetsAt: '3:00 PM' })
  assert.ok(body.includes('Status: stopped: usage limit, resets at 3:00 PM'))
  assert.equal(parseMarkers(body).find(m => m.type === 'run').data.resetsAt, '3:00 PM')
})

test('a closed issue treated as done counts as finished', async () => {
  const state = await state40()
  const r = { ...exampleResult, issues: exampleResult.issues.map(i => ({ ...i, outcome: i.number === 43 ? 'closed-done' : 'done', pr: i.number === 43 ? null : i.pr, blocker: null, waitingOn: [] })) }
  assert.equal(statusLine(state, r), 'done')
  assert.match(buildSummary({ state, result: r }), /^#43 closed by hand, treated as done \(no PR\)$/m)
  assert.doesNotMatch(buildSummary({ state, result: r }), /skipped/)
})

test('a closed-issue blocker (type 8) shows like any other blocker', async () => {
  const state = await state40()
  const b8 = { issue: 43, type: 8, scope: 'branch', question: 'Issue #43 was closed by hand with no merged PR. How should /build handle it?', options: ['A) Treat it as done', 'B) Reopen it and build it', 'C) Other'], recommendation: 'A' }
  const r = { ...exampleResult, issues: exampleResult.issues.map(i => (i.number === 43 ? { ...i, blocker: b8 } : i)) }
  assert.match(buildSummary({ state, result: r }), /#43 BLOCKED \(branch\): Issue #43 was closed by hand[^\n]*\n {4}Options: A\) Treat it as done  B\) Reopen it and build it  C\) Other\. Recommend A\.\n#44, #45 waiting on #43/)
  const body = buildComment({ state, result: r, agents: [], reportEntries: [], existingBody: null })
  assert.ok(body.includes('**#43: blocker type 8 (the sub-issue was closed by hand with no merged PR), branch scope**'))
  assert.ok(body.includes('Waiting on it: #44, #45'))
})

test('outcomes fall back to state status when the workflow result is missing', async () => {
  const state = await state40()
  state.issues.find(i => i.number === 43).status = 'closed'
  const o = Object.fromEntries(outcomes(state, null).map(x => [x.number, x.outcome]))
  assert.deepEqual(o, { 41: 'merged', 42: 'done', 43: 'waiting', 44: 'interrupted', 45: 'interrupted' })
  assert.match(outcomes(state, null).find(x => x.number === 43).reason, /closed by hand/)
  state.issues.find(i => i.number === 43).status = 'closed-done'
  assert.equal(outcomes(state, null).find(x => x.number === 43).outcome, 'closed-done')
})

test('seed lines come back from the comment sections', () => {
  assert.deepEqual(seedLinesFromComment(existingBody()), [
    '- #41 implementer: judgment: named the helper formatTotal',
    '- #42 test-writer: judgment: skipped a styling test, no e2e framework',
    '- #42 test-writer: recommendation: add an e2e framework',
  ])
})

test('seedReportFile writes only when the file is missing', () => {
  const fs = memFs()
  assert.deepEqual(seedReportFile('/r/report.md', existingBody(), fs), { seeded: true, lines: 3 })
  assert.equal(parseReportFile(fs.read('/r/report.md')).length, 3)
  assert.deepEqual(seedReportFile('/r/report.md', existingBody(), fs), { seeded: false, lines: 0 })
  const empty = memFs()
  assert.deepEqual(seedReportFile('/r/report.md', null, empty), { seeded: true, lines: 0 })
  assert.equal(empty.read('/r/report.md'), '')
})

test('a round trip through the comment keeps the report entries', async () => {
  const state = await state40()
  const entries = parseReportFile('- #41 implementer: judgment: a\n- #42 scout: recommendation: b\n')
  const body = buildComment({ state, result: exampleResult, agents: [], reportEntries: entries, existingBody: null })
  assert.deepEqual(parseReportFile(seedLinesFromComment(body).join('\n')), entries)
})

function recordingGh(handler) {
  const calls = []
  return { calls, gh: makeGh((args, opts) => { calls.push({ args, body: opts.input && JSON.parse(opts.input).body }); return handler(args) }) }
}

test('postComment edits in place when a comment id exists', () => {
  const { gh, calls } = recordingGh(() => ({ status: 0, stdout: '{"id": 9001, "html_url": "u1"}', stderr: '' }))
  assert.deepEqual(postComment(gh, { repo: 'acme/shop', spec: 40, commentId: 9001, body: 'B' }), { commentId: 9001, url: 'u1' })
  assert.deepEqual(calls.map(c => c.args.slice(0, 4)), [['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/9001']])
  assert.equal(calls[0].body, 'B')
})

test('postComment creates a comment when there is no id, or the old one was deleted', () => {
  let { gh, calls } = recordingGh(() => ({ status: 0, stdout: '{"id": 5, "html_url": "u5"}', stderr: '' }))
  assert.deepEqual(postComment(gh, { repo: 'acme/shop', spec: 40, commentId: null, body: 'B' }), { commentId: 5, url: 'u5' })
  assert.deepEqual(calls.map(c => c.args[1]), ['repos/acme/shop/issues/40/comments'])

  ;({ gh, calls } = recordingGh(args => (args[1] === '-X'
    ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
    : { status: 0, stdout: '{"id": 6, "html_url": "u6"}', stderr: '' })))
  assert.deepEqual(postComment(gh, { repo: 'acme/shop', spec: 40, commentId: 9001, body: 'B' }), { commentId: 6, url: 'u6' })
  assert.equal(calls.length, 2)
})

test('postComment does not create a second comment on other edit errors', () => {
  const { gh, calls } = recordingGh(() => ({ status: 1, stdout: '', stderr: 'HTTP 403 forbidden' }))
  assert.throws(() => postComment(gh, { repo: 'acme/shop', spec: 40, commentId: 9001, body: 'B' }), /Couldn't edit report comment 9001/)
  assert.equal(calls.length, 1)
})

test('main build --post: fetches the existing comment, edits it, prints the summary', async () => {
  const state = await state40()
  const fs = memFs({
    '/s.json': JSON.stringify(state),
    '/res.json': JSON.stringify(exampleResult),
    '/agents.json': JSON.stringify([{ agentId: 'new0000009', issue: '43', role: 'scout', contextTokens: 5 }]),
    '/r/report.md': '- #43 scout: judgment: x\n',
  })
  const { gh, calls } = recordingGh(args => {
    if (args[1] === 'repos/acme/shop/issues/comments/9001') return { status: 0, stdout: JSON.stringify({ body: existingBody() }), stderr: '' }
    if (args[2] === 'PATCH') return { status: 0, stdout: '{"id": 9001, "html_url": "https://c"}', stderr: '' }
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  })
  const { output } = await main(['build', '--state', '/s.json', '--report-file', '/r/report.md', '--result', '/res.json', '--agents', '/agents.json', '--post'], { fs, gh })
  assert.equal(output.commentId, 9001)
  assert.match(output.summary, /Report: comment on #40 \(https:\/\/c\)$/)
  assert.ok(output.comment.includes('| #41 | implementer | r0 | 40,500 |'), 'old rows kept')
  assert.ok(output.comment.includes('| #43 | scout |  | 5 |'))
  assert.equal(calls.filter(c => c.args[2] === 'PATCH').length, 1)
})

test('main seed and argument errors', async () => {
  const state = await state40()
  const fs = memFs({ '/s.json': JSON.stringify(state), '/e.md': existingBody() })
  const gh = makeGh(() => assert.fail('no gh call expected'))
  assert.deepEqual((await main(['seed', '--state', '/s.json', '--report-file', '/r/report.md', '--existing', '/e.md'], { fs, gh })).output, { seeded: true, lines: 3 })
  await assert.rejects(main(['nope', '--state', '/s.json', '--report-file', '/x'], { fs, gh }), /seed or build/)
  await assert.rejects(main(['build', '--report-file', '/x'], { fs, gh }), /--state is required/)
})

test('a huge agent table is cut to fit the GitHub comment limit', async () => {
  const state = await state40()
  const agents = Array.from({ length: 3000 }, (_, i) => ({ agentId: `id${String(i).padStart(8, '0')}`, issue: '41', role: 'verifier', round: 1, cycle: 1, contextTokens: 123456 }))
  const body = buildComment({ state, result: exampleResult, agents, reportEntries: [], existingBody: null })
  assert.ok(body.length <= 65000)
  assert.match(body, /older rows were dropped/)
})
