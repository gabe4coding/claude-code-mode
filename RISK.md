---
R0: ["runtime/**", "tests/runner.integration.mjs", "hooks/**", "hints/**", "AGENTS.md", "CLAUDE.md", "CODING_STANDARDS.md", ".claude/**", "RISK.md", ".github/risk.yml", ".github/scripts/**", ".github/workflows/**", ".githooks/**", ".claude-plugin/**", "LICENSE"]
R2: ["docs/configuration.mdx", "docs/development.mdx", "docs/functions.mdx", "docs/hints.mdx", "docs/how-it-works.mdx", "docs/installation.mdx", "docs/troubleshooting.mdx", "docs/usage.mdx", "docs/assets/**", "README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", ".github/ISSUE_TEMPLATE/**", "bench/**", "scripts/projection-report.mjs"]
---

## Critical

- `runtime/**`, `tests/runner.integration.mjs`: the sandbox. `runtime/runner.mjs` runs the model's program, and its
  `--permission` flag, network block and `MARK` protocol are the safety layers. The integration test is the only
  test that proves them.
- `hooks/register.tsx`, `hooks/paths.ts`, `hooks/functions.ts`: the permission and approval path. The approval of
  nested MCP calls (`program` or `per-call`), `failClosed`, the hint-file guard (`guardedDirs`), the approval ledger in
  `$.store`, and the saved functions that run code.
- The rest of `hooks/**` and `hints/**`: the text that steers the model. `hooks/hints.ts` holds `approvalKey` and the
  hint loader, `hooks/protocol.ts` the runner protocol, `hooks/hooks.json` and `hooks/session-start.sh` what loads and
  what the model reads at start. The bundled hints steer the model in every user's session.
- `AGENTS.md`, `CLAUDE.md`, `CODING_STANDARDS.md`, `.claude/**`: the rules for the agents that write PRs here, for
  example "never weaken a sandbox layer".
- `RISK.md`, `.github/risk.yml`, `.github/scripts/**`: a PR must not loosen its own review.
- `.github/workflows/**`, `.githooks/**`: a PR must not skip a check. The `risk` workflow runs on
  `pull_request_target` with write tokens.
- `.claude-plugin/**`, `LICENSE`: what users install. `plugin.json` holds the version and the public defaults
  (`approval`, `projectHints`, `blockDirectMcp`), `marketplace.json` the source.

## Decisions

- A new dependency: an npm package or an import outside the Node built-ins. The README promises "No dependencies",
  and `runtime/runner.mjs` must use Node built-ins only.
- Real data in the repo: real MCP data, company names, ticket keys, user ids or tokens in tests, hints or docs. The
  repo is public.

## Safe

- User docs: `docs/*.mdx` and `docs/assets/`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates.
  Not `docs/permissions.mdx`: it tells users which allow rules to add, so a too-wide rule widens their permissions.
  Not `SECURITY.md`: it is the path to report a vulnerability. A new `docs/` page is not R2 until it is added here.
  Risk that can hide: the README install lines name the marketplace, so a changed name sends users to another plugin.
- Dev tools: `bench/**`, `scripts/projection-report.mjs`. They do not ship to users. Risk that can hide:
  `bench/fake-server.mjs` is the fake server that `/verify` and `tests/smoke.e2e.mjs` drive, so a change can make the
  end-to-end check pass falsely. `bench/run.mjs` makes the README cost claim.

## Weak checks

- `hooks/register.tsx` and `tests/*.test.ts`: CI has no type check of them. `tsconfig.json` needs
  `.claude-plugin/types/`, which Claude Code writes only in a logged-in session. CI checks only the pure helpers
  (`tsconfig.pure.json`). Fix: a CI job with a Claude Code token secret that starts Claude Code once with
  `--plugin-dir .` to write the types, then runs `npx -p typescript tsc -p tsconfig.json`.
- The real permission path: `claude plugin test .` runs the hooks against a fake host with no processes, and
  `$.mcp.call` and the permission checks are fakes (`tests/fakes.ts`). Only `tests/smoke.e2e.mjs` drives real
  `claude -p`, and CI never runs it. A change to `approval`, `blockDirectMcp` or the hint-file guard can pass CI and
  fail in real Claude Code. Fix: a CI job with an API key secret that runs `node tests/smoke.e2e.mjs` on PRs that
  change `hooks/` or `runtime/`, and in the weekly schedule.
- Two rule sets for review risk: `.github/risk.yml` (T0, T1, T2; advisory, never fails a PR) and this file (R0, R2).
  They can drift: `risk.yml` has `hooks/**`, `hints/**` and `AGENTS.md` only as T1, and here they are R0. Fix: a test
  in `.github/scripts/test_risk_tier.py` that fails when an R0 glob of this file is not in `hard` or `soft` of
  `risk.yml`, or make `risk_tier.py` read the front matter of this file.
