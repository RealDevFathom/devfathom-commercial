# PR64 follow-up verification

The fetched `origin/develop` was already contained in `e17728acf7730bae68955de6bd90917195bcb767` (99 branch commits, zero incoming develop commits). No rebase or force push was used.

The new counter lookup accepts a 2–100 character query, caps results at ten, applies live tenant/branch/counter authorization and returns initials, masked phone suffix and loyalty consent only. Linking reads canonical identity on the server and reuses the consent-locked sale-linking service. The clinical prescription endpoints retain their dispensing authorization. The counter reuses Studio `SectionCard`, `Label`, `Input`, `Button` and semantic tokens.

The follow-up migration rejects NULL and blank ADJUSTMENT reasons. Finance and stock fixtures use real active manager identities; remote write-off checkers reauthenticate with a real PIN. Product approval rules and audit guards were not weakened. Support clones preserve migration history and deploy every pending migration before granting the restricted test role access.

Both workflow final jobs use `always()` and reject any required validation result other than success for pull requests targeting develop/main. No workflow enablement, labels or manual runs were requested.

## Dependency advisory

The [primary GitHub advisory GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), checked 2026-10-29, identifies deepmerge 4.2.0–4.3.1 as affected and lists no patched release. `deepmerge-ts` is a separate package; its existing override does not fix this advisory. The vulnerable package is reached through the development-only shadcn tools.

Bun's committed `patchedDependencies` entry patches deepmerge's source and both shipped CommonJS/UMD bundles. Own properties are defined as data properties instead of invoking the inherited `__proto__` setter. This preserves normal merge/custom-array behavior. Regression tests exercise poisoning via target, source with a null-prototype target, and nested input. Version-based scanners may continue to flag 4.3.1 until an upstream patched release exists.

## Exact validation commands and results

```sh
bun install --frozen-lockfile --ignore-scripts
NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck
bun run lint
node_modules/.bin/vitest run --maxWorkers=1 \
  tests/deepmerge-security.test.ts \
  src/components/pharmacy/counter/counter-console.test.tsx \
  src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts \
  src/server/routers/pharmacy-prescriptions.authorization.test.ts \
  src/lib/pharmacy/operating-mode.test.ts \
  src/lib/pharmacy/customer-loyalty.test.ts \
  src/lib/pharmacy/customer-loyalty.completion.test.ts
DATABASE_URL=postgresql://localhost/postgres node scripts/verify-pharmacy-wallet-db.cjs
# With the already-authorized local owner URL supplied privately:
node scripts/run-support-security-postgres.mjs
```

- Unit: seven files, **230 passed**, zero failed/skipped.
- Fresh private socket PostgreSQL cluster: all migrations deployed normally; runtime role NOSUPERUSER/NOBYPASSRLS. **162 passed**, zero failed/skipped: finance 24, stock ledger 35, stored-value finance 44, wallet reporting 36, wallet security 11, receipt authorization 1, support security 11.
- Fresh branch-security role: **13 passed**, zero skipped.
- SOLO PIN/owner/STAFFED suites: three files, **56 passed**, zero skipped. These suites create their own restricted runtime roles from the disposable owner connection.
- Tenant RLS: `bun run test:rls` passed after isolated seeding. The harness uses the owner connection for setup; runtime-role and cross-tenant probes are enforced by the verification script.
- Support clone command: two files, **11 passed**, zero skipped.
- Both YAML files parsed; locally simulated **16 protected-PR gate scenarios passed**, covering success/skipped/failure/cancelled for both protected bases. No GitHub workflow was manually run.

## Visual coverage

`counter-lookup-matrix.json` records **16 checks** across 375/768/1024/1440 pixels, light/dark themes and normal/reduced motion. All pass one-H1 and document-overflow checks, with zero client render errors. Two screenshots show the current counter. Keyboard focus, an empty search and a populated masked-customer result were checked in the browser. Permission denial, error, disabled consent and cashier linking with a forbidden clinical panel are covered by component/router tests. The browser identity is the local solo demo owner; cashier/pharmacist coverage comes from automated authorization tests. No destructive confirmation changed.

The existing canonical visual matrix and screenshots remain historical evidence for the unchanged routes and shared primitives, rather than a claim those routes were rerun in this follow-up.

Typecheck, full `src/` lint, changed-file formatting and the frozen Bun install passed. Additional script/test lint passed; the existing CommonJS DB harness was checked with `--rule '@typescript-eslint/no-require-imports: off'`, preserving its established module format.

Production build: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/next build --webpack` passed with a privately supplied local database URL and ephemeral build auth secret; all 218 static-generation entries completed.
