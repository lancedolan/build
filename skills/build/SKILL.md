---
name: build
description: Work a spec issue's graph of sub-issues into one PR per sub-issue, with tests first, full verification, and adversarial review. Stops only on listed blockers.
argument-hint: <spec#> [human-in-loop=true|false]
arguments: [spec, human-in-loop]
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*) Bash(gh *) Bash(git *) Bash(lsof *) Bash(mkdir *) Workflow(build:build-graph)
---

Run `/build` for spec issue `$spec` with human-in-loop `$human-in-loop`. If the human-in-loop argument is empty or still reads `$human-in-loop`, use `true`. Accept only `true` or `false`; anything else: stop and print the usage line `/build <spec#> [true|false]`.

Scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts/`. Each prints JSON. On a non-zero exit, print its `error` or `refusals` word for word and stop.

Work in the current repo checkout (the "main checkout"). Use absolute paths everywhere.

## 1. Refuse if workflows are off

If you don't have the Workflow tool, stop and print in capitals: `REFUSED: dynamic workflows are off in this session. Turn on "Dynamic workflows" in /config (and remove disableWorkflows / CLAUDE_CODE_DISABLE_WORKFLOWS), then rerun.`

## 2. Read state and run startup checks

1. `MAIN=$(git rev-parse --show-toplevel)`. `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)`. `DIR=~/.claude/build/<owner>-<repo>-<spec>` (owner and repo from `REPO`). `mkdir -p "$DIR"`.
2. `node ${CLAUDE_PLUGIN_ROOT}/scripts/read-state.mjs --spec <spec> --repo-dir "$MAIN" > "$DIR/state.json"`
   - Its output goes to the file, so check the exit code. Non-zero: print the `error` field of `$DIR/state.json` word for word and stop.
3. `node ${CLAUDE_PLUGIN_ROOT}/scripts/startup-checks.mjs --spec <spec> --human-in-loop <mode> --repo-dir "$MAIN" --state "$DIR/state.json"`
   - Print every warning.
   - If `refusals` is non-empty, print each one loudly (prefix `REFUSED:`) and stop. Do not start any agent.

## 3. Pick reviewers

List `$MAIN/.claude/agents/*-reviewer.md`. For each, read the frontmatter `name`. Those names are the reviewers. If there are none, reviewers = `["build:fallback-reviewer"]`.

## 4. Seed the report file

`node ${CLAUDE_PLUGIN_ROOT}/scripts/build-report.mjs seed --state "$DIR/state.json" --report-file "$DIR/report.md"`

It does nothing when the file already exists.

## 5. Prepare the worktree

1. `WT=<parent of MAIN>/<basename of MAIN>.build-<spec>`.
2. If `$WT` is not already a worktree of this repo (`git -C "$MAIN" worktree list`), run `git -C "$MAIN" fetch origin` then `git -C "$MAIN" worktree add --detach "$WT" origin/<defaultBranch>`. If it exists, reuse it. The workflow agents check out the branches they need.
3. Install dependencies once in `$WT`:
   - If an AGENTS.md in the repo says how to install, do that.
   - Otherwise pick from the lockfile: `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`; `yarn.lock` → `yarn install --frozen-lockfile`; `bun.lockb`/`bun.lock` → `bun install`; `package-lock.json` → `npm ci`; `uv.lock` → `uv sync`; `poetry.lock` → `poetry install`; `Gemfile.lock` → `bundle install`; `go.sum` → `go mod download`; `Cargo.lock` → `cargo fetch`. None → skip.
   - Skip the install if the worktree already has the installed directory (for example `node_modules`) and the lockfile hasn't changed since.
4. Ports: try bases 3110, 3210, 3310, and so on up to 3910. Pick the first base where `lsof -nP -iTCP:<base>-<base+9> -sTCP:LISTEN` prints nothing. `ports = {"base": B, "list": [B, B+1, ..., B+9]}`. None free: stop with `REFUSED: no free port block between 3110 and 3919.`
5. `mainCheckoutBaseline` = output of `git -C "$MAIN" status --porcelain` (empty string if clean).
6. Starting branch: in `false` mode, the spec branch when `state.specBranch.exists`, otherwise the default branch. In `true` mode, the default branch. Its oid is `state.specBranch.oid` or `state.defaultBranchOid`.
7. `needsStartVerify` = `state.spec.lastRun` is missing, or its `startOid` differs from the starting branch oid.
8. `isRerun` = `state.spec.lastRun` exists, or any issue's status is not `todo`.

## 6. Start the workflow

1. Count issues whose status is not `merged` or `closed-done`. Print `working N issues, one at a time`.
2. Call the Workflow tool with `name: "build:build-graph"` and `args` as a JSON object (not a string):
   ```json
   {
     "state": <contents of $DIR/state.json>,
     "worktree": "$WT",
     "mainCheckout": "$MAIN",
     "pluginRoot": "${CLAUDE_PLUGIN_ROOT}",
     "ports": {"base": B, "list": [...]},
     "humanInLoop": <mode>,
     "reportFile": "$DIR/report.md",
     "reviewers": [...],
     "isRerun": <bool>,
     "needsStartVerify": <bool>,
     "mainCheckoutBaseline": "<baseline>"
   }
   ```
3. It runs in the background. Print `running in the background; watch with /workflows`. End your turn. Continue at step 7 when the completion notification arrives. Never guess its result.

## 7. After the workflow returns

1. Write the workflow's return value to `$DIR/result.json`. Note its `transcriptDir`.
2. `node ${CLAUDE_PLUGIN_ROOT}/scripts/parse-transcripts.mjs <transcriptDir> > "$DIR/agents.json"`
3. Read state again, so findings argued during the run are included: `node ${CLAUDE_PLUGIN_ROOT}/scripts/read-state.mjs --spec <spec> --repo-dir "$MAIN" > "$DIR/state.json"`
4. If `result.stopped` is `usage-limit` and you know when the limit resets (from a usage-limit message in this session), keep that time as `RESETS`.
5. Fetch the existing report comment body if `state.spec.reportCommentId` is set: `gh api repos/<REPO>/issues/comments/<id> -q .body > "$DIR/existing.md"`.
6. `node ${CLAUDE_PLUGIN_ROOT}/scripts/build-report.mjs build --state "$DIR/state.json" --report-file "$DIR/report.md" --result "$DIR/result.json" --agents "$DIR/agents.json" --human-in-loop <mode> [--existing "$DIR/existing.md"] [--resets-at "$RESETS"] --post`
7. Print the output's `summary` field word for word, in a code block, then the report comment `url`.
8. If `result.stopped` is `usage-limit`: say the run stopped on a usage limit, when it resets (or that the time is unknown), and that rerunning `/build <spec> <mode>` resumes each interrupted issue from its last finished step.
9. If `result.stopped` is `agent-limit`: say loudly that the run hit the 900-agent safety stop, and that a rerun continues.

## 8. When the user answers a blocker

The user answers in chat, for example `#43: B` or a longer answer.

1. Find the blocker it answers in the last summary. Graph-scope blocker → the spec issue. Branch-scope → the blocked issue. This includes type 8 (the issue was closed by hand): post on that closed issue, and don't reopen it yourself. The workflow reads the answer and reopens it if needed.
2. Post the answer word for word after the prefix: `gh issue comment <n> -R <REPO> --body "Decision: <answer>"`. If one message answers several blockers, post one comment per issue.
3. Rerun this skill from step 1 with the same spec and the same mode.
