// Builds the /build report comment for the spec issue and the chat summary.
//
// Subcommands:
//   seed   Starts the report file from the existing report comment when the file is
//          missing (for example, a rerun on another machine). Run before the workflow.
//   build  Builds the comment and the chat summary. With --post, creates the report
//          comment or edits it in place. Run after the workflow, with a fresh state
//          from read-state.mjs so findings argued during the run are included.
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { makeGh } from './lib/gh.mjs'
import { isMain, runCli, usageError, parseBool } from './lib/cli.mjs'
import { REPORT_HEADER, formatMarker, parseMarkers } from './lib/markers.mjs'

const USAGE = [
  'node build-report.mjs seed --state FILE --report-file PATH [--existing FILE]',
  '  prints {"seeded": bool, "lines": n}',
  'node build-report.mjs build --state FILE --report-file PATH [--result FILE] [--agents FILE] [--existing FILE]',
  '                            [--human-in-loop true|false] [--resets-at TEXT] [--post]',
  '  prints {"comment": markdown, "summary": chat text}; with --post also "commentId" and "url".',
  '  The "summary" field is the text to print in chat when the run ends.',
].join('\n')

// GitHub rejects comments over 65,536 characters.
const MAX_COMMENT = 65000

export const BLOCKER_TYPES = {
  1: 'the spec or issue contradicts itself or the code, or can\'t be done as written',
  2: 'AGENTS.md and the issue conflict',
  3: 'needs something the spec didn\'t call for',
  4: 'verification fails on the starting code',
  5: 'a review finding is still open after 3 rounds',
  6: 'the issue changes security behavior',
  7: 'verification still fails after 3 verify-repair cycles',
  8: 'the sub-issue was closed by hand with no merged PR',
}

// ---------- report file ----------

const ENTRY_RE = /^- #(\S+) (\S+?): (judgment|recommendation): (.*)$/

// Report file lines: "- #41 implementer: judgment: <text>". Lines that don't start a
// new entry are joined onto the one before, so multi-line entries survive.
export function parseReportFile(text) {
  const entries = []
  for (const line of String(text || '').split('\n')) {
    const m = ENTRY_RE.exec(line)
    if (m) entries.push({ issue: m[1], role: m[2], kind: m[3], text: m[4].trim() })
    else if (line.trim() && entries.length) entries[entries.length - 1].text += ` ${line.trim()}`
  }
  const seen = new Set()
  return entries.filter(e => {
    const key = `${e.issue}|${e.role}|${e.kind}|${e.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sectionLines(body, title) {
  const lines = String(body || '').split('\n')
  const start = lines.findIndex(l => l.trim() === `### ${title}`)
  if (start < 0) return []
  const out = []
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(l)) break
    out.push(l)
  }
  return out
}

// Turns the Judgment calls and Recommendations sections of a report comment back
// into report file lines.
export function seedLinesFromComment(body) {
  const out = []
  for (const [title, kind] of [['Judgment calls', 'judgment'], ['Recommendations', 'recommendation']]) {
    for (const l of sectionLines(body, title)) {
      const m = /^- #(\S+) (\S+?): (.*)$/.exec(l)
      if (m) out.push(`- #${m[1]} ${m[2]}: ${kind}: ${m[3]}`)
    }
  }
  return out
}

// fs: {exists, read, write, mkdir}
export function seedReportFile(path, existingBody, fs) {
  if (fs.exists(path)) return { seeded: false, lines: 0 }
  const lines = existingBody ? seedLinesFromComment(existingBody) : []
  fs.mkdir(dirname(path))
  fs.write(path, lines.length ? `${lines.join('\n')}\n` : '')
  return { seeded: true, lines: lines.length }
}

// ---------- outcomes ----------

const issueRef = n => (n === 'spec' ? 'spec' : `#${n}`)
const firstLine = (s, max = 200) => {
  const line = String(s || '').split('\n').find(l => l.trim()) || ''
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

// One outcome per issue. Prefers the workflow's result; falls back to state status
// for issues the result doesn't cover (for example, if the workflow crashed).
export function outcomes(state, result) {
  const byNum = new Map(((result && result.issues) || []).map(r => [r.number, r]))
  return (state.order || state.issues.map(i => i.number)).map(n => {
    const iss = state.issues.find(i => i.number === n) || { number: n }
    const r = byNum.get(n)
    if (r) return { ...r, title: iss.title }
    // A closed issue treated as done has no PR of its own, even if an unmerged one exists.
    const pr = iss.status === 'closed-done' ? null : iss.pr || null
    const fromStatus = {
      merged: 'merged', done: 'done', 'closed-done': 'closed-done', closed: 'waiting', blocked: 'blocked', answered: 'interrupted', interrupted: 'interrupted', todo: 'waiting',
    }[iss.status] || 'waiting'
    // Type-8 blockers (closed by hand) apply only while the issue is closed; see read-state.mjs.
    const closedIssue = iss.state === 'CLOSED'
    const blockerMarker = (iss.markers || []).filter(m => m.type === 'blocker' && ((m.data && m.data.type === 8) === closedIssue)).pop()
    const reason = iss.status === 'closed' ? 'closed by hand with no merged PR; no blocker posted yet'
      : fromStatus === 'waiting' ? 'not started' : undefined
    return {
      number: n,
      title: iss.title,
      outcome: fromStatus,
      pr: pr ? pr.number : null,
      base: pr ? pr.baseRefName : null,
      waitingOn: [],
      blocker: fromStatus === 'blocked' && blockerMarker ? blockerMarker.data : null,
      reason,
    }
  })
}

// "    Options: A) x  B) y. Recommend B." as in the example in issue #1.
function optionsLine(b) {
  const opts = (b.options || []).join('  ')
  const rec = b.recommendation ? firstLine(b.recommendation) : ''
  if (!opts && !rec) return null
  let line = opts && rec ? `${opts}. Recommend ${rec}` : opts || `Recommend ${rec}`
  if (!/[.!?]$/.test(line)) line += '.'
  return `    ${opts ? 'Options: ' : ''}${line}`
}

function stackNote(o, state, all) {
  if (!o.base || o.base === state.defaultBranch) return ''
  const specBranch = state.specBranch && state.specBranch.name
  if (o.base === specBranch) return ` (into ${specBranch})`
  const m = /^build\/\d+-(\d+)$/.exec(o.base)
  if (m) {
    const parent = all.find(x => String(x.number) === m[1])
    if (parent && parent.pr) return ` (stacked on #${parent.pr})`
  }
  return ` (into ${o.base})`
}

export function issueLines(state, result) {
  const all = outcomes(state, result)
  const lines = []
  const waiting = new Map()
  for (const o of all) {
    const pr = o.pr ? ` → PR #${o.pr}` : ''
    switch (o.outcome) {
      case 'done': lines.push(`#${o.number} done${pr}${stackNote(o, state, all)}`); break
      case 'merged': lines.push(`#${o.number} merged${pr}${stackNote(o, state, all)}`); break
      case 'closed-done': lines.push(`#${o.number} closed by hand, treated as done (no PR)`); break
      case 'blocked': {
        const b = o.blocker || {}
        lines.push(`#${o.number} BLOCKED (${b.scope || 'branch'}): ${firstLine(b.question) || 'see the blocker comment on the issue'}`)
        const opts = optionsLine(b)
        if (opts) lines.push(opts)
        break
      }
      case 'waiting':
        if (o.waitingOn && o.waitingOn.length) {
          const key = o.waitingOn.map(n => `#${n}`).join(', ')
          if (!waiting.has(key)) waiting.set(key, [])
          waiting.get(key).push(o.number)
        } else {
          lines.push(`#${o.number} not started${o.reason ? `: ${firstLine(o.reason)}` : ''}`)
        }
        break
      case 'interrupted': lines.push(`#${o.number} interrupted${pr}${o.reason ? `: ${firstLine(o.reason)}` : ''}`); break
      default: lines.push(`#${o.number} ${o.outcome}${pr}${o.reason ? `: ${firstLine(o.reason)}` : ''}`)
    }
  }
  for (const [on, nums] of waiting) lines.push(`${nums.map(n => `#${n}`).join(', ')} waiting on ${on}`)
  return lines
}

export function statusLine(state, result, resetsAt) {
  const stopped = result && result.stopped
  if (stopped === 'usage-limit') return `stopped: usage limit, resets at ${resetsAt || 'unknown'}`
  if (stopped === 'agent-limit') return 'stopped: close to the 1,000-agents-per-run cap. Rerun /build to continue.'
  if (stopped === 'graph-blocker' || (result && result.graphBlocker)) return 'stopped: a whole-graph blocker needs a decision'
  const all = outcomes(state, result)
  const blocked = all.filter(o => o.outcome === 'blocked').length
  const unfinished = all.filter(o => !['done', 'merged', 'closed-done'].includes(o.outcome)).length
  if (blocked) return `blocked: ${blocked} issue${blocked === 1 ? '' : 's'} need${blocked === 1 ? 's' : ''} a decision`
  if (unfinished) return `incomplete: ${unfinished} issue${unfinished === 1 ? '' : 's'} not finished`
  return 'done'
}

// ---------- sections ----------

function blockerBlock(where, b, waitingOn) {
  const lines = [`**${where}: blocker type ${b.type}${BLOCKER_TYPES[b.type] ? ` (${BLOCKER_TYPES[b.type]})` : ''}, ${b.scope || 'branch'} scope**`, '']
  lines.push(String(b.question || '').trim() || '(no question given)', '')
  if (b.options && b.options.length) lines.push('Options:', ...b.options.map(o => `- ${o}`), '')
  if (b.recommendation) lines.push(`Recommendation: ${b.recommendation}`, '')
  if (waitingOn.length) lines.push(`Waiting on it: ${waitingOn.map(n => `#${n}`).join(', ')}`, '')
  return lines
}

export function blockerLines(state, result) {
  const all = outcomes(state, result)
  const out = []
  const graph = result && result.graphBlocker
  if (graph) {
    out.push(...blockerBlock(`Spec #${state.spec.number} (whole graph)`, graph, []))
    out.push(`Answer with a comment starting with \`Decision:\` on spec #${state.spec.number}.`, '')
  }
  for (const o of all.filter(x => x.outcome === 'blocked' && x.blocker)) {
    const waitingOn = all.filter(x => x.outcome === 'waiting' && (x.waitingOn || []).includes(o.number)).map(x => x.number)
    out.push(...blockerBlock(`#${o.number}`, o.blocker, waitingOn))
    out.push(`Answer with a comment starting with \`Decision:\` on #${o.number}.`, '')
  }
  return out
}

function entryLines(entries, kind) {
  const list = entries.filter(e => e.kind === kind)
  const num = e => (/^\d+$/.test(e.issue) ? Number(e.issue) : -1)
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => num(a.e) - num(b.e) || a.i - b.i)
    .map(({ e }) => `- ${issueRef(e.issue)} ${e.role}: ${e.text}`)
}

export function arguedAwayLines(state) {
  const out = []
  for (const iss of state.issues || []) {
    const pr = iss.pr
    if (!pr) continue
    for (const f of pr.findings || []) {
      if (f.argued && f.status === 'withdrawn') {
        out.push(`- PR #${pr.number} (#${iss.number}), ${f.reviewer || 'reviewer'}: ${f.title}${f.argumentUrl ? ` ([argument](${f.argumentUrl}))` : ''}`)
      }
    }
  }
  return out
}

const fmtTokens = n => (n == null ? '?' : Number(n).toLocaleString('en-US'))

export function agentRow(a) {
  const issue = a.issue == null ? '?' : a.issue === 'spec' ? 'spec' : `#${a.issue}`
  const role = a.role || a.label || '?'
  const round = a.round == null ? '' : `r${a.round}${a.cycle != null ? ` c${a.cycle}` : ''}`
  return `| ${issue} | ${role} | ${round} | ${fmtTokens(a.contextTokens)} |`
}

const AGENT_HEADER = ['| Issue | Role | Round | Context tokens |', '|---|---|---|---|']

export function existingAgentRows(body) {
  return sectionLines(body, 'Agents').filter(l => l.startsWith('|') && !AGENT_HEADER.includes(l.trim()))
}

function existingAgentIds(body) {
  const m = parseMarkers(body).find(x => x.type === 'agent-ids')
  return new Set((m && Array.isArray(m.data) && m.data) || [])
}

const shortId = id => String(id || '').slice(0, 10)

// ---------- comment ----------

export function buildComment({ state, result, agents, reportEntries, existingBody, humanInLoop, resetsAt }) {
  const spec = state.spec.number
  const lastRun = state.spec.lastRun || {}
  const run = {
    humanInLoop: humanInLoop ?? lastRun.humanInLoop ?? true,
    startOid: (result && result.startOid) || lastRun.startOid || null,
    stopped: (result && result.stopped) || null,
    resetsAt: (result && result.stopped === 'usage-limit' && resetsAt) || null,
  }

  const knownIds = existingAgentIds(existingBody)
  const freshAgents = (agents || []).filter(a => !knownIds.has(shortId(a.agentId)))
  let agentRows = [...existingAgentRows(existingBody), ...freshAgents.map(agentRow)]
  const ids = [...knownIds, ...freshAgents.map(a => shortId(a.agentId)).filter(Boolean)]

  const render = (rows, dropped) => {
    const lines = [
      REPORT_HEADER,
      formatMarker('run', run),
      formatMarker('agent-ids', ids),
      `## Build report for #${spec}`,
      '',
      `Status: ${statusLine(state, result, resetsAt)}`,
      `Mode: human-in-loop=${run.humanInLoop}`,
    ]
    if (result && result.finalPr) lines.push(`Final PR: #${result.finalPr} (\`${state.specBranch.name}\` → \`${state.defaultBranch}\`), for a human to merge.`)
    lines.push('', '### Issues', '', ...issueLines(state, result).map(l => (l.startsWith('    ') ? `  ${l.trim()}` : `- ${l}`)))
    const blockers = blockerLines(state, result)
    lines.push('', '### Blockers', '', ...(blockers.length ? blockers : ['None.']))
    const judgment = entryLines(reportEntries, 'judgment')
    lines.push('', '### Judgment calls', '', ...(judgment.length ? judgment : ['None.']))
    const recs = entryLines(reportEntries, 'recommendation')
    lines.push('', '### Recommendations', '', ...(recs.length ? recs : ['None.']))
    const argued = arguedAwayLines(state)
    lines.push('', '### Findings argued away', '', ...(argued.length ? argued : ['None.']))
    const notes = (result && result.notes) || []
    if (notes.length) lines.push('', '### Run notes', '', ...notes.map(n => `- ${firstLine(n, 500)}`))
    lines.push('', '### Agents', '')
    if (dropped) lines.push(`${dropped} older rows were dropped to fit GitHub's comment size limit.`, '')
    lines.push(...AGENT_HEADER, ...rows)
    return lines.join('\n')
  }

  let dropped = 0
  let body = render(agentRows, dropped)
  while (body.length > MAX_COMMENT && agentRows.length) {
    const cut = Math.max(1, Math.ceil((body.length - MAX_COMMENT) / 30))
    agentRows = agentRows.slice(cut)
    dropped += cut
    body = render(agentRows, dropped)
  }
  if (body.length > MAX_COMMENT) body = `${body.slice(0, MAX_COMMENT - 80)}\n\n(Report cut off at GitHub's comment size limit.)`
  return body
}

export function buildSummary({ state, result, resetsAt, commentUrl }) {
  const lines = issueLines(state, result)
  if (result && result.graphBlocker) {
    const b = result.graphBlocker
    const opts = optionsLine(b)
    lines.unshift(`WHOLE GRAPH BLOCKED (type ${b.type}): ${firstLine(b.question)}`, ...(opts ? [opts] : []))
  }
  if (result && result.finalPr) lines.push(`Final PR #${result.finalPr}: ${state.specBranch.name} → ${state.defaultBranch}`)
  const status = statusLine(state, result, resetsAt)
  if (status.startsWith('stopped')) lines.push(status.charAt(0).toUpperCase() + status.slice(1))
  lines.push(`Report: comment on #${state.spec.number}${commentUrl ? ` (${commentUrl})` : ''}`)
  return lines.join('\n')
}

// ---------- posting ----------

export function postComment(gh, { repo, spec, commentId, body }) {
  const input = JSON.stringify({ body })
  if (commentId) {
    const r = gh.tryRun(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${commentId}`, '--input', '-'], { input })
    if (r.ok) {
      const res = JSON.parse(r.stdout)
      return { commentId: res.id, url: res.html_url }
    }
    if (!/404|Not Found/i.test(r.stderr)) throw new Error(`Couldn't edit report comment ${commentId}: ${r.stderr.trim()}`)
    // The comment was deleted. Fall through and create a new one.
  }
  const res = JSON.parse(gh.run(['api', `repos/${repo}/issues/${spec}/comments`, '--input', '-'], { input }))
  return { commentId: res.id, url: res.html_url }
}

function fetchExisting(gh, state) {
  const id = state.spec.reportCommentId
  if (!id) return null
  const r = gh.tryRun(['api', `repos/${state.repo}/issues/comments/${id}`])
  return r.ok ? JSON.parse(r.stdout).body : null
}

// ---------- CLI ----------

export async function main(argv, deps = {}) {
  const fs = deps.fs || {
    exists: existsSync,
    read: p => readFileSync(p, 'utf8'),
    write: (p, s) => writeFileSync(p, s),
    mkdir: p => mkdirSync(p, { recursive: true }),
  }
  const gh = deps.gh || makeGh()
  const [cmd, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      state: { type: 'string' },
      result: { type: 'string' },
      agents: { type: 'string' },
      'report-file': { type: 'string' },
      existing: { type: 'string' },
      'human-in-loop': { type: 'string' },
      'resets-at': { type: 'string' },
      post: { type: 'boolean', default: false },
    },
  })
  if (cmd !== 'seed' && cmd !== 'build') throw usageError('first argument must be seed or build')
  if (!values.state) throw usageError('--state is required')
  if (!values['report-file']) throw usageError('--report-file is required')
  const readJson = p => JSON.parse(fs.read(p))
  const state = readJson(values.state)
  const existingBody = values.existing ? fs.read(values.existing) : fetchExisting(gh, state)

  if (cmd === 'seed') return { output: seedReportFile(values['report-file'], existingBody, fs) }

  const result = values.result ? readJson(values.result) : null
  const agents = values.agents ? readJson(values.agents) : []
  const reportPath = values['report-file']
  const reportEntries = parseReportFile(fs.exists(reportPath) ? fs.read(reportPath) : '')
  const humanInLoop = parseBool(values['human-in-loop'], '--human-in-loop')
  const resetsAt = values['resets-at'] || null

  const comment = buildComment({ state, result, agents, reportEntries, existingBody, humanInLoop, resetsAt })
  if (!values.post) return { output: { comment, summary: buildSummary({ state, result, resetsAt }) } }

  const posted = postComment(gh, { repo: state.repo, spec: state.spec.number, commentId: state.spec.reportCommentId, body: comment })
  return { output: { ...posted, comment, summary: buildSummary({ state, result, resetsAt, commentUrl: posted.url }) } }
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)), USAGE)
