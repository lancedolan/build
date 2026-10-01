# build

A Claude Code plugin. `/build <spec#>` takes a GitHub spec issue and its sub-issues, and turns each sub-issue into one PR. No human is needed until the run ends.

For each sub-issue, in dependency order:
1. A scout writes a facts-only brief.
2. A test-writer commits failing tests.
3. An implementer writes the code.
4. A verifier runs the build, the linter, and every test suite. Failures go back to a fresh implementer, up to 3 times.
5. The PR opens, and reviewer agents review it. The findings and replies are posted as PR comments. There are up to 3 rounds.

The run stops on an issue only for a listed blocker, such as a new dependency, a security change, or a contradiction in the spec. The other issues keep going. At the end, one comment on the spec issue lists every judgment call, recommendation, finding that was argued away, blocker, and agent, with each agent's context token count.

The full spec is [issue #1](https://github.com/lancedolan/build/issues/1). The data shapes shared between the parts are in [docs/contracts.md](docs/contracts.md).

## Install

```sh
claude plugin marketplace add lancedolan/build
claude plugin install build@lancedolan-build
```

## Setup before first use

- Turn on dynamic workflows. In Claude Code, run `/config` and turn on "Dynamic workflows". Make sure `disableWorkflows` isn't `true` in any settings file and `CLAUDE_CODE_DISABLE_WORKFLOWS` isn't set.
- Turn on `autoContinueAtUsageLimit` in your Claude Code settings. Then a run waits for a usage limit to reset instead of stopping.
- Log in to `gh` with an account that can write to the target repo.
- For `human-in-loop=true` (the default): turn on "Automatically delete head branches" in the repo's GitHub settings. Without it, a stacked PR keeps targeting its merged parent's branch, and merging it never reaches the main branch.
- For `human-in-loop=false`: the repo's AGENTS.md must let agents merge PRs into a spec branch. They never merge into the main branch.

## Usage

Run these from a checkout of the target repo:

```
/build 40          # one PR per sub-issue; stacked PRs; you merge everything
/build 40 false    # agents merge each PR into build/40-spec; you merge one final PR
```

When the run ends, the chat shows each issue's result and each blocker with its options. To answer a blocker, reply in chat, for example `#43: B`. Claude posts it as a `Decision:` comment and reruns `/build`. You can also post the `Decision:` comment yourself from anywhere and rerun later. All state lives on GitHub.

Rerun `/build 40` after merging some PRs. Merge stacked PRs with **merge commits** (not squash or rebase), bottom of the stack first. A squash or rebase merge leaves the PRs stacked on it with commits the default branch doesn't have; /build refuses to run until you fix that by hand.

## Development

```sh
npm test                          # unit tests, no network
claude plugin validate .          # check the manifests
claude --plugin-dir . ...         # load the plugin from this checkout
```
