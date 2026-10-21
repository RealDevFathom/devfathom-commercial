# WHA-1622 bounded parser correction receipt

## Review correction — current, pending acceptance

Local-board rejected the prior source on October 7 (comment
`9043c7e7-91cd-4622-856e-398fb48d9460`). The prior **37-test evidence below is
historical and unaccepted**; it did not prove the requested retry boundary.
This authorized correction changes the same four paths listed below, preserving
base `a6f0addad0a60ac555bacb7e23c3e066bca79026`; no Git mutation.

Completion metadata now precedes output getter access. Only `stop` completions
can reach validation. Non-stop/absent completion metadata is terminal
INVALID/OUTPUT, including valid-looking truncated objects. SDK repair requires
both `stop` and an explicit `JSONParseError` or `TypeValidationError` cause; no
message/raw-text inference. Local schema failures may repair; semantic reference,
action, duplicate, hypothesis and missing inventory evidence failures terminate
INVALID/OUTPUT immediately. The two-call ceiling, shared 15-second deadline,
abort/race, SDK retries zero, sanitized input/fixed repair prompt and timer cleanup
remain intact. Exported contracts unchanged.

Current SHA256:

```text
00bb4c34abedbe7c3974d36c681f5acb5ef3b3d22f5a346626ae02ab26210ebc  src/lib/ai/growth-recommendations.ts
b613fe7034493e9d62d01d88c9592bf1295927bc7c6c70ea72da85239e6800f5  src/lib/ai/growth-recommendations.test.ts
```

Focused Vitest command below: **59 passed, 0 failed, 0 skipped**, exit 0.
Gateway-only TypeScript command below: final exit 0, no diagnostics. Initial
TypeScript check caught a test using `unknown` outside the SDK FinishReason union;
the test now explicitly injects unexpected runtime metadata. The 59 tests were
rerun after that fixture correction and passed. Scoped ESLint passed with no
diagnostics; final formatting/diff checks recorded below.

Coverage adds terminal semantic cases, response getter-not-read assertions,
valid-looking truncated/unknown responses, SDK truncation/unknown/missing
completion, unknown/missing SDK causes, completed SDK schema and getter repair.
Ordinary response mocks now carry realistic `stop` metadata. Existing timeout,
redaction and no-third-call checks retained.

Read/applied installed Ponytail Ultra instructions at
`/Users/Saad/.codex/plugins/cache/ponytail/ponytail/4.13.0/skills/ponytail/SKILL.md`
in this native CLI; no nested CLI, install, profile or security change. Caveman
Ultra and the user-confirmed memory-only exception remain in effect. Read local
Next.js `use-server.md` before editing; no Next API change.

Source and small focused checks only: no heavy checks, DB, application build,
browser, real model/provider calls, dependencies or provider configuration changes.
Central composition, configured-model acceptance and final feature gates remain
outstanding with WHA-1618 coordinator. Prior 108/18 evidence is historical only.
Local-board must review this corrected milestone. Rollback remains coordinator-owned
removal/reversion of this uncommitted four-file correction.

## Prior receipt — retained verbatim as unaccepted historical evidence

2026-10-07. Parser correction complete; feature acceptance remains blocked on
coordinator prerequisites. Checkout `/private/tmp/devfathom-pharmacy-marketing-recovery`,
branch `codex/pharmacy-completion-20261006-marketing-recovered`. Started clean at
`a6f0addad0a60ac555bacb7e23c3e066bca79026`; base preserved, edits uncommitted.
One implementation pass; checks required no correction pass. No recursive CLI or agents.

## Exact changed files

- `src/lib/ai/growth-recommendations.ts`
- `src/lib/ai/growth-recommendations.test.ts`
- `docs/pharmacy/growth/interface.md`
- `docs/pharmacy/growth/parser-correction-receipt.md` (this receipt)

Source SHA256:

```text
49d106d5ae3fb5bfafeb16de34d80998aaec068a472bc0482c88422bacacf290  src/lib/ai/growth-recommendations.ts
f7ed80e34327328a894aaa5beddd5a60e492acee4cb254ec2fac5cd824091e73  src/lib/ai/growth-recommendations.test.ts
```

## Behavior and evidence

Before: invalid output ended generation immediately; SDK abort signal alone could
leave a noncooperative promise pending. After: initial plus at most one parse/schema
repair, including SDK `NoObjectGeneratedError` and existing semantic validation.
SDK retries remain zero on both calls. One 15-second deadline starts at function
entry; both awaits race the same deadline, sharing one abort signal. Deadline
checks prevent late results or a late repair; timer cleared on completion.

Repair prompt contains prepared input, code-owned definitions/constraints and fixed
guidance only. No raw model output/error text. Exported interface, allowlists,
reference/hypothesis/inventory restrictions, sparse suppression, configuration and
provider failure behavior preserved. Exhaustion returns INVALID/OUTPUT; deadline
returns UNAVAILABLE/TIMEOUT; neither fabricates output.

Focused tests cover schema/reference/SDK repair success; invalid/SDK exhaustion;
zero configuration calls and no transport retries; model construction failure;
SDK retry settings; exact safe result shape; repair prompt redaction; initial and
repair promises ignoring cancellation; shared deadline at 15 seconds after a
10-second first attempt; late settlement ignored; timeout precedence over parsing;
timer cleanup. Existing pharmacy/restaurant validation tests retained.

## Exact checks and results

```sh
NODE_OPTIONS=--no-experimental-webstorage node node_modules/vitest/vitest.mjs run src/lib/ai/growth-recommendations.test.ts --maxWorkers=1 --no-file-parallelism
```

Exit 0: **1 file, 37 passed, 0 failed, 0 skipped**.

```sh
NODE_OPTIONS=--max-old-space-size=2048 node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --target ES2017 --module esnext --moduleResolution bundler --esModuleInterop --types node,vitest/globals src/lib/ai/growth-recommendations.ts src/lib/ai/growth-recommendations.test.ts
node node_modules/eslint/bin/eslint.js src/lib/ai/growth-recommendations.ts src/lib/ai/growth-recommendations.test.ts
node node_modules/prettier/bin/prettier.cjs --check src/lib/ai/growth-recommendations.ts src/lib/ai/growth-recommendations.test.ts
```

Each exit 0. Typecheck/lint: no diagnostics. Prettier: all matched files conform.
Source formatting used the same Prettier entry point with `--write` (exit 0).
Final documentation formatting and whitespace/scope checks:

```sh
node node_modules/prettier/bin/prettier.cjs --write docs/pharmacy/growth/interface.md docs/pharmacy/growth/parser-correction-receipt.md
node node_modules/prettier/bin/prettier.cjs --check docs/pharmacy/growth/interface.md docs/pharmacy/growth/parser-correction-receipt.md
git diff --check
git status --short
git rev-parse HEAD
```

Results: exit 0; documentation formatted; no whitespace errors; only the four
listed paths changed; HEAD remains the starting base.

## Limits and handoff

- Read repository AGENTS and installed Next Server and Client Components guide
  before coding; retained `server-only`. Applied installed bounded-operation,
  tool-budget, evidence, local-source and Caveman Ultra instructions. Ponytail
  instructions not found in available catalogs/searched skill roots; activation
  not asserted. No persistent setup. Used source/handoff under the explicit
  Claude-Mem/Codebase Memory exception; no tool/authentication repair.
- Test doubles only. No private environment/authentication reads, runtime provider
  check, live model calls, dependencies, database, UI, provider configuration,
  routing, credentials, security/access, policies, loyalty fixtures or AGENTS changes.
- A noncooperative provider may continue its own work after cancellation; the
  caller returns TIMEOUT and ignores late settlement. JavaScript timers cannot
  preempt synchronous event-loop blocking; elapsed-time guards reject late results.
- Existing **108 tests / 18 DB tests** in `reconnect-handoff.md` remain prior
  evidence, not rerun or claimed as validation of this correction. No full suite,
  database tests, application build/full typecheck or browser QA run.
- Central composition and real-model evidence remain unaccepted coordinator
  prerequisites. No final feature acceptance, Paperclip writes, commit, reset,
  remote operation or deployment. Caller owns disposition and Git; rollback is
  coordinator-owned removal of this uncommitted four-file correction.
