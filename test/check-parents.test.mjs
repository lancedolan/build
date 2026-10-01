import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkParents, parseParents, main } from '../scripts/check-parents.mjs'
import { makeGh } from '../scripts/lib/gh.mjs'

const ok = v => ({ status: 0, stdout: typeof v === 'string' ? `${v}\n` : JSON.stringify(v), stderr: '' })
const mergeCommit = (...parents) => ({ oid: 'mc', parents: { nodes: parents.map(oid => ({ oid })) } })

// prs: {prNumber: pullRequest node}. branch: head oid or null (missing). compare: {"base...head": status}.
function fakeGh({ prs, branch = 'b42', compare = {} }) {
  const calls = []
  const gh = makeGh((args, opts) => {
    calls.push(args)
    if (args[1] === 'graphql') {
      const { query } = JSON.parse(opts.input)
      const repository = {}
      for (const m of query.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)) repository[m[1]] = prs[m[2]] || null
      return ok({ data: { repository } })
    }
    if (args[1].includes('/git/ref/heads/')) {
      return branch ? ok(branch) : { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
    }
    if (args[1].includes('/compare/')) return ok(compare[args[1].split('/compare/')[1]])
    throw new Error(`unexpected gh ${args.join(' ')}`)
  })
  return { gh, calls }
}
const opts = parents => ({ repo: 'acme/shop', branch: 'build/40-42', parents })

test('open parents: nothing merged', () => {
  const { gh } = fakeGh({ prs: { 141: { merged: false, headRefOid: 'h41', mergeCommit: null } } })
  assert.deepEqual(checkParents(gh, opts([{ issue: 41, pr: 141 }])), { merged: [], badMerges: [] })
})

test('merged with a merge commit: merged, not bad, no branch lookup', () => {
  const { gh, calls } = fakeGh({ prs: { 141: { merged: true, headRefOid: 'h41', mergeCommit: mergeCommit('m0', 'h41') } } })
  assert.deepEqual(checkParents(gh, opts([{ issue: 41, pr: 141 }])), { merged: [41], badMerges: [] })
  assert.ok(!calls.some(a => a[1].includes('/git/ref/')))
})

test('squash-merged and the branch still has the parent head: bad merge', () => {
  const { gh } = fakeGh({
    prs: { 141: { merged: true, headRefOid: 'h41', mergeCommit: mergeCommit('m0') }, 142: { merged: false, headRefOid: 'h42', mergeCommit: null } },
    compare: { 'h41...b42': 'ahead' },
  })
  assert.deepEqual(checkParents(gh, opts([{ issue: 41, pr: 141 }, { issue: 42, pr: 142 }])), { merged: [41], badMerges: [41] })
})

test('squash-merged but the branch was rebased by hand: not bad', () => {
  const { gh } = fakeGh({ prs: { 141: { merged: true, headRefOid: 'h41', mergeCommit: mergeCommit('m0') } }, compare: { 'h41...b42': 'diverged' } })
  assert.deepEqual(checkParents(gh, opts([{ issue: 41, pr: 141 }])), { merged: [41], badMerges: [] })
})

test('squash-merged and the issue has no branch yet: not bad', () => {
  const { gh } = fakeGh({ prs: { 141: { merged: true, headRefOid: 'h41', mergeCommit: mergeCommit('m0') } }, branch: null })
  assert.deepEqual(checkParents(gh, opts([{ issue: 41, pr: 141 }])), { merged: [41], badMerges: [] })
})

test('argument errors', async () => {
  assert.deepEqual(parseParents('41:141, 42:142'), [{ issue: 41, pr: 141 }, { issue: 42, pr: 142 }])
  assert.throws(() => parseParents('41'), /must look like 41:141/)
  await assert.rejects(main(['--repo', 'acme/shop', '--parents', '41:141']), /--branch is required/)
})
