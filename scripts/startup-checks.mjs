// Startup checks for /build. Runs before any agent. Prints {ok, refusals, warnings}
// and exits 1 when anything is refused.
import { parseArgs } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeGh } from './lib/gh.mjs'
import { isMain, runCli, usageError, parseBool } from './lib/cli.mjs'
import { readState, resolveRepo } from './read-state.mjs'

const USAGE = 'node startup-checks.mjs --spec N --human-in-loop true|false --repo-dir PATH [--state FILE]'

const WRITE_PERMISSIONS = ['WRITE', 'MAINTAIN', 'ADMIN']

// Settings files in the order Claude Code reads them, lowest priority first.
export function settingsPaths({ home, configDir, repoDir }) {
  const userDir = configDir || join(home, '.claude')
  return [
    join(userDir, 'settings.json'),
    join(repoDir, '.claude', 'settings.json'),
    join(repoDir, '.claude', 'settings.local.json'),
  ]
}

// fs: {exists(path), read(path)}. Returns [{path, settings}] for files that exist and parse.
export function loadSettings(paths, fs) {
  const out = []
  for (const p of paths) {
    if (!fs.exists(p)) continue
    try {
      out.push({ path: p, settings: JSON.parse(fs.read(p)) })
    } catch (e) {
      out.push({ path: p, settings: {}, error: `couldn't parse ${p}: ${e.message}` })
    }
  }
  return out
}

// Later files win, the way Claude Code merges settings.
function effective(settingsList, key) {
  let value
  let from = null
  for (const s of settingsList) {
    if (s.settings && Object.prototype.hasOwnProperty.call(s.settings, key)) {
      value = s.settings[key]
      from = s.path
    }
  }
  return { value, from }
}

// Pure: every input is passed in. Returns {ok, refusals, warnings}.
export function runChecks({ state, humanInLoop, settingsList, env, ghAuthOk, ghAuthError }) {
  const refusals = []
  const warnings = []
  const spec = state && state.spec ? state.spec.number : '?'

  // 1. Workflows must not be turned off.
  const disabled = effective(settingsList, 'disableWorkflows')
  if (env.CLAUDE_CODE_DISABLE_WORKFLOWS === '1' || env.CLAUDE_CODE_DISABLE_WORKFLOWS === 'true') {
    refusals.push('WORKFLOWS ARE TURNED OFF: CLAUDE_CODE_DISABLE_WORKFLOWS is set. /build runs as a dynamic workflow. Unset it and restart Claude Code.')
  } else if (disabled.value === true) {
    refusals.push(`WORKFLOWS ARE TURNED OFF: "disableWorkflows": true in ${disabled.from}. /build runs as a dynamic workflow. Remove that setting (on Pro, also turn on Dynamic workflows in /config).`)
  }
  for (const s of settingsList) if (s.error) warnings.push(`Settings file skipped: ${s.error}`)

  // 2. Usage-limit wait is a warning only.
  const autoContinue = effective(settingsList, 'autoContinueAtUsageLimit')
  if (autoContinue.value !== true) {
    warnings.push('autoContinueAtUsageLimit is not on. If the run hits your usage limit, agents fail instead of waiting for the reset, and the run stops with the current issue marked interrupted. Rerun /build after the reset to resume.')
  }

  // 3. gh must be logged in and able to write.
  if (!ghAuthOk) {
    refusals.push(`GH IS NOT LOGGED IN: \`gh auth status\` failed${ghAuthError ? `: ${ghAuthError.trim()}` : ''}. Run \`gh auth login\`.`)
  }
  if (state && !WRITE_PERMISSIONS.includes(state.viewerPermission)) {
    refusals.push(`NO WRITE ACCESS: your gh account has "${state.viewerPermission || 'no'}" permission on ${state.repo}. /build pushes branches and opens PRs, so it needs WRITE, MAINTAIN, or ADMIN.`)
  }
  if (state && !state.defaultBranch) {
    refusals.push(`THE REPO HAS NO DEFAULT BRANCH: ${state.repo} looks empty. Push a first commit before running /build.`)
  }

  // 4. The graph must be valid.
  for (const e of (state && state.graphErrors) || []) refusals.push(`INVALID ISSUE GRAPH: ${e}`)

  // 5. human-in-loop must match work already started.
  if (state) {
    const specBranch = state.specBranch || {}
    const lastRun = state.spec.lastRun
    if (lastRun && typeof lastRun.humanInLoop === 'boolean' && lastRun.humanInLoop !== humanInLoop) {
      refusals.push(`HUMAN-IN-LOOP MISMATCH: the last run of spec #${spec} used human-in-loop=${lastRun.humanInLoop}, and this run asks for ${humanInLoop}. Rerun with human-in-loop=${lastRun.humanInLoop}.`)
    }
    const prs = (state.issues || []).flatMap(i => (i.allPrs || (i.pr ? [i.pr] : [])).map(p => ({ ...p, issue: i.number })))
    if (humanInLoop) {
      if (specBranch.exists) {
        refusals.push(`HUMAN-IN-LOOP MISMATCH: branch ${specBranch.name} exists, so spec #${spec} was started with human-in-loop=false. Rerun with human-in-loop=false.`)
      }
      for (const p of prs) {
        if (p.baseRefName === specBranch.name) {
          refusals.push(`HUMAN-IN-LOOP MISMATCH: PR #${p.number} (issue #${p.issue}) targets ${specBranch.name}, so it was made with human-in-loop=false. Rerun with human-in-loop=false.`)
        }
      }
    } else {
      for (const p of prs) {
        if (p.baseRefName !== specBranch.name) {
          refusals.push(`HUMAN-IN-LOOP MISMATCH: PR #${p.number} (issue #${p.issue}) targets ${p.baseRefName}, not ${specBranch.name}, so it was made with human-in-loop=true. Rerun with human-in-loop=true.`)
        }
      }
    }
  }

  // 6. true mode needs auto-delete of head branches.
  if (state && humanInLoop && !state.deleteBranchOnMerge) {
    refusals.push(`AUTO-DELETE OF HEAD BRANCHES IS OFF in ${state.repo}. human-in-loop=true stacks PRs on each other. Without auto-delete, a stacked PR stays targeted at its merged parent's branch, and merging it never reaches ${state.defaultBranch || 'the default branch'}, with no error. Turn on Settings → General → "Automatically delete head branches", or run \`gh repo edit ${state.repo} --delete-branch-on-merge\`.`)
  }

  return { ok: refusals.length === 0, refusals, warnings }
}

export async function main(argv, deps = {}) {
  const gh = deps.gh || makeGh()
  const env = deps.env || process.env
  const fs = deps.fs || { exists: existsSync, read: p => readFileSync(p, 'utf8') }
  const home = deps.home || homedir()

  const { values } = parseArgs({
    args: argv,
    options: {
      spec: { type: 'string' },
      'human-in-loop': { type: 'string', default: 'true' },
      'repo-dir': { type: 'string' },
      state: { type: 'string' },
    },
  })
  if (!values.spec) throw usageError('--spec is required')
  if (!values['repo-dir']) throw usageError('--repo-dir is required')
  const humanInLoop = parseBool(values['human-in-loop'], '--human-in-loop')

  const auth = gh.tryRun(['auth', 'status'])
  let state = null
  if (values.state) state = JSON.parse(fs.read(values.state))
  else if (auth.ok) state = await readState(gh, { repo: await resolveRepo(gh, values['repo-dir']), spec: values.spec })

  const settingsList = loadSettings(settingsPaths({ home, configDir: env.CLAUDE_CONFIG_DIR, repoDir: values['repo-dir'] }), fs)
  const result = runChecks({ state, humanInLoop, settingsList, env, ghAuthOk: auth.ok, ghAuthError: auth.stderr })
  return { output: result, exitCode: result.ok ? 0 : 1 }
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)), USAGE)
