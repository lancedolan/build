import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runChecks, loadSettings, settingsPaths, main } from '../scripts/startup-checks.mjs'
import { readState } from '../scripts/read-state.mjs'
import { loadJson, clone, fixtureGh, memFs } from './helpers.mjs'
import { makeGh } from '../scripts/lib/gh.mjs'

const spec40State = async () => readState(fixtureGh(clone(loadJson('gh-spec40.json'))), { repo: 'acme/shop', spec: 40 })
const settings = (obj, path = '/home/.claude/settings.json') => [{ path, settings: obj }]
const AUTO = { permissions: { defaultMode: 'auto' } }
const goodSettings = settings({ autoContinueAtUsageLimit: true, ...AUTO })
const base = state => ({ state, humanInLoop: true, settingsList: goodSettings, env: {}, ghAuthOk: true })

test('a clean true-mode run passes with no warnings', async () => {
  const r = runChecks(base(await spec40State()))
  assert.deepEqual(r, { ok: true, refusals: [], warnings: [] })
})

test('disableWorkflows in settings refuses, and a later file wins', async () => {
  const state = await spec40State()
  let r = runChecks({ ...base(state), settingsList: settings({ disableWorkflows: true, autoContinueAtUsageLimit: true, ...AUTO }) })
  assert.equal(r.ok, false)
  assert.match(r.refusals[0], /WORKFLOWS ARE TURNED OFF.*disableWorkflows/)
  r = runChecks({
    ...base(state),
    settingsList: [
      { path: 'user', settings: { disableWorkflows: true, autoContinueAtUsageLimit: true, ...AUTO } },
      { path: 'project', settings: { disableWorkflows: false } },
    ],
  })
  assert.equal(r.ok, true)
})

test('CLAUDE_CODE_DISABLE_WORKFLOWS refuses', async () => {
  for (const v of ['1', 'true']) {
    const r = runChecks({ ...base(await spec40State()), env: { CLAUDE_CODE_DISABLE_WORKFLOWS: v } })
    assert.match(r.refusals[0], /CLAUDE_CODE_DISABLE_WORKFLOWS/)
  }
})

test('autoContinueAtUsageLimit off is a warning only', async () => {
  const r = runChecks({ ...base(await spec40State()), settingsList: settings(AUTO) })
  assert.equal(r.ok, true)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /autoContinueAtUsageLimit/)
})

test('an unparsable settings file is a warning', () => {
  const fs = memFs({ '/h/.claude/settings.json': '{oops', '/r/.claude/settings.json': '{"autoContinueAtUsageLimit": true}' })
  const list = loadSettings(settingsPaths({ home: '/h', repoDir: '/r' }), fs)
  const r = runChecks({ state: null, humanInLoop: true, settingsList: list, env: {}, ghAuthOk: true })
  assert.match(r.warnings[0], /couldn't parse \/h\/.claude\/settings.json/)
})

test('settingsPaths honors CLAUDE_CONFIG_DIR', () => {
  assert.deepEqual(settingsPaths({ home: '/h', configDir: '/cfg', repoDir: '/r' }), ['/cfg/settings.json', '/r/.claude/settings.json', '/r/.claude/settings.local.json'])
})

test('gh not logged in refuses', async () => {
  const r = runChecks({ ...base(await spec40State()), ghAuthOk: false, ghAuthError: 'not logged in' })
  assert.match(r.refusals[0], /GH IS NOT LOGGED IN.*not logged in/)
})

test('read-only permission refuses; write, maintain, admin pass', async () => {
  const state = await spec40State()
  for (const p of ['WRITE', 'MAINTAIN', 'ADMIN']) assert.equal(runChecks(base({ ...state, viewerPermission: p })).ok, true)
  for (const p of ['READ', 'TRIAGE', null]) {
    const r = runChecks(base({ ...state, viewerPermission: p }))
    assert.match(r.refusals[0], /NO WRITE ACCESS/)
  }
})

test('an empty repo with no default branch refuses', async () => {
  const r = runChecks(base({ ...(await spec40State()), defaultBranch: null }))
  assert.match(r.refusals.join('\n'), /NO DEFAULT BRANCH/)
})

test('graph errors refuse, one refusal each', async () => {
  const r = runChecks(base({ ...(await spec40State()), graphErrors: ['cycle', 'outside link'] }))
  assert.deepEqual(r.refusals, ['INVALID ISSUE GRAPH: cycle', 'INVALID ISSUE GRAPH: outside link'])
})

test('true mode refuses when auto-delete of head branches is off; false mode does not care', async () => {
  const state = { ...(await spec40State()), deleteBranchOnMerge: false }
  assert.match(runChecks(base(state)).refusals[0], /AUTO-DELETE OF HEAD BRANCHES IS OFF/)
  const falseState = noPrs(state)
  assert.equal(runChecks({ ...base(falseState), humanInLoop: false }).ok, true)
})

function noPrs(state) {
  const s = clone(state)
  s.spec.lastRun = null
  for (const i of s.issues) {
    i.pr = null
    i.allPrs = []
  }
  return s
}

test('mode mismatch: true mode, but the spec branch exists or a PR targets it', async () => {
  const state = noPrs(await spec40State())
  state.specBranch.exists = true
  let r = runChecks(base(state))
  assert.match(r.refusals[0], /HUMAN-IN-LOOP MISMATCH: branch build\/40-spec exists/)

  const s2 = noPrs(await spec40State())
  s2.issues[0].allPrs = [{ number: 46, state: 'OPEN', merged: false, baseRefName: 'build/40-spec' }]
  r = runChecks(base(s2))
  assert.match(r.refusals[0], /PR #46 \(issue #41\) targets build\/40-spec/)
})

test('mode mismatch: false mode, but existing PRs target the default branch', async () => {
  const r = runChecks({ ...base(await spec40State()), humanInLoop: false })
  assert.equal(r.ok, false)
  const prRefusals = r.refusals.filter(x => /PR #\d+ \(issue #\d+\) targets/.test(x))
  // #46 -> main, #47 -> build/40-41, old closed #40 -> main
  assert.equal(prRefusals.length, 3)
  assert.match(r.refusals[0], /last run of spec #40 used human-in-loop=true/)
})

test('mode mismatch: the last run marker disagrees', async () => {
  const state = noPrs(await spec40State())
  state.spec.lastRun = { humanInLoop: false }
  const r = runChecks(base(state))
  assert.match(r.refusals[0], /last run of spec #40 used human-in-loop=false, and this run asks for true/)
})

test('false mode with PRs into the spec branch passes', async () => {
  const state = noPrs(await spec40State())
  state.specBranch.exists = true
  state.issues[0].allPrs = [{ number: 46, state: 'MERGED', merged: true, baseRefName: 'build/40-spec' }]
  assert.equal(runChecks({ ...base(state), humanInLoop: false }).ok, true)
})

test('main: reads settings and gh, exits 1 on refusal', async () => {
  const fx = clone(loadJson('gh-spec40.json'))
  const fs = memFs({ '/h/.claude/settings.json': JSON.stringify({ autoContinueAtUsageLimit: true, ...AUTO }) })
  const ok = await main(['--spec', '40', '--repo-dir', '/r'], { gh: fixtureGh(fx), env: {}, fs, home: '/h' })
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.output.ok, true)

  const bad = await main(['--spec', '40', '--repo-dir', '/r', '--human-in-loop', 'false'], { gh: fixtureGh(fx), env: {}, fs, home: '/h' })
  assert.equal(bad.exitCode, 1)
})

test('main: gh auth failure refuses without reading state', async () => {
  const gh = makeGh(args => (args[0] === 'auth' ? { status: 1, stdout: '', stderr: 'You are not logged in' } : assert.fail(`unexpected gh ${args}`)))
  const r = await main(['--spec', '40', '--repo-dir', '/r'], { gh, env: {}, fs: memFs(), home: '/h' })
  assert.equal(r.exitCode, 1)
  assert.ok(r.output.refusals.some(x => /You are not logged in/.test(x)))
})

test('main: --state reads a state file instead of gh', async () => {
  const state = await spec40State()
  const fs = memFs({ '/s.json': JSON.stringify(state), '/h/.claude/settings.json': JSON.stringify({ autoContinueAtUsageLimit: true, ...AUTO }) })
  const gh = makeGh(args => (args[0] === 'auth' ? { status: 0, stdout: '', stderr: '' } : assert.fail(`unexpected gh ${args}`)))
  const r = await main(['--spec', '40', '--repo-dir', '/r', '--state', '/s.json'], { gh, env: {}, fs, home: '/h' })
  assert.equal(r.output.ok, true)
})

test('main: a --state file holding a read-state error repeats that error', async () => {
  const fs = memFs({ '/s.json': JSON.stringify({ error: 'gh api graphql failed: too many nodes' }) })
  const gh = makeGh(() => ({ status: 0, stdout: '', stderr: '' }))
  await assert.rejects(main(['--spec', '40', '--repo-dir', '/r', '--state', '/s.json'], { gh, env: {}, fs, home: '/h' }),
    /read-state\.mjs failed: gh api graphql failed: too many nodes/)
})

test('main: bad --human-in-loop value is a usage error', async () => {
  await assert.rejects(main(['--spec', '40', '--repo-dir', '/r', '--human-in-loop', 'maybe'], { gh: fixtureGh(clone(loadJson('gh-spec40.json'))), env: {}, fs: memFs(), home: '/h' }), /must be true or false/)
})

test('true mode refuses a squash or rebase merge under a stacked branch', async () => {
  const state = { ...(await spec40State()), badMerges: [{ issue: 41, pr: 46, dependent: 42, branch: 'build/40-42' }] }
  const r = runChecks(base(state))
  assert.equal(r.ok, false)
  assert.match(r.refusals[0], /PR MERGED WITHOUT A MERGE COMMIT: PR #46 \(issue #41\).*build\/40-42 \(issue #42\)/)
})

test('a permission mode that asks for approval refuses; auto and bypass pass; later files win', async () => {
  const state = await spec40State()
  const check = list => runChecks({ ...base(state), settingsList: list })
  let r = check(settings({ autoContinueAtUsageLimit: true }))
  assert.equal(r.ok, false)
  assert.match(r.refusals[0], /PERMISSION MODE ASKS FOR APPROVAL: no permissions.defaultMode is set/)
  r = check([
    { path: 'user', settings: { autoContinueAtUsageLimit: true, ...AUTO } },
    { path: 'project', settings: { permissions: { defaultMode: 'acceptEdits' } } },
  ])
  assert.match(r.refusals[0], /"defaultMode": "acceptEdits" in project/)
  assert.equal(check(settings({ autoContinueAtUsageLimit: true, permissions: { defaultMode: 'bypassPermissions' } })).ok, true)
})
