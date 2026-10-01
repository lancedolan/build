export const meta = {
  name: 'build-graph',
  description: 'Work a spec issue graph into one PR per sub-issue: tests first, verify, adversarial review',
  whenToUse: 'Started by the /build skill with args from read-state.mjs. Not meant to be run by hand.',
  phases: [
    { title: 'Startup', detail: 'verify the starting code, recheck answered PRs' },
    { title: 'Finish', detail: 'open the spec-branch PR when human-in-loop=false' },
  ],
}

// Each sub-issue runs in its own progress group named "Issue #<n>".
// The contracts for args, markers, labels, and the return value are in docs/contracts.md.

// ---------- inputs ----------

const S = args.state
const WT = args.worktree
const MAIN = args.mainCheckout
const PLUGIN_ROOT = args.pluginRoot
const HIL = args.humanInLoop !== false
const SPEC = S.spec.number
const REPO = S.repo
const DEFAULT = S.defaultBranch
const SPEC_BRANCH = `build/${SPEC}-spec`
const PORTS = (args.ports && args.ports.list) || []
const REVIEWERS = args.reviewers && args.reviewers.length ? args.reviewers : ['build:fallback-reviewer']
const REPORT_FILE = args.reportFile
const BASELINE = args.mainCheckoutBaseline || ''

const AGENT_LIMIT = 900
const MAX_REPAIRS = 3
const MAX_ROUNDS = 3
const STEPS = ['tests-committed', 'code-pushed', 'pr-opened', 'review-round', 'merged']
const MODEL = {
  scout: 'opus', testWriter: 'opus', implementer: 'opus', verifier: 'haiku',
  recheck: 'sonnet', rebaser: 'sonnet', git: 'haiku', merger: 'haiku', decisionReader: 'sonnet',
}
// Blocker type 8: the sub-issue was closed by hand with no merged PR. The script raises it,
// never an agent, so the agent BLOCKER schema stops at 7.
const CLOSED_BLOCKER_TYPE = 8

// ---------- schemas ----------

const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
const INT = { type: 'integer' }
const BLOCKER = {
  type: 'object',
  required: ['type', 'scope', 'question', 'options', 'recommendation'],
  properties: {
    type: { type: 'integer', minimum: 1, maximum: 7 },
    scope: { type: 'string', enum: ['branch', 'graph'] },
    question: STR,
    options: STRS,
    recommendation: STR,
  },
}
const COMMON_PROPS = {
  judgmentCalls: STRS,
  recommendations: STRS,
  blocker: { anyOf: [{ type: 'null' }, BLOCKER] },
}
const COMMON_REQ = ['judgmentCalls', 'recommendations', 'blocker']
const withCommon = (props, req) => ({
  type: 'object',
  required: [...req, ...COMMON_REQ],
  properties: { ...props, ...COMMON_PROPS },
})

const SCOUT_SCHEMA = withCommon({ brief: STR, verifyCommands: STRS }, ['brief', 'verifyCommands'])
const TESTS_SCHEMA = withCommon({
  testCommit: STR,
  testFiles: STRS,
  failureCheck: STR,
  pureRefactor: { type: 'boolean' },
  untestedCases: STRS,
}, ['testCommit', 'testFiles', 'failureCheck', 'pureRefactor', 'untestedCases'])
const IMPL_SCHEMA = withCommon({
  headCommit: STR,
  summary: STR,
  testChanges: {
    type: 'array',
    items: { type: 'object', required: ['file', 'reason'], properties: { file: STR, reason: STR } },
  },
  replies: {
    type: 'array',
    items: {
      type: 'object',
      required: ['finding', 'action', 'text'],
      properties: { finding: STR, action: { type: 'string', enum: ['fixed', 'argued'] }, text: STR },
    },
  },
}, ['headCommit', 'summary', 'testChanges', 'replies'])
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['passed', 'headCommit', 'commandsRun', 'failures', 'mainCheckoutClean', 'testDiffOk'],
  properties: {
    passed: { type: 'boolean' },
    headCommit: STR,
    commandsRun: STRS,
    failures: STR,
    mainCheckoutClean: { type: 'boolean' },
    testDiffOk: { type: 'boolean' },
  },
}
const FINDING = {
  type: 'object',
  required: ['id', 'severity', 'title', 'detail'],
  properties: {
    id: STR,
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
    title: STR,
    detail: STR,
    file: STR,
    line: INT,
  },
}
const REVIEW_SCHEMA = withCommon({
  findings: { type: 'array', items: FINDING },
  verdicts: {
    type: 'array',
    items: {
      type: 'object',
      required: ['finding', 'verdict'],
      properties: { finding: STR, verdict: { type: 'string', enum: ['withdrawn', 'stands'] } },
    },
  },
}, ['findings', 'verdicts'])
const GIT_SCHEMA = {
  type: 'object',
  required: ['ok', 'error'],
  properties: { ok: { type: 'boolean' }, error: STR, prNumber: INT, prUrl: STR, headCommit: STR },
}
const RECHECK_SCHEMA = withCommon({
  affected: {
    type: 'array',
    items: { type: 'object', required: ['issue', 'reason'], properties: { issue: INT, reason: STR } },
  },
}, ['affected'])
const REBASE_SCHEMA = {
  type: 'object',
  required: ['rebased', 'conflicts', 'verifyFailed'],
  properties: {
    rebased: { type: 'array', items: INT },
    verifyFailed: { type: 'array', items: INT },
    conflicts: {
      type: 'array',
      items: { type: 'object', required: ['issue', 'detail'], properties: { issue: INT, detail: STR } },
    },
  },
}
const DECISION_SCHEMA = {
  type: 'object',
  required: ['action', 'reason'],
  properties: { action: { type: 'string', enum: ['treat-as-done', 'build', 'unclear'] }, reason: STR },
}
const MERGE_SCHEMA = {
  type: 'object',
  required: ['merged', 'mergeCommit', 'error'],
  properties: { merged: { type: 'boolean' }, mergeCommit: STR, error: STR },
}

// ---------- run state ----------

const issues = new Map(S.issues.map(i => [i.number, i]))
const results = new Map()
const rebuildReasons = new Map()
const notes = []
let agentCount = 0
let stopped = null
let graphBlocker = null
let startOid = (S.spec.lastRun && S.spec.lastRun.startOid) || null
let finalPr = null

class StopRun extends Error {}
class Blocked extends Error {
  constructor(blocker) {
    super(`blocked: ${blocker.question}`)
    this.blocker = blocker
  }
}

// Every agent goes through here, so the count and the stop rules hold everywhere.
async function call(label, prompt, opts) {
  if (stopped) throw new StopRun(stopped)
  if (agentCount >= AGENT_LIMIT) {
    stopped = 'agent-limit'
    const msg = `STOPPED: ${agentCount} agents started, close to the 1,000-agent cap per run. Rerun /build to continue.`
    log(msg)
    notes.push(msg)
    throw new StopRun(stopped)
  }
  agentCount++
  const result = await agent(prompt, { label, ...opts })
  if (result === null || result === undefined) {
    stopped = 'usage-limit'
    notes.push(`Agent "${label}" returned no result (usage limit, a manual stop, or an API error). No new agents were started.`)
    throw new StopRun(stopped)
  }
  return result
}

function setResult(n, r) {
  results.set(n, {
    number: n,
    outcome: r.outcome,
    pr: r.pr == null ? null : r.pr,
    base: r.base == null ? null : r.base,
    waitingOn: r.waitingOn || [],
    blocker: r.blocker || null,
    ...(r.reason ? { reason: r.reason } : {}),
  })
}

// ---------- small helpers ----------

const branchOf = n => `build/${SPEC}-${n}`
const isAfter = (a, b) => String(a || '') > String(b || '')
const markerText = (type, data) =>
  `<!-- build:${type} ${JSON.stringify(data).replace(/>/g, '\\u003e')} -->`

function lastMarker(markers, type, filter) {
  let best = null
  for (const m of markers || []) {
    if (m.type !== type || (filter && !filter(m))) continue
    if (!best || !isAfter(best.createdAt, m.createdAt)) best = m
  }
  return best
}

// Type-8 blockers only count while the issue is closed; other types only while it is open.
// Same rule as computeStatus in scripts/read-state.mjs.
const isClosedBlocker = m => !!(m.data && m.data.type === CLOSED_BLOCKER_TYPE)
function currentBlocker(issue) {
  const closed = issue.state === 'CLOSED'
  return lastMarker(issue.markers, 'blocker', m => isClosedBlocker(m) === closed)
}

function newestDecision(decisions) {
  let best = null
  for (const d of decisions || []) if (!best || isAfter(d.createdAt, best.createdAt)) best = d
  return best
}

function parentsOf(n) {
  return (issues.get(n).blockedBy || []).filter(p => issues.has(p))
}

function childrenOf(n) {
  return S.order.filter(c => parentsOf(c).includes(n))
}

// Parents that stop issue n from starting, resolved to the issues that are actually stuck.
function blockingParents(n) {
  const out = new Set()
  for (const p of parentsOf(n)) {
    const r = results.get(p)
    // closed-done: closed by hand, and a Decision said to treat it as done. There is no branch to wait for.
    const ready = r && (r.outcome === 'merged' || r.outcome === 'closed-done' || (HIL && r.outcome === 'done'))
    if (ready) continue
    if (r && r.outcome === 'waiting' && r.waitingOn.length) r.waitingOn.forEach(w => out.add(w))
    else out.add(p)
  }
  return [...out].sort((a, b) => a - b)
}

// Where issue n's branch starts and which branch its PR targets.
function branchPlan(n) {
  if (!HIL) {
    return { base: SPEC_BRANCH, start: `origin/${SPEC_BRANCH}`, extraParents: [], mergeOrder: [] }
  }
  const open = S.order.filter(p => parentsOf(n).includes(p) && results.get(p).outcome === 'done')
  if (!open.length) return { base: DEFAULT, start: `origin/${DEFAULT}`, extraParents: [], mergeOrder: [] }
  const target = open[open.length - 1]
  return {
    base: branchOf(target),
    start: `origin/${branchOf(target)}`,
    targetParent: target,
    extraParents: open.slice(0, -1),
    mergeOrder: open.length > 1 ? [...open, n] : [],
  }
}

function resumePoint(issue) {
  const prog = lastMarker(issue.markers, 'progress')
  const intr = lastMarker(issue.markers, 'interrupted')
  let step = prog ? prog.data.step : null
  if (intr && intr.data.lastStep && (!prog || isAfter(intr.createdAt, prog.createdAt))) step = intr.data.lastStep
  const tests = lastMarker(issue.markers, 'progress', m => m.data.step === 'tests-committed')
  const round = lastMarker(issue.markers, 'progress', m => m.data.step === 'review-round')
  // code-pushed, pr-opened, and review-round markers are only posted after a verifier passed
  // that commit, test diff included. So test changes up to it are already approved.
  const verified = lastMarker(issue.markers, 'progress', m => ['code-pushed', 'pr-opened', 'review-round'].includes(m.data.step))
  return {
    at: step ? STEPS.indexOf(step) : -1,
    testCommit: tests ? tests.data.commit : null,
    verifiedCommit: verified ? verified.data.commit : null,
    lastRound: round ? round.data.round : 0,
  }
}

function decisionsText(issue) {
  const all = [
    ...(S.spec.decisions || []).map(d => ({ ...d, on: `spec issue #${SPEC}` })),
    ...((issue && issue.decisions) || []).map(d => ({ ...d, on: `issue #${issue.number}` })),
  ]
  if (!all.length) return ''
  return [
    '## Decision comments from humans',
    'These are copied word for word. Interpret them yourself. A decision answers an earlier blocker; follow it.',
    ...all.map(d => `--- on ${d.on}, ${d.createdAt}, by ${d.author} ---\n${d.body}`),
  ].join('\n')
}

// ---------- shared prompt text ----------

const WORKTREE_RULES = `## Where to work
- Work only in the git worktree at ${WT}. Run every command there (\`cd ${WT}\` or \`git -C ${WT}\`).
- Never edit, check out, or run builds in the main checkout at ${MAIN}.
- Repo on GitHub: ${REPO}. Pass \`-R ${REPO}\` to every gh command.
- Ports: use only ${PORTS.length ? PORTS.join(', ') : 'the ports the brief names'} for any server, dev server, or test runner that listens on a port.
- Dependencies are already installed. Don't reinstall them unless the brief says the lockfile changed.
- Post GitHub comments with \`gh ... --body-file <tmpfile>\` so markers and quotes survive the shell.`

const MARKER_RULES = `## Hidden markers
Machine state goes in GitHub comments as one line: \`<!-- build:<type> <json> -->\`, with the JSON on one line. Copy marker JSON exactly as given; don't add fields.`

const RULES = `## Rules for every agent in this run
1. Follow every AGENTS.md in the repo (root and nested). Read them.
2. Tests before code. The test-writer commits failing tests before any code exists.
3. Verification means build, lint (if the repo has a linter), and EVERY test suite, not only related tests. AGENTS.md verification guidance adds checks on top, and wins only where it directly conflicts.
4. Judgment call: any decision the issue didn't dictate (naming, file placement, choosing between two fine approaches, filling a small gap, skipping a test). Make it, record it, keep going.
5. Recommendation: an improvement you considered and chose not to do, usually because doing it would be a blocker. Record it.
6. Blockers. Stop and return a blocker ONLY for one of these:
   1. The spec or issue contradicts itself or the code, or can't be done as written.
   2. Following AGENTS.md would break the issue's requirements, or the reverse.
   3. The issue can't be done without something the spec didn't call for: a new dependency of any kind (library, package, remote AI service, file I/O, DB connection, network call), a data-format change, a public API change, or a deploy/secrets config change. If a lesser path exists, take it, record a judgment call, and add a recommendation instead.
   4. Verification already fails on the starting code, before any work.
   5. A review finding is still open after 3 review rounds. (The script decides this one.)
   6. The issue requires changing security behavior: auth, sessions, permissions, secrets or keys, encryption, input validation or sanitizing, CORS/CSP/headers, how personal data is stored or sent. A security bug that a reviewer finds in code this run just wrote is NOT a blocker: fix it and record it.
   7. Verification still fails after 3 verify-repair cycles. (The script decides this one.)
   Big refactors are allowed and are not blockers.
   Blocker scope: "branch" (default) pauses this issue and the issues that depend on it. "graph" means a spec-level problem that affects issues outside this branch; all work stops.
7. Report file: append each judgment call and each recommendation you return to ${REPORT_FILE} as one line each:
   \`- #<issue> <role>: judgment: <text>\` or \`- #<issue> <role>: recommendation: <text>\`
   Create the directory if needed (\`mkdir -p\`). Append only; never rewrite the file.`

function blockerHowTo(n, role) {
  return `## If you hit a blocker
Stop work. Post ONE comment on issue #${n} (for scope "graph": on spec issue #${SPEC}) that says in plain words what blocks you, the options (A, B, ...), and your recommendation. End the comment with this marker line, filled in:
${markerText('blocker', { issue: n, type: 1, scope: 'branch', question: '...', options: ['A) ...', 'B) ...'], recommendation: '...' })}
Then return the same blocker object in your result. Otherwise return blocker: null.
Your role name for the report file is "${role}".`
}

function issueText(issue) {
  return `## Issue #${issue.number}: ${issue.title}
${issue.body || '(no body)'}

## Spec issue #${SPEC}: ${S.spec.title}
${S.spec.body || '(no body)'}`
}

function branchText(ctx) {
  const p = ctx.plan
  const lines = [`## Branch
- Issue branch: \`${ctx.branch}\`. Its PR targets \`${p.base}\`.`]
  if (p.extraParents.length) {
    lines.push(`- This issue depends on more than one unmerged issue. The branch starts from \`${p.start}\` and also has ${p.extraParents.map(e => `\`origin/${branchOf(e)}\``).join(', ')} merged in (merge commits).`)
  }
  return lines.join('\n')
}

function rebuildText(ctx) {
  if (!ctx.rebuildReason) return ''
  return `## This is a rebuild
Issue #${ctx.n} already has PR #${ctx.prNumber} on branch \`${ctx.branch}\`. New decisions affect it: ${ctx.rebuildReason}
Change the existing branch to match the decisions. Keep earlier work that still fits.`
}

// Everything after the brief. The brief goes first, word for word, so these agents share a prompt-cache prefix.
function afterBrief(ctx, role) {
  return [
    WORKTREE_RULES,
    RULES,
    MARKER_RULES,
    issueText(ctx.issue),
    branchText(ctx),
    rebuildText(ctx),
    decisionsText(ctx.issue),
    blockerHowTo(ctx.n, role),
  ].filter(Boolean).join('\n\n')
}

function withBrief(ctx, role, task) {
  return `${ctx.brief}\n\n${afterBrief(ctx, role)}\n\n## Your task (${role})\n${task}`
}

// ---------- prompts ----------

function scoutPrompt(ctx) {
  const p = ctx.plan
  const checkout = ctx.branchExists
    ? `git -C ${WT} fetch origin && git -C ${WT} checkout -B ${ctx.branch} origin/${ctx.branch} && git -C ${WT} reset --hard origin/${ctx.branch} && git -C ${WT} clean -fd`
    : `git -C ${WT} fetch origin && git -C ${WT} checkout --detach ${p.start} && git -C ${WT} reset --hard ${p.start} && git -C ${WT} clean -fd`
  return `You are the scout for issue #${ctx.n}. You write a facts-only brief. You do not design or propose a solution.

${WORKTREE_RULES}

${RULES}

${issueText(ctx.issue)}

${branchText(ctx)}

${rebuildText(ctx)}

${decisionsText(ctx.issue)}

${blockerHowTo(ctx.n, 'scout')}

## Your task (scout)
First reset the worktree (this throws away any unfinished work left by an earlier run, on purpose):
\`${checkout}\`
Then read the code. Don't change any files.

Write the brief. It goes word for word to the test-writer, implementer, and verifier. It never goes to reviewers. Cover:
- Related files and modules, with paths.
- The AGENTS.md rules that apply to this issue, quoted or closely paraphrased, with their file paths.
- Model tests to copy, and the test layer/seam to use (unit, integration, e2e, UI), with paths. Say whether the repo has e2e or UI tests that can check copy and styling.
- The exact verify commands: build, lint (if any), EVERY test suite, plus anything AGENTS.md adds. Include port and env setup, using only the allowed ports.
- Facts that look like blockers (see the blocker list), stated plainly.
No design proposal, no plan, no opinion on how to build it.

Start the brief with the line "# Brief for issue #${ctx.n}". Return verifyCommands as the list of exact shell commands.`
}

function testWriterPrompt(ctx) {
  const p = ctx.plan
  const create = ctx.branchExists
    ? `The branch exists. Stay on \`${ctx.branch}\` (the scout checked it out).`
    : [
        `Create the branch: \`git -C ${WT} checkout -b ${ctx.branch} ${p.start}\`.`,
        ...p.extraParents.map(e => `Merge \`origin/${branchOf(e)}\` into it with a merge commit (\`git merge --no-ff\`). Resolve conflicts only if they are mechanical; otherwise it's blocker 1.`),
      ].join('\n')
  return withBrief(ctx, 'test-writer', `${create}

Write the tests for this issue, before any code exists:
- Run them. Confirm each new test fails for the expected reason: the missing behavior, not a typo, import error, or broken setup. Fix the test if it fails for the wrong reason.
- Pure refactor: existing tests must cover the code being moved. If they don't, write tests that PASS on the current code first.
- Copy and styling get tests when the repo has e2e or UI tests that can check them.
- Every case you leave untested is a judgment call. List it in untestedCases AND in judgmentCalls.
- Don't write any non-test code.

Commit only the tests, then push: \`git -C ${WT} push -u origin ${ctx.branch}\`.
Then post a comment on issue #${ctx.n} that says tests are committed, ending with this marker (fill in the commit sha):
${markerText('progress', { issue: ctx.n, step: 'tests-committed', round: 0, commit: '<sha>', pr: ctx.prNumber || null })}

Return testCommit (the sha), testFiles, failureCheck (how each test failed and why that's the expected reason), pureRefactor, untestedCases.`)
}

function implementerPrompt(ctx) {
  return withBrief(ctx, 'implementer', `Write the code for this issue on branch \`${ctx.branch}\`.
- The tests in commit ${ctx.testCommit} define the behavior. Don't amend, revert, or rewrite that commit.
- If you believe a test is wrong, you may change it in a new commit, but you must record a judgment call that says why, and list the file in testChanges. The verifier checks the test diff against your list.
- Run the verify commands from the brief yourself before you finish.
- Commit your work. Don't push; the script pushes after verification passes.
Return headCommit (the sha of HEAD), a short summary for the PR description, testChanges, and replies: [].`)
}

function repairPrompt(ctx, v, r, cycle) {
  return withBrief(ctx, 'implementer', `Verification failed (review round ${r}, cycle ${cycle}). Fix the failures on branch \`${ctx.branch}\`.

## Verifier report
Commands run: ${v.commandsRun.join(' ; ')}
Main checkout clean: ${v.mainCheckoutClean}. Test diff ok: ${v.testDiffOk}.
${v.failures}

- Don't change the test commit ${ctx.testCommit}. A test change needs a judgment call and a testChanges entry.
- If the main checkout at ${MAIN} has changes that you or an earlier agent made by mistake, move that work into the worktree and restore only those files in the main checkout. Never touch changes that were already there before this run:
${BASELINE ? BASELINE : '(it was clean)'}
- Commit your fixes. Don't push.
Return headCommit, a short summary, testChanges (all test changes after ${ctx.diffBase}), and replies: [].`)
}

function fixPrompt(ctx, r, open) {
  const list = open.map(f => `- ${f.id} [${f.severity || 'n/a'}] from ${f.reviewer}: ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n  ${f.detail || ''}${f.reply && f.reply.action === 'argued' ? '\n  (You argued this before and the reviewer said it still stands.)' : ''}`).join('\n')
  return withBrief(ctx, 'implementer', `Review round ${r} on PR #${ctx.prNumber}. These findings are open:
${list}

For each finding, either fix it or argue against it:
- Fix: change the code, and add or change tests if the finding shows a missing case. Security bugs found by a reviewer get fixed (not a blocker).
- Argue: only if the finding is wrong or not worth it. Write a short, specific argument.
- Don't change the test commit ${ctx.testCommit}. A test change needs a judgment call and a testChanges entry.
- Read the full discussion with \`gh pr view ${ctx.prNumber} -R ${REPO} --comments\` if you need it.
- Commit your work. Don't push and don't post comments; the script posts your replies after verification passes.
Return headCommit, a short summary of this round's changes, testChanges (all test changes after ${ctx.diffBase}), and replies: one per finding, with action "fixed" or "argued" and the text to post (for "fixed", say what changed; the script adds the commit sha).`)
}

function verifyPrompt(ctx, r, cycle) {
  const tests = ctx.testChanges.length
    ? ctx.testChanges.map(t => `- ${t.file}: ${t.reason}`).join('\n')
    : `(none: no test file may change after ${ctx.diffBase})`
  return withBrief(ctx, 'verifier', `You are the verifier (review round ${r}, cycle ${cycle}). You check; you don't fix. Don't edit, commit, or push anything.

1. Stay on branch \`${ctx.branch}\` in ${WT}. Record \`git -C ${WT} rev-parse HEAD\` as headCommit.
2. Run build, lint (if the repo has one), and EVERY test suite, plus the AGENTS.md checks named in the brief. Brief's commands:
${(ctx.verifyCommands || []).map(c => `   - \`${c}\``).join('\n') || '   (none listed; find them from package files, CI config, and AGENTS.md)'}
   If a listed command is missing a suite you can see in the repo, run that suite too.
3. Test diff: run \`git -C ${WT} diff --stat ${ctx.diffBase} HEAD\` and look at test files. ${ctx.diffBase === ctx.testCommit ? 'Test files changed after the test commit' : `Test changes up to ${ctx.diffBase} already passed an earlier verifier. Test files changed after it`} must all be in this list, with a reason that makes sense:
${tests}
   Set testDiffOk false if any other test file changed, or if tests were deleted or weakened without a listed reason.
4. Main checkout: run \`git -C ${MAIN} status --porcelain\`. It must match this baseline exactly:
${BASELINE ? BASELINE : '(empty: the main checkout was clean)'}
   Set mainCheckoutClean false if anything differs.
passed = every command succeeded AND testDiffOk AND mainCheckoutClean.
failures: for each failure, the command, the exit code, and the useful tail of its output (enough to fix it). Empty string when passed.`)
}

function startVerifyPrompt(branch) {
  return `You are the start verifier for a /build run on spec issue #${SPEC}. You check that the starting code passes verification before any work begins. You don't fix anything.

${WORKTREE_RULES}

Steps:
1. \`git -C ${WT} fetch origin && git -C ${WT} checkout --detach origin/${branch} && git -C ${WT} reset --hard origin/${branch} && git -C ${WT} clean -fd\`. Record \`git -C ${WT} rev-parse HEAD\` as headCommit.
2. Find the verify commands: read every AGENTS.md, package files, Makefile, CI config. Run build, lint (if any), and EVERY test suite, plus AGENTS.md checks.
3. Check \`git -C ${MAIN} status --porcelain\` matches this baseline exactly:
${BASELINE ? BASELINE : '(empty: the main checkout was clean)'}
passed = every command succeeded AND the main checkout matches. testDiffOk: true (no test commit yet).
failures: for each failure, the command, the exit code, and the useful tail of its output.`
}

function reviewPrompt(ctx, type, r, mine) {
  const prior = mine.length
    ? `## Your findings from earlier rounds
${mine.map(f => `- ${f.id}: ${f.title} — status: ${f.status}${f.reply ? `; implementer replied (${f.reply.action}): ${f.reply.text}` : ''}`).join('\n')}

For each one with status "argued": decide whether the argument holds. For each with status "fixed": check that the fix works. Post one PR comment per decision saying "withdrawn" or "still stands" and why, ending with:
${markerText('verdict', { finding: '<id>', verdict: 'withdrawn' })}
(use "stands" when it still stands). Return each decision in verdicts. A finding with status "open" that you didn't get a reply on stays open; don't repeat it as a new finding.`
    : ''
  return `You are the reviewer "${type}" for PR #${ctx.prNumber} (issue #${ctx.n}), review round ${r}.

Review commit ${ctx.head} on branch \`${ctx.branch}\` (PR base \`${ctx.plan.base}\`). Read it with \`gh pr diff ${ctx.prNumber} -R ${REPO}\` and \`git -C ${WT} show\` / \`git -C ${WT} diff\`. The worktree is ${WT}; it's read-only for you. Don't edit, commit, push, or check out anything.
The PR discussion so far: \`gh pr view ${ctx.prNumber} -R ${REPO} --comments\`.

${issueText(ctx.issue)}

${decisionsText(ctx.issue)}

${prior}

## Posting findings
Review the way your instructions say, in your usual format. Post each NEW finding as its own PR comment (\`gh pr comment ${ctx.prNumber} -R ${REPO} --body-file <tmpfile>\`). End each finding comment with this marker line, filled in:
${markerText('finding', { id: `${type}-r${r}-1`, reviewer: type, round: r, severity: 'high', title: '...' })}
Number ids ${type}-r${r}-1, ${type}-r${r}-2, and so on. Only post findings worth fixing. If you find nothing new, post nothing for new findings.
Return findings (the new ones, same ids) and verdicts.

## Judgment calls
If you make a judgment call or recommendation, append it to ${REPORT_FILE} as \`- #${ctx.n} review:${type}: judgment: <text>\` (or \`recommendation:\`), and return it. Reviewers don't raise blockers: return blocker: null.`
}

function gitPrompt(task, returns) {
  return `You run git and gh commands for a /build run. Do exactly the steps below, nothing else. Don't edit files.

${WORKTREE_RULES}

${MARKER_RULES}

## Steps
${task}

${returns || 'Return ok (true only if every step succeeded) and error (empty string if ok; else the failing command and its output).'}`
}

function commentStep(target, body) {
  return `Post this comment on ${target} with --body-file (write the text to a temp file exactly as shown between the lines):
-----
${body}
-----`
}

// ---------- git and GitHub steps ----------

async function postBlocker(n, blocker, phaseName) {
  const target = blocker.scope === 'graph' ? `issue #${SPEC}` : `issue #${n}`
  const body = `**/build blocked (type ${blocker.type}, ${blocker.scope} scope)**

${blocker.question}

Options:
${blocker.options.map(o => `- ${o}`).join('\n')}

Recommendation: ${blocker.recommendation}

Answer with a comment that starts with \`Decision:\`, then rerun \`/build ${SPEC}\`.

${markerText('blocker', { issue: n, ...blocker })}`
  await call(`#${n === SPEC ? 'spec' : n} git`, gitPrompt(commentStep(`${target} (\`gh issue comment\`)`, body)), {
    schema: GIT_SCHEMA, model: MODEL.git, phase: phaseName,
  })
}

async function failWithBlocker(n, blocker, phaseName) {
  await postBlocker(n, blocker, phaseName)
  throw new Blocked(blocker)
}

function checkBlocker(result) {
  if (result && result.blocker) throw new Blocked(result.blocker)
}

function prBody(ctx, summary) {
  const p = ctx.plan
  const lines = [`Resolves #${ctx.n} (part of spec #${SPEC}).`, '', summary, '']
  if (HIL && p.targetParent) {
    const parentPr = results.get(p.targetParent).pr
    lines.push(`Stacked on PR #${parentPr} (\`${p.base}\`). Merge that PR first.`)
  }
  if (p.mergeOrder.length) {
    const prs = p.mergeOrder.map(i => (i === ctx.n ? 'this PR' : `#${results.get(i).pr} (issue #${i})`))
    lines.push(`This issue depends on more than one unmerged issue. Merge order: ${prs.join(', then ')}.`)
    lines.push(`This PR targets \`${p.base}\`, so its diff also includes the changes from ${p.extraParents.map(e => `#${results.get(e).pr}`).join(', ')}, which are merged into this branch.`)
  }
  if (!HIL) lines.push(`Targets the spec branch \`${SPEC_BRANCH}\`. Agents merge it with a merge commit.`)
  lines.push('', `Built by /build. Judgment calls, recommendations, and review notes are in the report comment on #${SPEC}.`)
  return lines.join('\n')
}

async function publish(ctx, summary, phaseName) {
  const steps = [
    `1. Check HEAD: \`git -C ${WT} rev-parse HEAD\` must be ${ctx.head}. If not, stop with ok=false.`,
    `2. Push: \`git -C ${WT} push origin HEAD:refs/heads/${ctx.branch}\`. If the push is rejected, stop with ok=false. Don't force-push.`,
    `3. ${commentStep(`issue #${ctx.n} (\`gh issue comment\`)`, `Code pushed (${ctx.head}).\n\n${markerText('progress', { issue: ctx.n, step: 'code-pushed', round: 0, commit: ctx.head, pr: ctx.prNumber || null })}`)}`,
  ]
  if (ctx.prNumber) {
    steps.push(`4. PR #${ctx.prNumber} already exists. Return prNumber ${ctx.prNumber} and its URL.`)
  } else {
    steps.push(`4. If an open PR from \`${ctx.branch}\` already exists, use it. Otherwise open one: \`gh pr create -R ${REPO} --head ${ctx.branch} --base ${ctx.plan.base} --title <title> --body-file <tmpfile>\`.
   Title: ${ctx.issue.title} (#${ctx.n})
   Body (exactly):
-----
${prBody(ctx, summary)}
-----`)
    steps.push(`5. ${commentStep(`issue #${ctx.n} (\`gh issue comment\`)`, `PR opened.\n\n${markerText('progress', { issue: ctx.n, step: 'pr-opened', round: 0, commit: ctx.head, pr: '<PR number>' })}`)}
   Replace "<PR number>" with the PR number as a JSON number (no quotes).`)
  }
  steps.push('Return prNumber, prUrl, and headCommit.')
  const g = await call(`#${ctx.n} git`, gitPrompt(steps.join('\n')), { schema: GIT_SCHEMA, model: MODEL.git, phase: phaseName })
  if (!g.ok || !g.prNumber) throw new Error(`publishing #${ctx.n} failed: ${g.error}`)
  ctx.prNumber = g.prNumber
}

async function postRound(ctx, r, replies, phaseName) {
  const steps = [
    `1. Check HEAD: \`git -C ${WT} rev-parse HEAD\` must be ${ctx.head}. If not, stop with ok=false.`,
    `2. Push: \`git -C ${WT} push origin HEAD:refs/heads/${ctx.branch}\`. Don't force-push.`,
  ]
  replies.forEach((rep, i) => {
    const commit = rep.action === 'fixed' ? ctx.head : null
    const head = rep.action === 'fixed' ? `Re ${rep.finding}: fixed in ${ctx.head}.` : `Re ${rep.finding}: argued.`
    const body = `${head}\n\n${rep.text}\n\n${markerText('reply', { finding: rep.finding, action: rep.action, commit })}`
    steps.push(`${i + 3}. ${commentStep(`PR #${ctx.prNumber} (\`gh pr comment\`)`, body)}`)
  })
  steps.push(`${replies.length + 3}. ${commentStep(`issue #${ctx.n} (\`gh issue comment\`)`, `Review round ${r} answered.\n\n${markerText('progress', { issue: ctx.n, step: 'review-round', round: r, commit: ctx.head, pr: ctx.prNumber })}`)}`)
  const g = await call(`#${ctx.n} git r${r}`, gitPrompt(steps.join('\n')), { schema: GIT_SCHEMA, model: MODEL.git, phase: phaseName })
  if (!g.ok) throw new Error(`posting review round ${r} for #${ctx.n} failed: ${g.error}`)
}

async function markDone(ctx, phaseName) {
  const body = `Done: PR #${ctx.prNumber} passed verification and review.\n\n${markerText('done', { issue: ctx.n, pr: ctx.prNumber })}`
  const g = await call(`#${ctx.n} git`, gitPrompt(commentStep(`issue #${ctx.n} (\`gh issue comment\`)`, body)), {
    schema: GIT_SCHEMA, model: MODEL.git, phase: phaseName,
  })
  if (!g.ok) throw new Error(`marking #${ctx.n} done failed: ${g.error}`)
}

async function mergeIntoSpec(ctx, phaseName) {
  const m = await call(`#${ctx.n} merger`, gitPrompt(`1. Merge PR #${ctx.prNumber} into \`${SPEC_BRANCH}\` with a merge commit: \`gh pr merge ${ctx.prNumber} -R ${REPO} --merge\`. Never squash or rebase. Never merge anything into \`${DEFAULT}\`.
2. Confirm: \`gh pr view ${ctx.prNumber} -R ${REPO} --json state,mergeCommit\` shows MERGED.
3. ${commentStep(`issue #${ctx.n} (\`gh issue comment\`)`, `Merged PR #${ctx.prNumber} into \`${SPEC_BRANCH}\`.\n\n${markerText('progress', { issue: ctx.n, step: 'merged', round: 0, commit: '<merge commit sha>', pr: ctx.prNumber })}\n${markerText('done', { issue: ctx.n, pr: ctx.prNumber })}`)}
   Replace "<merge commit sha>" with the merge commit sha.`, 'Return merged (true only if the PR is merged), mergeCommit (empty string if not), and error (empty string if merged; else the failing command and its output).'), {
    schema: MERGE_SCHEMA, model: MODEL.merger, phase: phaseName,
  })
  if (!m.merged) {
    await failWithBlocker(ctx.n, {
      type: 1, scope: 'branch',
      question: `PR #${ctx.prNumber} could not be merged into ${SPEC_BRANCH}: ${m.error}`,
      options: ['A) Fix the merge problem by hand, then rerun /build', 'B) Close the PR and let /build rebuild the issue'],
      recommendation: 'A',
    }, phaseName)
  }
}

// ---------- verify-repair loop ----------

async function verifyLoop(ctx, r, phaseName) {
  for (let cycle = 1; ; cycle++) {
    const v = await call(`#${ctx.n} verifier r${r} c${cycle}`, verifyPrompt(ctx, r, cycle), {
      schema: VERIFY_SCHEMA, model: MODEL.verifier, phase: phaseName,
    })
    if (v.passed) {
      ctx.head = v.headCommit
      return
    }
    if (cycle > MAX_REPAIRS) {
      await failWithBlocker(ctx.n, {
        type: 7, scope: 'branch',
        question: `Verification still fails after ${MAX_REPAIRS} verify-repair cycles on \`${ctx.branch}\`.\n\n${v.failures}`,
        options: ['A) Give guidance on the failure in a Decision comment', 'B) Fix the branch by hand, then rerun /build'],
        recommendation: 'A',
      }, phaseName)
    }
    const fix = await call(`#${ctx.n} implementer r${r} c${cycle}`, repairPrompt(ctx, v, r, cycle), {
      schema: IMPL_SCHEMA, model: MODEL.implementer, phase: phaseName,
    })
    checkBlocker(fix)
    ctx.testChanges = fix.testChanges
  }
}

// ---------- review rounds ----------

function seedFindings(issue) {
  const pr = issue.pr
  if (!pr || !pr.findings) return []
  return pr.findings.filter(f => f.open).map(f => ({ ...f, status: 'open' }))
}

async function reviewRounds(ctx, firstRound, phaseName) {
  const findings = seedFindings(ctx.issue)
  for (let r = firstRound; r <= MAX_ROUNDS; r++) {
    const outs = await parallel(REVIEWERS.map(type => () =>
      call(`#${ctx.n} review:${type} r${r}`, reviewPrompt(ctx, type, r, findings.filter(f => f.reviewer === type && f.status !== 'withdrawn' && f.status !== 'closed')), {
        schema: REVIEW_SCHEMA, agentType: type, phase: phaseName,
      })))
    if (stopped) throw new StopRun(stopped)
    outs.forEach((out, i) => {
      if (!out) throw new Error(`reviewer ${REVIEWERS[i]} failed on #${ctx.n} round ${r}`)
    })

    // Apply verdicts, then close fixed findings nobody said still stand.
    outs.forEach((out, i) => {
      const type = REVIEWERS[i]
      for (const v of out.verdicts) {
        const f = findings.find(x => x.id === v.finding)
        if (f) f.status = v.verdict === 'withdrawn' ? 'withdrawn' : 'open'
      }
      for (const f of findings) if (f.reviewer === type && f.status === 'fixed') f.status = 'closed'
      for (const nf of out.findings) {
        if (!findings.some(x => x.id === nf.id)) findings.push({ ...nf, reviewer: type, round: r, status: 'open' })
      }
    })

    const open = findings.filter(f => f.status === 'open' || f.status === 'argued')
    if (!open.length) return
    if (r === MAX_ROUNDS) {
      await failWithBlocker(ctx.n, {
        type: 5, scope: 'branch',
        question: `${open.length} review finding(s) on PR #${ctx.prNumber} are still open after ${MAX_ROUNDS} review rounds: ${open.map(f => `${f.id} (${f.title})`).join('; ')}. The discussion is on the PR.`,
        options: ['A) Side with the implementer: the findings can stay open', 'B) Side with the reviewer: say how to fix them in a Decision comment'],
        recommendation: 'B',
      }, phaseName)
    }

    const fix = await call(`#${ctx.n} implementer r${r}`, fixPrompt(ctx, r, open), {
      schema: IMPL_SCHEMA, model: MODEL.implementer, phase: phaseName,
    })
    checkBlocker(fix)
    ctx.testChanges = fix.testChanges
    await verifyLoop(ctx, r, phaseName)
    await postRound(ctx, r, fix.replies, phaseName)
    for (const rep of fix.replies) {
      const f = findings.find(x => x.id === rep.finding)
      if (f) {
        f.status = rep.action
        f.reply = rep
      }
    }
  }
}

// ---------- one issue ----------

async function workIssue(issue, rebuildReason) {
  const n = issue.number
  const phaseName = `Issue #${n}`
  phase(phaseName)

  if (HIL) await checkMergedParents(n, phaseName)

  const resume = rebuildReason ? { at: -1, testCommit: null, verifiedCommit: null, lastRound: 0 } : resumePoint(issue)
  const openPr = issue.pr && issue.pr.state === 'OPEN' ? issue.pr.number : null
  const ctx = {
    n, issue,
    branch: branchOf(n),
    branchExists: !!(issue.branch && issue.branch.exists) || resume.at >= 0,
    plan: branchPlan(n),
    prNumber: openPr,
    rebuildReason: rebuildReason || null,
    testCommit: resume.testCommit,
    // The verifier's test diff starts here. On resume after code-pushed it is the last verified
    // commit, because the earlier run's testChanges list (with its reasons) is gone.
    diffBase: resume.at >= STEPS.indexOf('code-pushed') && resume.verifiedCommit ? resume.verifiedCommit : resume.testCommit,
    testChanges: [],
    head: null,
    brief: '',
    verifyCommands: [],
  }
  if (rebuildReason) log(`#${n}: rebuilding PR #${openPr}: ${rebuildReason}`)
  else if (resume.at >= 0) log(`#${n}: resuming after "${STEPS[resume.at]}"`)

  const scout = await call(`#${n} scout`, scoutPrompt(ctx), { schema: SCOUT_SCHEMA, model: MODEL.scout, phase: phaseName })
  checkBlocker(scout)
  ctx.brief = scout.brief
  ctx.verifyCommands = scout.verifyCommands

  if (resume.at < STEPS.indexOf('tests-committed') || !ctx.testCommit) {
    const tests = await call(`#${n} test-writer`, testWriterPrompt(ctx), { schema: TESTS_SCHEMA, model: MODEL.testWriter, phase: phaseName })
    checkBlocker(tests)
    ctx.testCommit = tests.testCommit
    ctx.diffBase = tests.testCommit
    ctx.branchExists = true
  }

  if (resume.at < STEPS.indexOf('code-pushed')) {
    const impl = await call(`#${n} implementer r0`, implementerPrompt(ctx), { schema: IMPL_SCHEMA, model: MODEL.implementer, phase: phaseName })
    checkBlocker(impl)
    ctx.testChanges = impl.testChanges
    await verifyLoop(ctx, 0, phaseName)
    await publish(ctx, impl.summary, phaseName)
  } else if (resume.at < STEPS.indexOf('pr-opened') || !ctx.prNumber) {
    await verifyLoop(ctx, 0, phaseName)
    await publish(ctx, 'See the issue for the full description.', phaseName)
  } else {
    ctx.head = issue.pr.headRefOid
  }

  if (resume.at < STEPS.indexOf('merged')) {
    const firstRound = resume.at === STEPS.indexOf('review-round') ? resume.lastRound + 1 : 1
    if (firstRound <= MAX_ROUNDS) await reviewRounds(ctx, firstRound, phaseName)
    if (HIL) {
      await markDone(ctx, phaseName)
    } else {
      await mergeIntoSpec(ctx, phaseName)
    }
  }

  setResult(n, { outcome: HIL ? 'done' : 'merged', pr: ctx.prNumber, base: ctx.plan.base })
  if (rebuildReason && HIL) await updateStackedChildren(n, issue, phaseName)
}

// ---------- rebases ----------

function rebaseSteps(items) {
  return items.map((it, i) => `${i + 1}. Issue #${it.issue}, branch \`${it.branch}\` (PR #${it.pr}):
   - \`git -C ${WT} fetch origin\`. If \`${it.oldBase}\` is not an ancestor of \`origin/${it.branch}\` (\`git merge-base --is-ancestor\`), skip it: nothing to do.
   - Otherwise: \`git -C ${WT} checkout -B ${it.branch} origin/${it.branch}\`, then \`git -C ${WT} rebase --onto ${it.onto} ${it.oldBase} ${it.branch}\`. This replaces the old parent commits with the new ones.
   - On a conflict: \`git rebase --abort\`, list it in conflicts with a short detail, move on.
   - Run the repo's build and every test suite (find the commands in AGENTS.md and package files). If anything fails, list the issue in verifyFailed and DON'T push it.
   - Otherwise push: \`git -C ${WT} push --force-with-lease=${it.branch}:${it.expectHead} origin ${it.branch}\`.
   - List it in rebased.`).join('\n')
}

function rebasePrompt(intro, items) {
  return `You are the rebaser for a /build run on spec issue #${SPEC}. ${intro}

${WORKTREE_RULES}

## Steps
${rebaseSteps(items)}

Return rebased, conflicts, and verifyFailed (issue numbers).`
}

async function handleRebaseResult(res, items, phaseName) {
  for (const c of res.conflicts) {
    const it = items.find(x => x.issue === c.issue)
    await postBlocker(c.issue, {
      type: 1, scope: 'branch',
      question: `Rebasing \`${it ? it.branch : `issue #${c.issue}`}\` onto \`${it ? it.onto : 'its new base'}\` hit a conflict: ${c.detail}`,
      options: ['A) Resolve the conflict by hand and push, then rerun /build', 'B) Close the PR so /build rebuilds the issue from scratch'],
      recommendation: 'A',
    }, phaseName)
    setResult(c.issue, {
      outcome: 'blocked', pr: it && it.pr,
      blocker: { type: 1, scope: 'branch', question: `rebase conflict: ${c.detail}`, options: [], recommendation: 'A' },
    })
  }
  for (const v of res.verifyFailed) {
    const reason = 'its branch was rebased onto a new base and verification failed afterward'
    if (results.get(v) && results.get(v).outcome === 'done') {
      results.delete(v)
      rebuildReasons.set(v, reason)
    }
  }
}

const PARENT_CHECK_SCHEMA = {
  type: 'object',
  required: ['merged', 'badMerges', 'error'],
  properties: { merged: { type: 'array', items: INT }, badMerges: { type: 'array', items: INT }, error: STR },
}

// Before each issue: a parent PR may have merged during this run. In true mode PRs must be merged
// with merge commits. Then a stacked branch needs no change: its parent's commits are already on
// the default branch. A squash or rebase merge leaves the stacked branch on commits that the default
// branch doesn't have. /build doesn't repair that; it stops the issue with a blocker.
async function checkMergedParents(n, phaseName) {
  const open = parentsOf(n).filter(p => results.get(p).outcome === 'done')
  if (!open.length) return
  // The check is in scripts/check-parents.mjs. The agent only runs it.
  const parents = open.map(p => `${p}:${results.get(p).pr}`).join(',')
  const res = await call(`#${n} git`, gitPrompt(`Check the parent PRs of issue #${n}: run \`node ${PLUGIN_ROOT}/scripts/check-parents.mjs --repo ${REPO} --branch ${branchOf(n)} --parents ${parents}\`.`,
  'Return its merged and badMerges fields exactly as printed, and error: "". If it exits non-zero, return merged: [], badMerges: [], and error: its output word for word.'), { schema: PARENT_CHECK_SCHEMA, model: MODEL.git, phase: phaseName })
  if (res.error) {
    await failWithBlocker(n, {
      type: 1, scope: 'branch',
      question: `Checking the parent PRs of issue #${n} failed: ${res.error}`,
      options: ['A) Fix the cause, then rerun /build'],
      recommendation: 'A',
    }, phaseName)
  }
  for (const m of res.merged) {
    const r = results.get(m)
    if (r) r.outcome = 'merged'
  }
  // The script only reports a bad merge when this issue's branch still has the parent's commits.
  const bad = res.badMerges.filter(p => open.includes(p))
  if (!bad.length) return
  await failWithBlocker(n, {
    type: 1, scope: 'branch',
    question: badMergeText(bad.map(p => ({ issue: p, pr: results.get(p).pr })), n),
    options: [
      `A) Rebase \`${branchOf(n)}\` onto \`${DEFAULT}\` by hand (drop the parent's old commits), push, then rerun /build`,
      `B) Close the PR for issue #${n} and delete its branch, so /build rebuilds it from \`${DEFAULT}\``,
    ],
    recommendation: 'A',
  }, phaseName)
}

function badMergeText(parents, n) {
  const list = parents.map(p => `PR #${p.pr} (issue #${p.issue})`).join(', ')
  return `${list} was merged with squash or rebase. With human-in-loop=true, /build needs stacked PRs merged with merge commits. Branch \`${branchOf(n)}\` still has the parent's original commits, which \`${DEFAULT}\` doesn't have, so its PR would show them again and could conflict.`
}

// After a rebuilt issue: PRs stacked on it are rebased onto its new head.
async function updateStackedChildren(n, issue, phaseName) {
  const oldHead = issue.branch && issue.branch.oid
  if (!oldHead) return
  const items = childrenOf(n)
    .filter(c => results.get(c) && results.get(c).outcome === 'done' && issues.get(c).pr)
    .map(c => ({ issue: c, branch: branchOf(c), pr: results.get(c).pr, oldBase: oldHead, onto: `origin/${branchOf(n)}`, newBase: null, expectHead: issues.get(c).pr.headRefOid }))
  if (!items.length) return
  const res = await call(`#${n} rebaser`, rebasePrompt(`Issue #${n}'s branch was rebuilt. Rebase the PRs stacked on it onto its new head.`, items), {
    schema: REBASE_SCHEMA, model: MODEL.rebaser, phase: phaseName,
  })
  await handleRebaseResult(res, items, phaseName)
}

// ---------- sub-issue closed by hand (blocker 8) ----------

const CLOSED_OPTIONS = [
  'A) Treat it as done. Issues that depend on it continue without its changes.',
  'B) Reopen it and build it.',
  'C) Other: say what to do.',
]

function closedBlocker(issue, extra) {
  const pr = issue.pr && !issue.pr.merged ? ` Its PR #${issue.pr.number} is ${issue.pr.state.toLowerCase()} and not merged.` : ''
  const deps = childrenOf(issue.number)
  return {
    type: CLOSED_BLOCKER_TYPE,
    scope: 'branch',
    question: `Issue #${issue.number} ("${issue.title}") was closed by hand, and no PR for it was merged.${pr} How should /build handle it?${deps.length ? ` Issues that depend on it: ${deps.map(d => `#${d}`).join(', ')}.` : ''}${extra ? `\n\n${extra}` : ''}`,
    options: CLOSED_OPTIONS,
    recommendation: 'A if you closed it on purpose (the work is not needed, or was done elsewhere); otherwise B.',
  }
}

// Returns true when the issue should be built now (the Decision said to reopen it).
// Otherwise it sets the issue's result. Throws Blocked after posting a blocker.
async function handleClosed(issue) {
  const n = issue.number
  const phaseName = `Issue #${n}`
  phase(phaseName)
  const asked = currentBlocker(issue)
  // No type-8 question yet: ask it, one time. Status "blocked" (asked, no answer) never gets here.
  if (!asked) await failWithBlocker(n, closedBlocker(issue), phaseName)
  const answers = (issue.decisions || []).filter(d => isAfter(d.createdAt, asked.createdAt))
  const reading = await call(`#${n} decision-reader`, `You read a human's answer to one question and say which action it picks. Don't run any commands or change anything.

## The question, posted on issue #${n} in ${REPO}
${asked.data.question}

Options:
${(asked.data.options || []).map(o => `- ${o}`).join('\n')}

## The answer (Decision comments, word for word)
${answers.map(d => `--- ${d.createdAt}, by ${d.author} ---\n${d.body}`).join('\n')}

## Return
- action "treat-as-done": the answer says to treat the issue as done (option A or the same meaning). The issue stays closed and the issues that depend on it continue.
- action "build": the answer says to reopen the issue and build it (option B or the same meaning).
- action "unclear": anything else, including an answer that asks for something other than these two. A new question will be posted.
- reason: one plain sentence on how you read it.`, { schema: DECISION_SCHEMA, model: MODEL.decisionReader, phase: phaseName })

  if (reading.action === 'treat-as-done') {
    const body = `Treated as done, per the Decision above. No PR. Issues that depend on #${n} continue.\n\n${markerText('done', { issue: n, pr: null })}`
    const g = await call(`#${n} git`, gitPrompt(commentStep(`issue #${n} (\`gh issue comment\`)`, body)), {
      schema: GIT_SCHEMA, model: MODEL.git, phase: phaseName,
    })
    if (!g.ok) throw new Error(`recording #${n} as done failed: ${g.error}`)
    setResult(n, { outcome: 'closed-done', reason: `closed by hand; Decision read as: ${reading.reason}` })
    return false
  }
  if (reading.action === 'build') {
    const g = await call(`#${n} git`, gitPrompt(`1. Reopen the issue: \`gh issue reopen ${n} -R ${REPO}\`.`), {
      schema: GIT_SCHEMA, model: MODEL.git, phase: phaseName,
    })
    if (!g.ok) throw new Error(`reopening #${n} failed: ${g.error}`)
    issue.state = 'OPEN'
    return true
  }
  return failWithBlocker(n, closedBlocker(issue, `The last Decision didn't clearly pick an option (${reading.reason}). Please answer again.`), phaseName)
}

// ---------- startup ----------

function classifyFromState() {
  for (const n of S.order) {
    const iss = issues.get(n)
    if (!iss) continue
    const pr = iss.pr
    if (iss.status === 'closed-done') {
      setResult(n, { outcome: 'closed-done', reason: 'closed by hand; a Decision said to treat it as done' })
    } else if (iss.status === 'merged') {
      setResult(n, { outcome: 'merged', pr: pr.number, base: pr.baseRefName })
    } else if (iss.status === 'done') {
      setResult(n, { outcome: 'done', pr: pr.number, base: pr.baseRefName })
    } else if (iss.status === 'blocked') {
      const b = currentBlocker(iss)
      setResult(n, { outcome: 'blocked', pr: pr && pr.number, blocker: b ? b.data : null })
    }
  }
}

function openGraphBlocker() {
  const b = lastMarker(S.spec.markers, 'blocker')
  if (!b) return null
  const d = newestDecision(S.spec.decisions)
  return d && isAfter(d.createdAt, b.createdAt) ? null : b.data
}

async function ensureSpecBranch() {
  if (HIL || (S.specBranch && S.specBranch.exists)) return false
  const g = await call('#spec git', gitPrompt(`1. \`git -C ${WT} fetch origin\`.
2. If \`origin/${SPEC_BRANCH}\` exists, stop with ok=true.
3. Otherwise create it from the default branch and push: \`git -C ${WT} push origin origin/${DEFAULT}:refs/heads/${SPEC_BRANCH}\`.`), {
    schema: GIT_SCHEMA, model: MODEL.git, phase: 'Startup',
  })
  if (!g.ok) throw new Error(`creating ${SPEC_BRANCH} failed: ${g.error}`)
  return true
}

async function recheckAnsweredPrs() {
  const finished = S.order.filter(n => {
    const r = results.get(n)
    return r && (r.outcome === 'done' || r.outcome === 'merged')
  })
  const anyDecisions = (S.spec.decisions || []).length || S.issues.some(i => (i.decisions || []).length)
  if (!finished.length || !anyDecisions) return
  const listing = finished.map(n => {
    const iss = issues.get(n)
    return `- issue #${n} "${iss.title}": PR #${results.get(n).pr} (${results.get(n).outcome}), branch \`${branchOf(n)}\``
  }).join('\n')
  const decisions = [
    ...(S.spec.decisions || []).map(d => `--- spec issue #${SPEC}, ${d.createdAt}, by ${d.author} ---\n${d.body}`),
    ...S.issues.flatMap(i => (i.decisions || []).map(d => `--- issue #${i.number}, ${d.createdAt}, by ${d.author} ---\n${d.body}`)),
  ].join('\n')
  const res = await call('#spec recheck', `You check whether human decisions affect PRs that /build already finished, for spec issue #${SPEC} in ${REPO}.

## Finished PRs
${listing}

## Decision comments (word for word)
${decisions}

For each finished PR, read its diff (\`gh pr diff <n> -R ${REPO}\`) and its creation and last-push time (\`gh pr view <n> -R ${REPO} --json createdAt,commits\`). A PR is affected when a decision changes what that PR's code should do, and the PR doesn't already reflect it (for example the PR was built before the decision). Decisions on other issues can affect a PR too.
Don't change anything. Return affected: the issue numbers with a one-line reason each. Append judgment calls to ${REPORT_FILE} as \`- #spec recheck: judgment: <text>\`. Return blocker: null.`, {
    schema: RECHECK_SCHEMA, model: MODEL.recheck, phase: 'Startup',
  })
  for (const a of res.affected) {
    const r = results.get(a.issue)
    if (!r) continue
    if (r.outcome === 'merged') {
      const blocker = {
        type: 1, scope: 'branch',
        question: `A new decision affects PR #${r.pr}, which is already merged: ${a.reason}`,
        options: ['A) Open a follow-up issue for the change', 'B) Ignore the decision for this PR'],
        recommendation: 'A',
      }
      await postBlocker(a.issue, blocker, 'Startup')
      setResult(a.issue, { outcome: 'blocked', pr: r.pr, blocker })
    } else if (r.outcome === 'done') {
      results.delete(a.issue)
      rebuildReasons.set(a.issue, a.reason)
    }
  }
}

async function startup() {
  phase('Startup')
  const specBranchCreated = await ensureSpecBranch()
  if (args.needsStartVerify || specBranchCreated) {
    const branch = HIL ? DEFAULT : SPEC_BRANCH
    const v = await call('#spec start-verifier', startVerifyPrompt(branch), { schema: VERIFY_SCHEMA, model: MODEL.verifier, phase: 'Startup' })
    if (!v.passed) {
      const blocker = {
        type: 4, scope: 'graph',
        question: `Verification already fails on \`${branch}\` (${v.headCommit}) before any work.\n\n${v.failures}`,
        options: ['A) Fix the starting branch, then rerun /build', 'B) Tell /build which failures to ignore in a Decision comment'],
        recommendation: 'A',
      }
      await postBlocker(SPEC, blocker, 'Startup')
      graphBlocker = blocker
      stopped = 'graph-blocker'
      return
    }
    startOid = v.headCommit
  }
  if (args.isRerun) {
    await recheckAnsweredPrs()
  }
}

// ---------- main ----------

async function main() {
  if ((S.graphErrors || []).length) {
    notes.push(`Graph errors (startup checks should have refused): ${S.graphErrors.join('; ')}`)
    return
  }
  classifyFromState()
  const g = openGraphBlocker()
  if (g) {
    graphBlocker = g
    stopped = 'graph-blocker'
    notes.push('A whole-graph blocker on the spec issue has no Decision yet.')
    return
  }

  try {
    await startup()
  } catch (e) {
    if (!(e instanceof StopRun)) throw e
  }
  if (stopped) return

  for (const n of S.order) {
    if (stopped) break
    if (results.has(n) || !issues.has(n)) continue
    try {
      // Closed by hand with no merged PR: ask (blocker 8), or act on the answer.
      if (issues.get(n).state === 'CLOSED' && !(await handleClosed(issues.get(n)))) continue
      const wait = blockingParents(n)
      if (wait.length) {
        setResult(n, { outcome: 'waiting', waitingOn: wait })
        continue
      }
      await workIssue(issues.get(n), rebuildReasons.get(n))
    } catch (e) {
      if (e instanceof StopRun) {
        setResult(n, { outcome: 'interrupted', pr: issues.get(n).pr && issues.get(n).pr.number, reason: `run stopped: ${stopped}` })
        break
      }
      if (e instanceof Blocked) {
        setResult(n, { outcome: 'blocked', pr: issues.get(n).pr && issues.get(n).pr.number, blocker: e.blocker })
        if (e.blocker.scope === 'graph') {
          graphBlocker = e.blocker
          stopped = 'graph-blocker'
          break
        }
        continue
      }
      const msg = `#${n} interrupted by an error: ${e && e.message ? e.message : String(e)}`
      log(msg)
      notes.push(msg)
      setResult(n, { outcome: 'interrupted', pr: issues.get(n).pr && issues.get(n).pr.number, reason: msg })
    }
  }

  if (!HIL && !stopped && S.order.every(n => ['merged', 'closed-done'].includes((results.get(n) || {}).outcome))) {
    phase('Finish')
    try {
      const g2 = await call('#spec git', gitPrompt(`1. If an open PR from \`${SPEC_BRANCH}\` to \`${DEFAULT}\` exists, use it.
2. Otherwise open one: \`gh pr create -R ${REPO} --head ${SPEC_BRANCH} --base ${DEFAULT} --title "${S.spec.title.replace(/"/g, "'")} (spec #${SPEC})" --body-file <tmpfile>\` with this body:
-----
Final PR for spec #${SPEC}. It merges every sub-issue PR, each already reviewed and merged into \`${SPEC_BRANCH}\`:
${S.order.map(n => (results.get(n).outcome === 'closed-done' ? `- #${n} → closed by hand, treated as done (no PR)` : `- #${n} → PR #${results.get(n).pr}`)).join('\n')}

A human merges this PR. The report is in a comment on #${SPEC}.
-----
Never merge it. Return prNumber and prUrl.`), { schema: GIT_SCHEMA, model: MODEL.git, phase: 'Finish' })
      if (g2.ok) finalPr = g2.prNumber
      else notes.push(`Opening the final PR failed: ${g2.error}`)
    } catch (e) {
      if (!(e instanceof StopRun)) throw e
    }
  }
}

await main()

const out = S.order.filter(n => issues.has(n)).map(n => results.get(n) || {
  number: n, outcome: 'waiting', pr: null, base: null, waitingOn: [], blocker: null,
  reason: stopped ? `not started: run stopped (${stopped})` : 'not started',
})
log(`Agents started: ${agentCount}`)
return { issues: out, graphBlocker, stopped, startOid, finalPr, agentCount, notes }
