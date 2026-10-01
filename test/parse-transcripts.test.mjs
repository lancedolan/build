import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { splitLabel, lastUsage, labelsFromJournal, main } from '../scripts/parse-transcripts.mjs'
import { FIXTURES } from './helpers.mjs'

const REAL = join(FIXTURES, 'transcripts', 'real-wf_8dfb15c0-c5d')
const SYN = join(FIXTURES, 'transcripts', 'synthetic')

test('real transcript: last entry per message.id, context = input + cache read + cache creation', () => {
  const { output } = main([REAL])
  assert.deepEqual(output, [{
    agentId: 'a65aca8b3733d8233', label: 'nest-test', issue: null, role: null, round: null, cycle: null,
    model: 'claude-opus-5-5', contextTokens: 2 + 13962 + 7619,
  }])
})

test('synthetic transcripts: labels split into issue, role, round, cycle', () => {
  const rows = Object.fromEntries(main([SYN]).output.map(r => [r.agentId, r]))
  assert.deepEqual(
    { issue: rows.aimpl0000001.issue, role: rows.aimpl0000001.role, round: rows.aimpl0000001.round, cycle: rows.aimpl0000001.cycle },
    { issue: '41', role: 'implementer', round: 1, cycle: null },
  )
  assert.deepEqual([rows.aver00000002.role, rows.aver00000002.round, rows.aver00000002.cycle], ['verifier', 0, 2])
  assert.deepEqual([rows.arech0000003.issue, rows.arech0000003.role, rows.arech0000003.round], ['spec', 'recheck', null])
  assert.deepEqual([rows.arev00000004.role, rows.arev00000004.round], ['review:build:fallback-reviewer', 2])
})

test('synthetic transcripts: the later duplicate of a message id wins', () => {
  const rows = Object.fromEntries(main([SYN]).output.map(r => [r.agentId, r]))
  assert.equal(rows.aimpl0000001.contextTokens, 3 + 1200 + 300)
  assert.equal(rows.aver00000002.model, 'claude-haiku-4-5-20251001')
  assert.equal(rows.arech0000003.contextTokens, 2 + 2500 + 100)
  assert.equal(rows.arev00000004.contextTokens, 4 + 8000, 'a broken last line is skipped')
})

test('label falls back to meta.json description; no usage gives null tokens', () => {
  const rows = Object.fromEntries(main([SYN]).output.map(r => [r.agentId, r]))
  assert.equal(rows.ameta0000005.label, '#42 scout')
  assert.equal(rows.ameta0000005.role, 'scout')
  assert.equal(rows.anone0000006.label, null)
  assert.equal(rows.anone0000006.contextTokens, null)
})

test('several dirs are combined', () => {
  assert.equal(main([REAL, SYN]).output.length, 7)
})

test('a missing dir throws; no dirs is a usage error', () => {
  assert.throws(() => main([join(FIXTURES, 'nope')]), /transcript dir not found/)
  assert.throws(() => main([]), /give at least one transcriptDir/)
})

test('splitLabel handles every label form in the contracts', () => {
  const cases = {
    '#41 scout': ['41', 'scout', null, null],
    '#41 test-writer': ['41', 'test-writer', null, null],
    '#41 implementer r0': ['41', 'implementer', 0, null],
    '#41 implementer r2 c3': ['41', 'implementer', 2, 3],
    '#41 git r1': ['41', 'git', 1, null],
    '#spec start-verifier': ['spec', 'start-verifier', null, null],
    '#spec git': ['spec', 'git', null, null],
    'nest-test': [null, null, null, null],
    '': [null, null, null, null],
  }
  for (const [label, want] of Object.entries(cases)) {
    const s = splitLabel(label)
    assert.deepEqual([s.issue, s.role, s.round, s.cycle], want, label)
  }
})

test('labelsFromJournal keeps the first label per agent', () => {
  const text = [
    JSON.stringify({ type: 'started', agentId: 'a', label: 'first' }),
    JSON.stringify({ type: 'started', agentId: 'a', label: 'second' }),
    'garbage',
  ].join('\n')
  assert.equal(labelsFromJournal(text).get('a'), 'first')
})

test('lastUsage with no assistant entries', () => {
  assert.deepEqual(lastUsage('{"type":"user"}\n'), { model: null, contextTokens: null })
})
