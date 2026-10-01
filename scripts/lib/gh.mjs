// Thin wrapper around the gh CLI. Every script gets gh through makeGh(runner),
// so tests can pass a runner that returns recorded JSON instead of calling gh.
import { spawnSync } from 'node:child_process'

// A runner takes (args, {input, cwd}) and returns {status, stdout, stderr}.
export function defaultRunner(args, { input, cwd } = {}) {
  const r = spawnSync('gh', args, {
    input,
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.error) return { status: 1, stdout: '', stderr: String(r.error.message || r.error) }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

export function makeGh(runner = defaultRunner) {
  function run(args, opts = {}) {
    const r = runner(args, opts)
    if (r.status !== 0) {
      const err = new Error(`gh ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`)
      err.status = r.status
      err.stderr = r.stderr
      throw err
    }
    return r.stdout
  }

  // Like run, but returns {ok, stdout, stderr} instead of throwing.
  function tryRun(args, opts = {}) {
    const r = runner(args, opts)
    return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' }
  }

  function json(args, opts = {}) {
    const out = run(args, opts)
    return out.trim() ? JSON.parse(out) : null
  }

  // Runs a GraphQL query. Variables go in a JSON body on stdin, so values are never
  // re-parsed by a shell or by gh's -F type guessing.
  function graphql(query, variables = {}) {
    const res = json(['api', 'graphql', '--input', '-'], {
      input: JSON.stringify({ query, variables }),
    })
    if (res && res.errors && res.errors.length) {
      throw new Error(`GraphQL error: ${res.errors.map(e => e.message).join('; ')}`)
    }
    return res.data
  }

  return { run, tryRun, json, graphql }
}
