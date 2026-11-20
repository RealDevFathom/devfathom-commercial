# DEV-1001 verification evidence

The baseline is `002b84ee1ca72880cee1f0ffebf4cdd79d343236` from `origin/develop`.
The AST inventory found 408 product native-select templates in 164 files, plus seven native test fixtures. This change migrates 367 templates in 147 files, retains ten documented native exceptions, and leaves all 31 pharmacy-counter templates untouched. Mapped templates can produce multiple runtime controls.

[Every baseline control and its disposition](inventory.md) is also included in full in the PR body. The new native element in `src/components/ui/select-field.tsx` is form infrastructure behind the shared Select after hydration; it is not an additional legacy dropdown.

The visible control uses the existing shared Select primitives and Studio recipes. A native form bridge preserves actual change events, successful form controls, validation, reset, original IDs/labels, imperative refs, external form association and a functional server-rendered fallback. Auth and platform selectors apply their existing field recipes to the visible trigger. Hidden controls cannot inherit field dimensions. The Notes toolbar keeps the selected value visible in its flex row.

## Scope and native exceptions

- Seven restaurant promotion multi-select listboxes retain native multiple selection, modifier-key interaction and ordered `selectedOptions` behavior.
- The restaurant branch picker remains native because floor/daily-close demo preparation requires a visible native branch control.
- The pharmacy SOP full IANA timezone list retains the phone picker. No timezone/day-boundary behavior was changed.
- The generic purchasing record picker retains native interaction for unbounded medicine, pack and supplier lists and its imperative OCR/validation integration. Its existing partial-Window test fixtures were not changed to accommodate a different control runtime.

No server, permission, database, package, lockfile, CI or agent-instruction changes are included. Nothing under `src/components/pharmacy/counter/` was edited. No production data or services were used.

## Automated evidence

- [Full unit run](checks/unit-summary.json): 26,963 passed, zero failures, 2,584 skipped; JSON additionally records one pending database case. All 1,804 files were included. The existing database/live-service prerequisites remain in place.
- [Prisma generation](checks/prisma.log)
- [Typecheck](checks/typecheck.log)
- [Lint](checks/lint.log): passes with 13 existing unused-variable warnings.
- [Production build](checks/build.log): passes; existing broad filesystem-tracing warnings in `src/lib/storage.ts` remain. Build database URLs pointed at an unused loopback port and auth values were synthetic.
- [Per-control results](checks/control-parity.json): 745 passed, none skipped. See [fixture methodology](../../tests/dev-1001/README.md).
- [Existing assertion audit](checks/assertion-integrity.json): 5,735 matchers and expected arguments across 111 changed test files are unchanged. Existing test edits only change control locators/interactions; no assertion, timeout or skip was relaxed.
- [Browser form evidence](form-parity.json): 56 checks across hydration/client-only rendering and normal/reduced motion, with 20 trusted browser Enter events and no option-click fallback. Zero console errors or network requests. Optional blanks submit an empty string; required blanks remain in raw FormData but block successful submission; disabled controls are omitted; the first-legend exception remains enabled. Also covers no-JavaScript fallback, reset, labels, external forms, tab order and Escape. The per-control jsdom suite explicitly supplies a click after Enter because jsdom does not perform browser activation; it does not alone prove native Enter activation.

Earlier typecheck/build attempts exceeded the default 4/6 GiB Node heap. The successful checks use `NODE_OPTIONS=--max-old-space-size=10240`; repository configuration is unchanged. The environment initially lacked Bun; repository checks use installed local binaries and equivalent npm scripts. The unit suite also uses an isolated Bun 1.4.2 binary under `/tmp`, a temporary loopback PostgreSQL 17 container for its migration fixtures, and Node’s TAP reporter for an existing subprocess-output assertion. No repository configuration was changed to provide these dependencies.

## Reproduction

```sh
node_modules/.bin/prisma generate
NODE_OPTIONS=--max-old-space-size=10240 npm run typecheck
npm run lint
PATH="/tmp/dev-1001-bun/bun-linux-x64:$PATH" \
  NODE_OPTIONS="--max-old-space-size=6144 --test-reporter=tap" \
  SUPERUSER_URL=postgresql://postgres@127.0.0.1:32768/postgres \
  npm test -- --maxWorkers=4
NODE_OPTIONS=--max-old-space-size=10240 npm run build
node_modules/.bin/vitest run tests/dev-1001/control-parity.test.tsx --maxWorkers=1
node tests/e2e/dev-1001-form-parity.mjs hydrate
node tests/e2e/dev-1001-form-parity.mjs csr
node tests/e2e/dev-1001-visual-qa.mjs before
node tests/e2e/dev-1001-visual-qa.mjs after
```

The browser harness bundles real screen components, existing CSS and local fonts with deterministic local query/fetch fixtures. Current runners fulfill a reserved `.invalid` origin entirely from in-memory bytes and abort every unrecognized request: no HTTP listener, local/LAN hosting or network traffic. Earlier completed screenshots used an isolated cloud-loopback fixture before the later no-hosting instruction; those listeners and the temporary test database were stopped. Existing results are reused, and the current strict reruns use in-memory interception. This verifies component appearance and interaction, not authenticated route integration, production data, permissions or database workflows. Per-control fixtures likewise substitute synthetic dynamic records while checking that the original call-site values, callbacks, options and labels remain structurally unchanged.

The [visual report and screenshot gallery](visual-report.md) includes exact variant counts, [coverage for every migrated source file](visual-family-coverage.md), keyboard results and known layout failures. Baseline client, HR, restaurant money and hotel function-spaces mobile overflow is retained as an unrelated limitation. The full unit summary and original final console summary are recorded in the checks directory.
