// Test helpers: fixture loading and fake gh runners.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeGh } from '../scripts/lib/gh.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURES = join(ROOT, 'test', 'fixtures')

export const loadJson = name => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
export const clone = v => JSON.parse(JSON.stringify(v))

const ok = data => ({ status: 0, stdout: JSON.stringify(data), stderr: '' })

// A gh runner that answers read-state's GraphQL queries from a fixture:
//   {spec: <SPEC_QUERY response>, prs: {branch: [PR nodes]}, pages: {key: <connection>}}
// `pages` keys: "comments:<nodeId>:<after>", "subIssues:<nodeId>:<after>", "refs:<after>".
// `extra(args, opts)` can answer non-GraphQL calls; return undefined to fall through.
export function fixtureRunner(fixture, { extra, calls = [] } = {}) {
  return (args, opts = {}) => {
    calls.push({ args, input: opts.input })
    if (extra) {
      const r = extra(args, opts)
      if (r !== undefined) return r
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const { query, variables } = JSON.parse(opts.input)
      if (query.includes('issue(number: $spec)')) return ok(fixture.spec)
      if (query.includes('pullRequests(headRefName:')) {
        const repository = {}
        for (const [k, v] of Object.entries(variables)) {
          const m = /^b(\d+)$/.exec(k)
          if (m) repository[`p${m[1]}`] = { nodes: (fixture.prs || {})[v] || [] }
        }
        return ok({ data: { repository } })
      }
      const pages = fixture.pages || {}
      if (query.includes('subIssues(first: 100, after: $after)')) {
        return ok({ data: { node: { subIssues: pages[`subIssues:${variables.id}:${variables.after}`] } } })
      }
      if (query.includes('comments(first: 100, after: $after)')) {
        return ok({ data: { node: { comments: pages[`comments:${variables.id}:${variables.after}`] } } })
      }
      if (query.includes('refs(refPrefix: "refs/heads/", query: $refQuery, first: 100, after: $after)')) {
        return ok({ data: { repository: { refs: pages[`refs:${variables.after}`] } } })
      }
      throw new Error(`fixtureRunner: unknown query ${query.slice(0, 80)}`)
    }
    if (args[0] === 'auth' && args[1] === 'status') return { status: 0, stdout: '', stderr: 'Logged in' }
    // compare API: fixture.compare maps "base...head" to a status.
    if (args[0] === 'api' && args[1].includes('/compare/') && fixture.compare) {
      const key = args[1].split('/compare/')[1]
      if (key in fixture.compare) return { status: 0, stdout: `${fixture.compare[key]}\n`, stderr: '' }
    }
    if (args[0] === 'repo' && args[1] === 'view') return ok({ nameWithOwner: fixture.spec.data.repository.nameWithOwner })
    throw new Error(`fixtureRunner: unexpected gh ${args.join(' ')}`)
  }
}

export const fixtureGh = (fixture, opts) => makeGh(fixtureRunner(fixture, opts))

// An in-memory fs for scripts that take {exists, read, write, mkdir, list}.
export function memFs(files = {}) {
  const store = new Map(Object.entries(files))
  return {
    store,
    exists: p => store.has(p) || [...store.keys()].some(k => k.startsWith(`${p}/`)),
    read: p => {
      if (!store.has(p)) throw new Error(`ENOENT: ${p}`)
      return store.get(p)
    },
    write: (p, s) => store.set(p, s),
    mkdir: () => {},
    list: dir => [...store.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1)).filter(k => !k.includes('/')),
  }
}
