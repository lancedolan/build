import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeGraph, topoOrder } from '../scripts/lib/graph.mjs'

const R = 'acme/shop'
const iss = (number, deps, repo = R) => ({ number, repo, blockedByAll: deps.map(d => (typeof d === 'number' ? { number: d, repo: R } : d)) })
const opts = { specRepo: R, specNumber: 40 }

test('topological order breaks ties by issue number', () => {
  const g = analyzeGraph([iss(45, [44]), iss(44, [42, 43]), iss(43, [41]), iss(42, [41]), iss(41, []), iss(46, [])], opts)
  assert.deepEqual(g.errors, [])
  assert.deepEqual(g.order, [41, 42, 43, 44, 45, 46])
  assert.deepEqual(g.blockedBy.get(44), [42, 43])
})

test('a lower-numbered issue that depends on a higher one comes after it', () => {
  const g = analyzeGraph([iss(41, [43]), iss(42, []), iss(43, [])], opts)
  assert.deepEqual(g.order, [42, 43, 41])
})

test('a cycle is a graph error and its issues still appear in order', () => {
  const g = analyzeGraph([iss(41, [42]), iss(42, [41]), iss(43, [])], opts)
  assert.equal(g.errors.length, 1)
  assert.match(g.errors[0], /cycle among #41, #42/)
  assert.deepEqual(g.order, [43, 41, 42])
})

test('a link to an issue outside the spec is a graph error', () => {
  const g = analyzeGraph([iss(41, [99]), iss(42, [41])], opts)
  assert.equal(g.errors.length, 1)
  assert.match(g.errors[0], /#41 is blocked by #99, which is not a sub-issue of this spec/)
  assert.deepEqual(g.blockedBy.get(41), [])
})

test('a link to the spec issue itself, to another repo, and to itself are errors', () => {
  const g = analyzeGraph([iss(41, [40]), iss(42, [{ number: 41, repo: 'other/repo' }]), iss(43, [43])], opts)
  assert.equal(g.errors.length, 3)
  assert.match(g.errors[0], /the spec issue itself/)
  assert.match(g.errors[1], /other\/repo#41/)
  assert.match(g.errors[2], /#43 is blocked by itself/)
})

test('a sub-issue in another repo is a graph error and is left out', () => {
  const g = analyzeGraph([iss(41, []), iss(7, [], 'other/repo')], opts)
  assert.equal(g.errors.length, 1)
  assert.deepEqual(g.order, [41])
})

test('duplicate links are listed once', () => {
  const g = analyzeGraph([iss(41, []), iss(42, [41, 41])], opts)
  assert.deepEqual(g.blockedBy.get(42), [41])
})

test('topoOrder ignores parents that are not nodes', () => {
  const { order, cycle } = topoOrder(new Map([[2, [1]], [3, []]]))
  assert.deepEqual(order, [2, 3])
  assert.deepEqual(cycle, [])
})
