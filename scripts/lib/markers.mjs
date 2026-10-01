// Hidden markers in GitHub comments: <!-- build:<type> <json> -->
// See docs/contracts.md, "Hidden markers".

export const REPORT_HEADER = '<!-- build:report -->'

const MARKER_RE = /<!-- build:([a-z][a-z-]*)(?: (.*?))? -->/g

// Returns [{type, data}] for every marker in the text. A marker with JSON that
// doesn't parse is skipped. `build:report` has no JSON and returns data null.
export function parseMarkers(text) {
  const out = []
  for (const m of String(text || '').matchAll(MARKER_RE)) {
    const [, type, raw] = m
    if (raw === undefined) {
      out.push({ type, data: null })
      continue
    }
    try {
      out.push({ type, data: JSON.parse(raw) })
    } catch {
      // Not a marker we wrote, or a broken one. Ignore it.
    }
  }
  return out
}

// `>` is escaped so the JSON can never contain the closing `-->`.
export function formatMarker(type, data) {
  return `<!-- build:${type} ${JSON.stringify(data).replace(/>/g, '\\u003e')} -->`
}

export function stripMarkers(text) {
  return String(text || '').replace(MARKER_RE, '').trim()
}

export function isDecision(body) {
  return String(body || '').trim().startsWith('Decision:')
}

export function isReportComment(body) {
  return String(body || '').trimStart().startsWith(REPORT_HEADER)
}

// ISO timestamps compare correctly as strings.
export const isAfter = (a, b) => String(a || '') > String(b || '')

export function lastMarker(markers, type, filter) {
  let best = null
  for (const m of markers || []) {
    if (m.type !== type || (filter && !filter(m))) continue
    if (!best || !isAfter(best.createdAt, m.createdAt)) best = m
  }
  return best
}

// Flattens comments into marker records: {type, data, createdAt, commentId, url}.
export function markersFromComments(comments) {
  const out = []
  for (const c of comments || []) {
    for (const m of parseMarkers(c.body)) {
      if (m.type === 'report') continue
      out.push({ type: m.type, data: m.data, createdAt: c.createdAt, commentId: c.databaseId ?? null, url: c.url ?? null })
    }
  }
  return out
}

export function decisionsFromComments(comments) {
  return (comments || [])
    .filter(c => isDecision(c.body))
    .map(c => ({ body: c.body, createdAt: c.createdAt, author: c.author ? c.author.login : null }))
}

// Builds the finding list for one PR from its comments, per the contracts rules:
// a finding is open until a later `withdrawn` verdict, or a `fixed` reply that no
// later `stands` verdict overrides.
export function computeFindings(comments) {
  const sorted = [...(comments || [])].sort((a, b) => (isAfter(a.createdAt, b.createdAt) ? 1 : isAfter(b.createdAt, a.createdAt) ? -1 : 0))
  const findings = new Map()
  for (const c of sorted) {
    for (const m of parseMarkers(c.body)) {
      if (!m.data) continue
      if (m.type === 'finding' && m.data.id && !findings.has(m.data.id)) {
        findings.set(m.data.id, {
          id: m.data.id,
          reviewer: m.data.reviewer ?? null,
          round: m.data.round ?? null,
          severity: m.data.severity ?? null,
          title: m.data.title ?? '',
          detail: stripMarkers(c.body).slice(0, 4000),
          url: c.url ?? null,
          createdAt: c.createdAt,
          status: 'open',
          open: true,
          argued: false,
          argumentUrl: null,
          argumentText: null,
          fixedIn: null,
        })
      }
    }
  }
  for (const c of sorted) {
    for (const m of parseMarkers(c.body)) {
      if (!m.data || !m.data.finding) continue
      const f = findings.get(m.data.finding)
      if (!f) continue
      if (m.type === 'reply') {
        if (m.data.action === 'fixed') {
          f.status = 'fixed'
          f.fixedIn = m.data.commit ?? null
        } else if (m.data.action === 'argued') {
          f.status = 'argued'
          f.argued = true
          f.argumentUrl = c.url ?? null
          f.argumentText = stripMarkers(c.body).slice(0, 2000)
        }
      } else if (m.type === 'verdict') {
        if (m.data.verdict === 'withdrawn') f.status = 'withdrawn'
        else if (m.data.verdict === 'stands') f.status = 'open'
      }
    }
  }
  for (const f of findings.values()) f.open = f.status === 'open' || f.status === 'argued'
  return [...findings.values()]
}
