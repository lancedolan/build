import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMarkers, formatMarker, stripMarkers, isDecision, isReportComment,
  lastMarker, markersFromComments, decisionsFromComments, computeFindings,
} from '../scripts/lib/markers.mjs'

test('formatMarker and parseMarkers round trip, including text that would close the comment', () => {
  const data = { issue: 41, question: 'is a --> b allowed?', options: ['A) x', 'B) y'], n: null }
  const text = formatMarker('blocker', data)
  assert.ok(!text.slice(0, -3).includes('-->'), 'JSON must not contain the closing -->')
  assert.deepEqual(parseMarkers(text), [{ type: 'blocker', data }])
})

test('parseMarkers finds several markers in one comment, in order', () => {
  const body = `Merged.\n${formatMarker('progress', { step: 'merged' })}\n${formatMarker('done', { issue: 4, pr: 9 })}`
  assert.deepEqual(parseMarkers(body).map(m => m.type), ['progress', 'done'])
})

test('parseMarkers ignores broken JSON and other HTML comments', () => {
  const body = '<!-- build:done {not json} -->\n<!-- just a note -->\n<!-- build:done {"issue":1,"pr":2} -->'
  assert.deepEqual(parseMarkers(body), [{ type: 'done', data: { issue: 1, pr: 2 } }])
})

test('the report header parses with null data', () => {
  assert.deepEqual(parseMarkers('<!-- build:report -->'), [{ type: 'report', data: null }])
  assert.ok(isReportComment('  <!-- build:report -->\n## Build report'))
  assert.ok(!isReportComment('text\n<!-- build:report -->'))
})

test('stripMarkers removes markers only', () => {
  assert.equal(stripMarkers(`Fixed it.\n${formatMarker('reply', { finding: 'x' })}`), 'Fixed it.')
})

test('isDecision needs Decision: at the start after trimming', () => {
  assert.ok(isDecision('  Decision: B'))
  assert.ok(!isDecision('My Decision: B'))
  assert.ok(!isDecision('decision: B'))
})

test('lastMarker picks the newest by createdAt, and a later equal time wins', () => {
  const ms = [
    { type: 'progress', data: { step: 'a' }, createdAt: '2026-01-02T00:00:00Z' },
    { type: 'progress', data: { step: 'b' }, createdAt: '2026-01-01T00:00:00Z' },
    { type: 'done', data: {}, createdAt: '2026-01-03T00:00:00Z' },
    { type: 'progress', data: { step: 'c' }, createdAt: '2026-01-02T00:00:00Z' },
  ]
  assert.equal(lastMarker(ms, 'progress').data.step, 'c')
  assert.equal(lastMarker(ms, 'progress', m => m.data.step !== 'c').data.step, 'a')
  assert.equal(lastMarker(ms, 'blocker'), null)
})

test('markersFromComments skips the report header and keeps comment ids', () => {
  const comments = [
    { databaseId: 5, createdAt: 't1', body: `<!-- build:report -->\n${formatMarker('run', { humanInLoop: true })}` },
    { databaseId: 6, createdAt: 't2', body: formatMarker('done', { issue: 1, pr: 2 }) },
  ]
  assert.deepEqual(markersFromComments(comments).map(m => [m.type, m.commentId]), [['run', 5], ['done', 6]])
})

test('decisionsFromComments copies the body word for word', () => {
  const comments = [{ body: 'Decision: B\n\nbecause SVG is enough', createdAt: 't', author: { login: 'lance' } }, { body: 'hi', createdAt: 't' }]
  assert.deepEqual(decisionsFromComments(comments), [{ body: 'Decision: B\n\nbecause SVG is enough', createdAt: 't', author: 'lance' }])
})

const fc = (createdAt, type, data) => ({ createdAt, body: `text\n${formatMarker(type, data)}`, url: `u-${createdAt}` })

test('computeFindings: open, fixed, argued, withdrawn, and stands-after-fix', () => {
  const comments = [
    fc('01', 'finding', { id: 'f1', reviewer: 'r', title: 'one' }),
    fc('02', 'finding', { id: 'f2', reviewer: 'r', title: 'two' }),
    fc('03', 'finding', { id: 'f3', reviewer: 'r', title: 'three' }),
    fc('04', 'finding', { id: 'f4', reviewer: 'r', title: 'four' }),
    fc('05', 'reply', { finding: 'f2', action: 'fixed', commit: 'c2' }),
    fc('06', 'reply', { finding: 'f3', action: 'argued', commit: null }),
    fc('07', 'verdict', { finding: 'f3', verdict: 'withdrawn' }),
    fc('08', 'reply', { finding: 'f4', action: 'fixed', commit: 'c4' }),
    fc('09', 'verdict', { finding: 'f4', verdict: 'stands' }),
  ]
  const byId = Object.fromEntries(computeFindings(comments).map(f => [f.id, f]))
  assert.equal(byId.f1.open, true)
  assert.equal(byId.f2.open, false)
  assert.equal(byId.f2.fixedIn, 'c2')
  assert.equal(byId.f3.open, false)
  assert.equal(byId.f3.status, 'withdrawn')
  assert.equal(byId.f3.argued, true)
  assert.equal(byId.f3.argumentUrl, 'u-06')
  assert.equal(byId.f4.open, true)
})

test('computeFindings sorts by time, so a verdict posted before a reply does not count', () => {
  const comments = [
    fc('09', 'reply', { finding: 'f1', action: 'fixed', commit: 'c' }),
    fc('05', 'verdict', { finding: 'f1', verdict: 'stands' }),
    fc('01', 'finding', { id: 'f1', reviewer: 'r', title: 't' }),
  ]
  assert.equal(computeFindings(comments)[0].open, false)
})

test('computeFindings ignores replies to unknown findings and keeps the first copy of a finding id', () => {
  const comments = [
    fc('01', 'finding', { id: 'f1', reviewer: 'r', title: 'first' }),
    fc('02', 'finding', { id: 'f1', reviewer: 'r', title: 'dupe' }),
    fc('03', 'reply', { finding: 'nope', action: 'fixed' }),
  ]
  const fs = computeFindings(comments)
  assert.equal(fs.length, 1)
  assert.equal(fs[0].title, 'first')
})
