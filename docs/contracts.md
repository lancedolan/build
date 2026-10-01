# Contracts between the parts of the `build` plugin

The spec is GitHub issue lancedolan/build#1. This file fixes the names and data shapes that the parts share. Each part must match it exactly.

## Layout

The repo root is both the marketplace and the plugin.

```
.claude-plugin/marketplace.json   marketplace "lancedolan-build", one plugin "build", source "./"
.claude-plugin/plugin.json        plugin "build"
skills/build/SKILL.md             entry skill, runs as /build:build (and /build)
workflows/build-graph.js          workflow, meta.name "build-graph", runs as build:build-graph
agents/fallback-reviewer.md       agentType "build:fallback-reviewer"
scripts/lib/*.mjs                 shared code (gh wrapper, markers, graph)
scripts/startup-checks.mjs
scripts/read-state.mjs
scripts/check-parents.mjs         run by a workflow agent before each issue (human-in-loop=true)
scripts/parse-transcripts.mjs
scripts/build-report.mjs
test/*.test.mjs, test/fixtures/   run with `npm test`
package.json                      "type": "module", "test": "node --test test/*.test.mjs", no dependencies
```

Scripts are Node 20+ ESM with no npm dependencies. They call `gh` through `scripts/lib/gh.mjs`, which takes an injectable runner so tests can feed recorded JSON. Each script prints JSON to stdout and exits 0, or prints `{"error": "..."}` and exits non-zero. The skill calls them as `node ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs ...`.

## Names

- Issue branch: `build/<spec>-<issue>`, e.g. `build/40-41`.
- Spec branch (`human-in-loop=false` only): `build/<spec>-spec`.
- Run worktree: `../<repo>.build-<spec>` next to the main checkout.
- Report file: `~/.claude/build/<owner>-<repo>-<spec>/report.md`.
- Agent labels, which the transcript parser splits into issue, role, round:
  - `#<issue> <role>` or `#<issue> <role> r<round>`. Roles: `scout`, `test-writer`, `implementer`, `verifier`, `review:<agentType>`, `merger`, `rebaser`, `git` (mechanical push, PR, and comment steps; Haiku), `decision-reader` (reads the `Decision:` answer to a type-8 blocker; Sonnet).
  - Run-level agents use `#spec <role>`: `#spec start-verifier`, `#spec recheck`, `#spec git`.
  - Round is the review round (0 = before review). The verify-repair cycle is `c<n>` after the round: `#41 verifier r0 c2`.

## Hidden markers

Agents write machine state into GitHub comments as one line: `<!-- build:<type> <json> -->`. The JSON is on one line. A comment may hold several markers. The state reader parses every marker on the spec issue, its sub-issues, and their PRs.

| Type | Where | JSON |
|---|---|---|
| `finding` | PR comment by a reviewer | `{"id":"<reviewer>-r<round>-<n>","reviewer":"<agentType>","round":n,"severity":"high\|medium\|low","title":"..."}` |
| `reply` | PR comment by implementer | `{"finding":"<id>","action":"fixed\|argued","commit":"<sha or null>"}` |
| `verdict` | PR comment by the reviewer that raised the finding | `{"finding":"<id>","verdict":"withdrawn\|stands"}` |
| `blocker` | sub-issue comment (graph scope: spec issue comment) | `{"issue":n,"type":1-8,"scope":"branch\|graph","question":"...","options":["A) ...","B) ..."],"recommendation":"..."}` |
| `progress` | sub-issue comment | `{"issue":n,"step":"tests-committed\|code-pushed\|pr-opened\|review-round\|merged","round":n,"commit":"<sha>","pr":n\|null}` |
| `interrupted` | sub-issue comment | `{"issue":n,"lastStep":"<step or null>"}` |
| `done` | sub-issue comment | `{"issue":n,"pr":n}`, or `{"issue":n,"pr":null}` when a Decision said to treat a closed issue as done |
| `agent-ids` | inside the report comment | `["<first 10 chars of agentId>", ...]`, so a rebuilt report doesn't list the same agent twice |
| `run` | inside the report comment | `{"humanInLoop":bool,"startOid":"<sha of starting branch when last verified>","stopped":null\|"usage-limit"\|"graph-blocker","resetsAt":null\|"..."}` |

- A finding is open until a later `verdict` with `withdrawn`, or a `reply` with `action: fixed` that no later `verdict: stands` overrides.
- Blocker types 1-7 are the spec's list. Type 8 is "the sub-issue was closed by hand with no merged PR". Only the workflow script raises type 8, always with `branch` scope. Agents return types 1-7.
- A blocker is answered when a `Decision:` comment on the same issue is newer than the blocker marker.
- A type-8 blocker counts only while the issue is closed. Other blocker types count only while it is open.
- The report comment is the spec-issue comment whose first line is `<!-- build:report -->`.
- `Decision:` comments are comments whose body starts with `Decision:` (after trimming). They are copied word for word, never parsed.

## State JSON (read-state.mjs output, passed to the workflow as `args.state`)

```json
{
  "repo": "owner/name",
  "defaultBranch": "main",
  "defaultBranchOid": "sha",
  "deleteBranchOnMerge": true,
  "viewerPermission": "ADMIN",
  "spec": {
    "number": 40, "title": "...", "body": "...", "url": "...",
    "decisions": [{"body": "Decision: ...", "createdAt": "...", "author": "login"}],
    "markers": [{"type": "blocker", "data": {}, "createdAt": "...", "commentId": 123}],
    "reportCommentId": 123,
    "lastRun": {"humanInLoop": true, "startOid": "sha", "stopped": null, "resetsAt": null}
  },
  "specBranch": {"name": "build/40-spec", "exists": false, "oid": null},
  "issues": [
    {
      "number": 41, "title": "...", "body": "...", "state": "OPEN",
      "blockedBy": [40],
      "decisions": [],
      "markers": [],
      "branch": {"name": "build/40-41", "exists": true, "oid": "sha"},
      "pr": {"number": 46, "url": "...", "state": "OPEN", "merged": false, "baseRefName": "main", "headRefName": "build/40-41", "headRefOid": "sha", "findings": [{"id": "...", "open": true, "reviewer": "...", "title": "..."}]},
      "status": "todo"
    }
  ],
  "order": [41, 42, 43],
  "graphErrors": [],
  "badMerges": [{"issue": 41, "pr": 46, "dependent": 42, "branch": "build/40-42"}]
}
```

Fields beyond the example: each issue also has `url` and `allPrs` (every PR from its branch: `number`, `state`, `merged`, `baseRefName`), and `specBranch.prs` lists PRs from the spec branch. Startup checks use these for the mode check. Each `pr.findings` entry also has `severity`, `round`, `detail` (comment text without markers), `url`, `status` (`open|argued|fixed|withdrawn`), `argued`, `argumentUrl`, and `fixedIn`. `pr.mergedWithMergeCommit` is `true` when the merge commit has the PR head as a parent, `false` for a squash or rebase merge, and `null` when not merged.

`badMerges` lists merged PRs that were not merged with a merge commit while a dependent issue's unmerged branch still contains the PR's head commit (checked with the compare API). Startup checks refuse these in `human-in-loop=true` mode. /build never rebases a branch because its parent merged: in that mode stacked PRs must be merged with merge commits. Before each issue, a `git` agent runs `check-parents.mjs --repo R --branch build/<spec>-<issue> --parents <issue>:<pr>,...` for the issue's open parent PRs. It prints `{"merged": [issues], "badMerges": [issues]}`, where `badMerges` are parents merged without a merge commit whose head is still on the issue's branch. A bad merge, or a failed check, posts a type-1 blocker on the issue.

`status` is computed in code, in this priority order:
1. `merged`: the PR is merged.
2. The issue is closed and has no merged PR (closed by hand). Only type-8 blocker markers count here:
   - `closed`: no type-8 blocker yet. The workflow posts one (once) and gives the issue outcome `blocked`.
   - `blocked`: the type-8 blocker has no newer `Decision:`.
   - `closed-done`: a `done` marker is newer than the type-8 blocker (a Decision said to treat it as done). Outcome `closed-done`; its dependents start as if it were merged.
   - `answered`: the type-8 blocker has a newer `Decision:` and no newer `done` marker. A `decision-reader` agent reads the decision: `treat-as-done` posts the `done` marker (pr null), `build` reopens the issue (`gh issue reopen`) and works it normally, `unclear` posts a new type-8 blocker.
3. `done`: there is a `done` marker and the PR is open.
4. `blocked`: there is a `blocker` marker (not type 8) with no newer `Decision:`.
5. `answered`: there is a `blocker` marker (not type 8) and a newer `Decision:`. The workflow treats it like `interrupted` and passes the decisions to the agents.
6. `interrupted`: there is a `progress` or `interrupted` marker but no `done`.
7. `todo`: none of the above.

`blockedBy` only lists issues inside this spec. A "blocked by" link to an issue outside the spec goes to `graphErrors`, and so does a cycle. `order` is a topological order, with ties broken by issue number.

## Workflow args

```json
{
  "state": {},
  "worktree": "/abs/path/to/repo.build-40",
  "mainCheckout": "/abs/path/to/repo",
  "pluginRoot": "/abs/path/to/plugin",
  "ports": {"base": 3110, "list": [3110, 3111, 3112]},
  "humanInLoop": true,
  "reportFile": "/Users/x/.claude/build/owner-repo-40/report.md",
  "reviewers": ["security-reviewer", "build:fallback-reviewer"],
  "isRerun": true,
  "needsStartVerify": true,
  "mainCheckoutBaseline": "<output of git status --porcelain in the main checkout at start; empty if clean>"
}
```

## Workflow return value

```json
{
  "issues": [
    {"number": 41, "outcome": "done|merged|blocked|waiting|interrupted|closed-done", "pr": 46, "base": "main", "waitingOn": [43], "blocker": null, "reason": "optional text"}
  ],
  "graphBlocker": null,
  "stopped": null,
  "startOid": "sha",
  "finalPr": null,
  "agentCount": 20,
  "notes": ["..."]
}
```

`blocker` uses the same shape as the `blocker` marker JSON. `stopped` is `null`, `"usage-limit"` (an agent returned no result), `"agent-limit"` (900 agents started), or `"graph-blocker"`. `finalPr` is the spec-branch PR number in `false` mode once every issue is merged. An issue that never started has outcome `waiting` with empty `waitingOn` and a `reason`. `closed-done` means closed by hand and treated as done per a Decision; it has `pr: null`. Dependents of a `closed-done` issue start from the main branch (or the spec branch in `false` mode), and the final PR body lists it as "closed by hand, treated as done (no PR)".

## Agent output schemas (shared fields)

Every working agent (scout, test-writer, implementer, reviewer) returns these fields in addition to its role's fields:
- `judgmentCalls: string[]`
- `recommendations: string[]`
- `blocker: null | {type, scope, question, options, recommendation}`

Agents also append each judgment call and recommendation to the report file as one line: `- #<issue> <role>: judgment: <text>` or `- #<issue> <role>: recommendation: <text>`. The report builder groups these lines by issue.

## Transcript parser output

Input: one or more workflow `transcriptDir` paths. For each `agent-<id>.jsonl`, it finds the label from `journal.jsonl` (`started` entries) or from `agent-<id>.meta.json` `description`. Context tokens = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the last assistant entry, after keeping only the last entry per `message.id`.

```json
[{"agentId": "a65a...", "label": "#41 implementer r1", "issue": "41", "role": "implementer", "round": 1, "cycle": null, "model": "claude-opus-5-5", "contextTokens": 21583}]
```

## Report comment

```
<!-- build:report -->
<!-- build:run {...} -->
## Build report for #40
Status line (done / blocked / stopped: usage limit, resets at X)
### Issues          (one line each: #41 done → PR #46, #43 BLOCKED (branch) ...)
### Blockers        (type, question, options, recommendation, waiting issues)
### Judgment calls  (grouped by issue, from the report file)
### Recommendations (grouped by issue, from the report file)
### Findings argued away (PR, reviewer, title, the argument's comment link)
### Agents          (table: issue | role | round | context tokens; rows from all runs, appended)
```

On rerun, the builder keeps earlier Agents rows by reading them from the existing comment.
