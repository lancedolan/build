// Reads workflow transcript directories and prints one row per agent:
// label, issue, role, round, cycle, model, and context tokens from its last request.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isMain, runCli, usageError } from './lib/cli.mjs'

const USAGE = 'node parse-transcripts.mjs <transcriptDir> [<transcriptDir> ...]'

// "#41 implementer r1", "#41 verifier r0 c2", "#spec recheck", "#41 review:build:fallback-reviewer r2"
const LABEL_RE = /^#(\S+)\s+(\S+)(?:\s+r(\d+))?(?:\s+c(\d+))?\s*$/

export function splitLabel(label) {
  const m = LABEL_RE.exec(String(label || ''))
  if (!m) return { issue: null, role: null, round: null, cycle: null }
  return {
    issue: m[1],
    role: m[2],
    round: m[3] === undefined ? null : Number(m[3]),
    cycle: m[4] === undefined ? null : Number(m[4]),
  }
}

function parseJsonl(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A partly written last line, if the run was cut off. Skip it.
    }
  }
  return out
}

export function labelsFromJournal(text) {
  const labels = new Map()
  for (const e of parseJsonl(text)) {
    if (e.type === 'started' && e.agentId && e.label && !labels.has(e.agentId)) labels.set(e.agentId, e.label)
  }
  return labels
}

const tokensOf = u =>
  (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

// Each response can appear several times with the same message.id. Keep the last
// entry per id, then take the last response in the file.
export function lastUsage(transcriptText) {
  const byId = new Map()
  for (const e of parseJsonl(transcriptText)) {
    if (e.type !== 'assistant' || !e.message || !e.message.usage) continue
    const id = e.message.id || `noid-${byId.size}`
    if (byId.has(id)) byId.delete(id)
    byId.set(id, e.message)
  }
  const msgs = [...byId.values()]
  const last = msgs[msgs.length - 1]
  if (!last) return { model: null, contextTokens: null }
  return { model: last.model || null, contextTokens: tokensOf(last.usage) }
}

// fs: {exists(path), list(dir), read(path)}
export function parseTranscriptDir(dir, fs) {
  const files = fs.list(dir)
  const journalPath = join(dir, 'journal.jsonl')
  const labels = fs.exists(journalPath) ? labelsFromJournal(fs.read(journalPath)) : new Map()
  const rows = []
  for (const f of files.filter(f => /^agent-.+\.jsonl$/.test(f)).sort()) {
    const agentId = f.slice('agent-'.length, -'.jsonl'.length)
    let label = labels.get(agentId) || null
    if (!label) {
      const metaPath = join(dir, `agent-${agentId}.meta.json`)
      if (fs.exists(metaPath)) {
        try {
          label = JSON.parse(fs.read(metaPath)).description || null
        } catch {
          label = null
        }
      }
    }
    const { model, contextTokens } = lastUsage(fs.read(join(dir, f)))
    rows.push({ agentId, label, ...splitLabel(label), model, contextTokens })
  }
  return rows
}

export function main(argv, fs = { exists: existsSync, list: readdirSync, read: p => readFileSync(p, 'utf8') }) {
  if (!argv.length) throw usageError('give at least one transcriptDir')
  const rows = []
  for (const dir of argv) {
    if (!fs.exists(dir)) throw new Error(`transcript dir not found: ${dir}`)
    rows.push(...parseTranscriptDir(dir, fs))
  }
  return { output: rows }
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)), USAGE)
