# Pharmacy browser QA — 2026-09-29

Candidate: `89f39834e7688c7f93dc467b945c980ada708463` (owned detached `ph-qa-specs`).

No tracked candidate edits, fixes, push, merge, or deployment. Only `.qa-run/rerun-0929/` harness/evidence and ignored Playwright/build outputs created. Earlier `install.log` retained. `git diff --exit-code` = 0. PostgreSQL loopback ports 55689/55690/55691/55692; owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE, runtime LOGIN NOSUPERUSER NOBYPASSRLS. Extension preparation, migrations, grants, seeds, and role checks recorded. All runs use `caffeinate -dimsu`; build uses `NODE_OPTIONS=--max-old-space-size=8192`.

Disk: initial 54 GiB, 53 GiB after production build, 38 GiB before final verification, 42 GiB at shutdown (other workspace activity changed capacity). Orchestrator checks >=8 GiB throughout subprocesses. Production `bun run build` exit 0; standalone static/public copy exit 0. No capacity stop this run.

## Scope and counts

- Original counter command collects 8 cases, not 7: seven counter cases plus a staging-only first-sale case. It returned 0 passed / 2 failed / 6 not run because the counter file is serial.
- Six previously unexecuted counter cases were then invoked individually with `--grep`, preflight and seed twice each. Combined unique seven counter cases: **1 passed / 6 failed / 0 unexecuted**. The passing case checks source for pointer APIs; all six browser cases stop at login. This is not a passing serial workflow.
- The additional first-sale case fails on `PHARMACY_FIRST_SALE_INPUT`; it requires authorized isolated shared staging and operator evidence, incompatible with this local disposable lane. No such evidence was invented.
- Purchasing: **2 passed / 4 failed / 0 skipped**, all six cases executed on the production standalone build.
- Finance's one test is collected twice by the unchanged default config (desktop and mobile). Initial runs exposed missing fixture module entitlement, then the restaurant seed's legacy EMPLOYEE role for Alex. Both are harness setup failures, not claimed product defects. The final `finance-verified` run provisions pharmacy-core/pharmacy-finance and ADMIN explicitly; its results below are authoritative.

## WHA-1196 assessment

**Missing automatic navigation symptom confirmed on this candidate; a lost server redirect header is not established here.** The receive action writes a DRAFT receipt and returns a success URL in an HTTP 200 RSC response. The client renders the drafted status and an “Open result” link, but keeps the old receiving URL and no selected receipt panel. The test fails at `tests/e2e/pharmacy-purchasing.spec.ts:134`, before posting stock. `purchasing-db-evidence.log` independently shows the draft row. The response has no redirect header because the current action returns a URL (`receiving/page.tsx:251`) and `PurchasingActionForm` commits a local outcome then calls `router.refresh()` (`_components/action-form.tsx:148–153`). Thus the historical header-loss mechanism is not reproduced by this code path; the browser acceptance requirement still fails. The drafted status **is visible**, correcting the preliminary progress statement that it was absent.

## Failures and probable causes

- Counter navigation and five functional cases: `/login` persists, empty fields, native POST /login 200; `pharmacy-counter.spec.ts:56`. Probable pre-hydration native form submission; this helper lacks the hydration guard used by purchasing/finance. No counter workflows reached, so pack conversion, Rx, FEFO, Urdu sales and safety behavior remain unverified.
- First-sale: runtime prerequisite failure at `fixtures/pharmacy-first-sale.ts:73`, before journey; blank screenshot is expected. Candidate config includes a staging-only test in the local counter lane.
- Purchasing receipt chain: draft success visible but selected receipt heading missing, `pharmacy-purchasing.spec.ts:134`. URL-string result plus current-route refresh leaves receipt selection unchanged. DB write succeeded; stock posting/exception resolution not reached.
- Purchasing resolved exception: missing settlement note, `pharmacy-purchasing.spec.ts:192`; downstream consequence of the preceding receipt-chain failure.
- Purchasing unauthorized supplier: supplier added successfully, but detail stays unselected; expected authorization explanation absent, `pharmacy-purchasing.spec.ts:212`. Same current-route refresh/selection mismatch. Does not prove an authorization bypass.
- Purchasing validation: expected field alert absent, `pharmacy-purchasing.spec.ts:260`; trace returns the correct expiry error with `outcome=unknown`. Client uses unknown-outcome lock and generic “Could not confirm the outcome,” rather than `store.reject`; `_components/action-form.tsx:125–143`.
- Initial finance: module gate at `pharmacy-finance.spec.ts:34`; absent finance entitlement in restaurant fixture.
- Intermediate finance: permission gate at `pharmacy-finance.spec.ts:35`; restaurant seed creates Alex as EMPLOYEE (`scripts/seed-restaurant-e2e.ts:1180`), despite Owner title, while finance page requires ADMIN. Final fixture corrects both prerequisites.

A final setup initially refused occupied port 55691 (exit 98); no service was touched. New free loopback port 55692 was then prepared successfully.

## Final finance result

**0 passed / 2 failed / 0 skipped**, exit 1, with prerequisites verified. Desktop reaches the finance form and fails at `pharmacy-finance.spec.ts:42`: non-exact `getByLabel('Reference')` matches both Reference and Bank reference. Probable test locator ambiguity; no transaction posted. Mobile fails in `beforeAll` at `pharmacy-finance.spec.ts:16`: `duplicate key value violates unique constraint "pharmacy_branches_org_id_key"`. Both projects concurrently insert the same branch into one DB; conflict handling covers only `(id)`, so another unique index can reject the concurrent insert. This failure occurs before a browser page; no screenshot is available for it. Final desktop screen/trace included. Financial posting, close/reopen and tax publication remain unverified.

## Exact browser/build commands and exits

Reporting flags retain HTML + line + JSON; supplemental `--output` protects earlier evidence.

- `counter`: `bun run test:e2e:pharmacy-counter --reporter=html,line,json` — exit **1**.
- `counter-shutdown`: `pg_ctl -D "$PGDATA" stop -m fast` — exit **0**.
- `purchasing-seed`: `bunx tsx tests/e2e/pharmacy-purchasing-seed.ts` — exit **0**.
- `build`: `df -h / && bun run build` — exit **0**.
- `standalone-assets`: `cp -R .next/static .next/standalone/.next/static && cp -R public .next/standalone/public` — exit **0**.
- `purchasing`: `bunx playwright test --config playwright.pharmacy-purchasing.config.ts --reporter=html,line,json` — exit **1**.
- `purchasing-shutdown`: `pg_ctl -D "$PGDATA" stop -m fast` — exit **0**.
- `finance-seed`: `bunx tsx prisma/seed.ts && bunx tsx scripts/seed-restaurant-e2e.ts` — exit **0**.
- `finance`: `bunx playwright test tests/e2e/pharmacy-finance.spec.ts --reporter=html,line,json` — exit **1**.
- `finance-shutdown`: `pg_ctl -D "$PGDATA" stop -m fast` — exit **0**.
- `counter-supplemental-1`: `bun run test:e2e:pharmacy-counter --reporter=html,line,json --grep "bill 1" --output=.qa-run/rerun-0929/counter-supplemental-1-artifacts` — exit **1**.
- `counter-supplemental-2`: `bun run test:e2e:pharmacy-counter --reporter=html,line,json --grep "bill 2" --output=.qa-run/rerun-0929/counter-supplemental-2-artifacts` — exit **1**.
- `counter-supplemental-3`: `bun run test:e2e:pharmacy-counter --reporter=html,line,json --grep "bill 3" --output=.qa-run/rerun-0929/counter-supplemental-3-artifacts` — exit **1**.
- `counter-supplemental-4`: `bun run test:e2e:pharmacy-counter --reporter=html,line,json --grep "POS-09" --output=.qa-run/rerun-0929/counter-supplemental-4-artifacts` — exit **1**.
- `counter-supplemental-5`: `bun run test:e2e:pharmacy-counter --reporter=html,line,json --grep "POS-01" --output=.qa-run/rerun-0929/counter-supplemental-5-artifacts` — exit **1**.
- `counter-supplemental-6`: `bun run test:e2e:pharmacy-counter --reporter=html,line,json --grep "this spec drives" --output=.qa-run/rerun-0929/counter-supplemental-6-artifacts` — exit **0**.
- `counter-supplemental-shutdown`: `pg_ctl -D "$PGDATA" stop -m fast` — exit **0**.
- `finance-corrected-seed`: `bunx tsx prisma/seed.ts && bunx tsx scripts/seed-restaurant-e2e.ts` — exit **0**.
- `finance-corrected`: `bunx playwright test tests/e2e/pharmacy-finance.spec.ts --reporter=html,line,json --output=.qa-run/rerun-0929/finance-corrected-artifacts` — exit **1**.
- `finance-corrected-shutdown`: `pg_ctl -D "$PGDATA" stop -m fast` — exit **0**.
- `finance-verified-seed`: `bunx tsx prisma/seed.ts && bunx tsx scripts/seed-restaurant-e2e.ts` — exit **0**.
- `finance-verified`: `bunx playwright test tests/e2e/pharmacy-finance.spec.ts --reporter=html,line,json --output=.qa-run/rerun-0929/finance-verified-artifacts` — exit **1**.
- `finance-verified-shutdown`: `pg_ctl -D "$PGDATA" stop -m fast` — exit **0**.

Setup SQL and exact scripts are in the evidence bundle; `exits.jsonl` records all command exits, including migrations/seeds/shutdown.

## Per-run counts

| Run | Passed | Failed | Skipped | Flaky | HTML report |
|---|---:|---:|---:|---:|---|
| counter | 0 | 2 | 6 | 0 | `counter-html/index.html` |
| counter-supplemental-1 | 0 | 1 | 0 | 0 | `counter-supplemental-1-html/index.html` |
| counter-supplemental-2 | 0 | 1 | 0 | 0 | `counter-supplemental-2-html/index.html` |
| counter-supplemental-3 | 0 | 1 | 0 | 0 | `counter-supplemental-3-html/index.html` |
| counter-supplemental-4 | 0 | 1 | 0 | 0 | `counter-supplemental-4-html/index.html` |
| counter-supplemental-5 | 0 | 1 | 0 | 0 | `counter-supplemental-5-html/index.html` |
| counter-supplemental-6 | 1 | 0 | 0 | 0 | `counter-supplemental-6-html/index.html` |
| finance-corrected | 0 | 2 | 0 | 0 | `finance-corrected-html/index.html` |
| finance | 0 | 2 | 0 | 0 | `finance-html/index.html` |
| finance-verified | 0 | 2 | 0 | 0 | `finance-verified-html/index.html` |
| purchasing | 2 | 4 | 0 | 0 | `purchasing-html/index.html` |

## Per-case evidence

Paths below are relative to the extracted bundle root. HTML data includes screenshots, videos and trace ZIPs; use `bunx playwright show-report <report-dir>` or `bunx playwright show-trace <trace.zip>`. Original paths remain in JSON, with portable archive paths mapped here.

### counter

- **failed** — pharmacy-counter-serial — pharmacy-only navigation exposes pharmacy destinations and excludes Restaurant routes (`pharmacy-counter.spec.ts:69`).
  - Assertion: `pharmacy-counter.spec.ts:56`. Symptom: Error: expect(page).toHaveURL(expected) failed  Expected pattern: /\/(dashboard|pharmacy)/ Received string:  "http://127.0.0.1:4331/login" Timeout: 30000ms
  - screenshot: `counter-html/data/d288b376221797c5a2d04ae8824022c315fcf48e.png`
  - video: `counter-html/data/794cdd2b89f9f823b55dc97bb31bf4c14ab525d0.webm`
  - error-context: `counter-html/data/6572c8ba1a7927e8cde4314d8a36f4216ecaed00.md`
  - trace: `counter-html/data/6e626077eb017c0cabf86f2317ac78fc30711a9d.zip`

- **skipped** — pharmacy-counter-serial — bill 1 — barcode scan, strip unit, cash tender and a bilingual receipt (`pharmacy-counter.spec.ts:140`).

- **skipped** — pharmacy-counter-serial — bill 2 — name search and a loose unit on a medicine with no strip level (`pharmacy-counter.spec.ts:207`).

- **skipped** — pharmacy-counter-serial — bill 3 — Urdu transliteration alias resolves the same medicine and sells a whole pack (`pharmacy-counter.spec.ts:239`).

- **skipped** — pharmacy-counter-serial — POS-09 — a safety block is distinct from advice, refuses tender, and is never acknowledged away (`pharmacy-counter.spec.ts:267`).

- **skipped** — pharmacy-counter-serial — POS-01 — the workflow map is on screen and the Legacy Speed preset is an honest placeholder (`pharmacy-counter.spec.ts:319`).

- **skipped** — pharmacy-counter-serial — this spec drives the counter without a pointer (`pharmacy-counter.spec.ts:354`).

- **failed** — pharmacy-counter-serial — admin follows the first-run checklist to the first completed sale (`time-to-first-sale.spec.ts:100`).
  - Assertion: `pharmacy-first-sale.ts:73`. Symptom: Error: Required runtime precondition: PHARMACY_FIRST_SALE_INPUT
  - screenshot: `counter-html/data/78485ad26ab49de2007fe98b0854715a58aaf5b6.png`
  - video: `counter-html/data/9fdc910b60f3eb3f35d4441ae8efca154fe86bac.webm`
  - error-context: `counter-html/data/f182e9ae0347b5daf6a70ecb0ea41dfd0267532b.md`
  - trace: `counter-html/data/a49907432d06120b9b42df4d7b83a947c514b320.zip`

### counter-supplemental-1

- **failed** — pharmacy-counter-serial — bill 1 — barcode scan, strip unit, cash tender and a bilingual receipt (`pharmacy-counter.spec.ts:140`).
  - Assertion: `pharmacy-counter.spec.ts:56`. Symptom: Error: expect(page).toHaveURL(expected) failed  Expected pattern: /\/(dashboard|pharmacy)/ Received string:  "http://127.0.0.1:4331/login" Timeout: 30000ms
  - screenshot: `counter-supplemental-1-html/data/98b6056fddc40b94c2ab7dee01e22efbf8d745f4.png`
  - video: `counter-supplemental-1-html/data/5dab283975496c99a3f8b323e2f17bc4ea9acd6c.webm`
  - error-context: `counter-supplemental-1-html/data/808e915273286417edb6d4509c9edc9011c299d3.md`
  - trace: `counter-supplemental-1-html/data/03881e8e0bb254cf9322d61f57b66086d06f3836.zip`

### counter-supplemental-2

- **failed** — pharmacy-counter-serial — bill 2 — name search and a loose unit on a medicine with no strip level (`pharmacy-counter.spec.ts:207`).
  - Assertion: `pharmacy-counter.spec.ts:56`. Symptom: Error: expect(page).toHaveURL(expected) failed  Expected pattern: /\/(dashboard|pharmacy)/ Received string:  "http://127.0.0.1:4331/login" Timeout: 30000ms
  - screenshot: `counter-supplemental-2-html/data/44b8e1453b3c7f8b7dd02285abdf468ce06d675e.png`
  - video: `counter-supplemental-2-html/data/bfc72e5c684e69b65b4189a055a2a8355b3bfdf5.webm`
  - error-context: `counter-supplemental-2-html/data/b57481ea7c190f6f8bbecbb7ddc153c8a601890a.md`
  - trace: `counter-supplemental-2-html/data/d029eb2cff03272910c737b7e0fb94dffda6e6d4.zip`

### counter-supplemental-3

- **failed** — pharmacy-counter-serial — bill 3 — Urdu transliteration alias resolves the same medicine and sells a whole pack (`pharmacy-counter.spec.ts:239`).
  - Assertion: `pharmacy-counter.spec.ts:56`. Symptom: Error: expect(page).toHaveURL(expected) failed  Expected pattern: /\/(dashboard|pharmacy)/ Received string:  "http://127.0.0.1:4331/login" Timeout: 30000ms
  - screenshot: `counter-supplemental-3-html/data/34716c11494e16ada2daf0a9e2559a44bb448a2a.png`
  - video: `counter-supplemental-3-html/data/dfda7951d436680ce877f2d39440bc1802c9ed48.webm`
  - error-context: `counter-supplemental-3-html/data/fe3e925612a6796f9696bfaca581f1a689e8ef11.md`
  - trace: `counter-supplemental-3-html/data/9f13e43a5ef179d6f122096e5354148401817351.zip`

### counter-supplemental-4

- **failed** — pharmacy-counter-serial — POS-09 — a safety block is distinct from advice, refuses tender, and is never acknowledged away (`pharmacy-counter.spec.ts:267`).
  - Assertion: `pharmacy-counter.spec.ts:56`. Symptom: Error: expect(page).toHaveURL(expected) failed  Expected pattern: /\/(dashboard|pharmacy)/ Received string:  "http://127.0.0.1:4331/login" Timeout: 30000ms
  - screenshot: `counter-supplemental-4-html/data/8b6ad813e034f3077959cf49023ed37b293a28b2.png`
  - video: `counter-supplemental-4-html/data/ddab97b8d7459a3c52e586fa9977ce5ac2dba908.webm`
  - error-context: `counter-supplemental-4-html/data/41c1471eb8076b5eaf9d90cd7d31a1ee510904c5.md`
  - trace: `counter-supplemental-4-html/data/3e2f6e9dae3f5c1da7546229262540e0bf9347a0.zip`

### counter-supplemental-5

- **failed** — pharmacy-counter-serial — POS-01 — the workflow map is on screen and the Legacy Speed preset is an honest placeholder (`pharmacy-counter.spec.ts:319`).
  - Assertion: `pharmacy-counter.spec.ts:56`. Symptom: Error: expect(page).toHaveURL(expected) failed  Expected pattern: /\/(dashboard|pharmacy)/ Received string:  "http://127.0.0.1:4331/login" Timeout: 30000ms
  - screenshot: `counter-supplemental-5-html/data/46366dedb2fed314afe61723db2a42e4333891ec.png`
  - video: `counter-supplemental-5-html/data/47bf4407ef2227d4d08a2d0f5eab8624891c89dc.webm`
  - error-context: `counter-supplemental-5-html/data/277ecb48723060397ee1259c6610c0ef67ad774a.md`
  - trace: `counter-supplemental-5-html/data/468101606565c468b161db7a380abd29e5fc350c.zip`

### counter-supplemental-6

- **passed** — pharmacy-counter-serial — this spec drives the counter without a pointer (`pharmacy-counter.spec.ts:354`).

### finance-corrected

- **failed** — chromium-desktop — fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids (`pharmacy-finance.spec.ts:27`).
  - Assertion: `pharmacy-finance.spec.ts:35`. Symptom: Error: expect(locator).toHaveValue(expected) failed  Locator: getByLabel('Branch') Expected: "branch_pharmacy_finance_e2e" Timeout: 5000ms Error: element(s) not found
  - screenshot: `finance-corrected-html/data/2040ffe13209f8b8b007e34e9e9ad4b891a3fb5c.png`
  - video: `finance-corrected-html/data/541688f1a8e347496def9860b96aab4401333958.webm`
  - error-context: `finance-corrected-html/data/775c491c1199fbe62833bac743bac05e9d79ad3b.md`
  - trace: `finance-corrected-html/data/2b3d3c28f42f431c390af123bac675414e367918.zip`

- **failed** — mobile-chromium — fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids (`pharmacy-finance.spec.ts:27`).
  - Assertion: `pharmacy-finance.spec.ts:35`. Symptom: Error: expect(locator).toHaveValue(expected) failed  Locator: getByLabel('Branch') Expected: "branch_pharmacy_finance_e2e" Timeout: 5000ms Error: element(s) not found
  - screenshot: `finance-corrected-html/data/c2f1611f318849d7e9dc87ae31308d44fa3938fd.png`
  - video: `finance-corrected-html/data/96817233fd11c19c676093532dbace9cd759749a.webm`
  - error-context: `finance-corrected-html/data/b5f2dd04ba876acdcbde73e1562a3cedc5a92ff0.md`
  - trace: `finance-corrected-html/data/071ce47adeae310f8d191161efa819ee60a22439.zip`

### finance

- **failed** — chromium-desktop — fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids (`pharmacy-finance.spec.ts:27`).
  - Assertion: `pharmacy-finance.spec.ts:34`. Symptom: Error: expect(locator).toBeVisible() failed  Locator: getByRole('heading', { name: 'Finance', exact: true }) Expected: visible Timeout: 5000ms Error: element(s) not found
  - screenshot: `finance-html/data/6ff3f4eae1cd258c2f817b6c981d7143bbdad025.png`
  - video: `finance-html/data/95e4bb9f3db657ddcdc7cdbdf2042bedc850d493.webm`
  - error-context: `finance-html/data/0393b7340cbc9ed6a29e7f313ae6f856038466bd.md`
  - trace: `finance-html/data/9b6e06eedbd30de22279fb71dd8926e41e65c961.zip`

- **failed** — mobile-chromium — fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids (`pharmacy-finance.spec.ts:27`).
  - Assertion: `pharmacy-finance.spec.ts:34`. Symptom: Error: expect(locator).toBeVisible() failed  Locator: getByRole('heading', { name: 'Finance', exact: true }) Expected: visible Timeout: 5000ms Error: element(s) not found
  - screenshot: `finance-html/data/83afc8024e9ab944bc81f0f565eca3826bdbf835.png`
  - video: `finance-html/data/8fea2ccfdcb1007f82755c6810945320f5ff6b5f.webm`
  - error-context: `finance-html/data/19b2ed091161efcc83aa477a786fca0feacb68b0.md`
  - trace: `finance-html/data/9df8c61e95dfa51ac21ce0f9469b3a402a9ea434.zip`

### finance-verified

- **failed** — chromium-desktop — fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids (`pharmacy-finance.spec.ts:27`).
  - Assertion: `pharmacy-finance.spec.ts:42`. Symptom: Error: locator.fill: Error: strict mode violation: locator('[data-slot="section-card"]').filter({ hasText: 'Record money movement' }).getByLabel('Reference') resolved to 2 elements:     1) <input required="" name="reference" data-slot="input" placeholder="PV-2026-001" id="base-ui-_R_i9d5esnebnaqitmlb_" class="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-n…/> aka getByRole('textbox', { name: 'Reference', exact: true })     2) <input data-slot="input" name="bankReference" id="base-ui-_R_kpd5esnebnaqitmlb_" class="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 di…/> aka getByRole('textbox', { name: 'Bank reference' })
  - screenshot: `finance-verified-html/data/5b72100fc1776724defc50ef89809e6855541d12.png`
  - video: `finance-verified-html/data/86ed7617d8ed70f389fd61e0d3041b9300c6e68b.webm`
  - error-context: `finance-verified-html/data/6f4f156f478ea81c8fb981613289629352f21a89.md`
  - trace: `finance-verified-html/data/79906f2d378ee85c6cb4d89971dcd9a5922e300a.zip`

- **failed** — mobile-chromium — fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids (`pharmacy-finance.spec.ts:27`).
  - Assertion: `pharmacy-finance.spec.ts:16`. Symptom: error: duplicate key value violates unique constraint "pharmacy_branches_org_id_key"
  - error-context: `finance-verified-html/data/d61d57c3b796d87aaa182e6ce12bf6048ee4cc88.md`
  - trace: `finance-verified-html/data/38e65eab1ef382aeb40688caf16d43343136c786.zip`

### purchasing

- **passed** — pharmacy-purchasing-serial — the overview reports a workspace that is ready to receive (`pharmacy-purchasing.spec.ts:70`).

- **failed** — pharmacy-purchasing-serial — PO → receive → exception → resolve → stock visible (`pharmacy-purchasing.spec.ts:82`).
  - Assertion: `pharmacy-purchasing.spec.ts:134`. Symptom: Error: expect(locator).toBeVisible() failed  Locator: getByRole('heading', { name: 'GRN-E2E-1-0-20260929155159', level: 2 }).first() Expected: visible Timeout: 30000ms Error: element(s) not found
  - screenshot: `purchasing-html/data/f4247c4d7fd2288330cec8cc138bf1d872977155.png`
  - video: `purchasing-html/data/caa041e5896991cc3907081e2d79027dcdae8888.webm`
  - error-context: `purchasing-html/data/a3cad93e72001bc5d7ecf8927a6281e6bf8c03b5.md`
  - trace: `purchasing-html/data/10aa905d702ee0c80e593621fac119d9a83e20d6.zip`

- **failed** — pharmacy-purchasing-serial — the resolved exception is kept with the note that closed it (`pharmacy-purchasing.spec.ts:183`).
  - Assertion: `pharmacy-purchasing.spec.ts:192`. Symptom: Error: expect(locator).toBeVisible() failed  Locator: getByText('Supplier confirmed a short ship; balance cancelled.').first() Expected: visible Timeout: 30000ms Error: element(s) not found
  - screenshot: `purchasing-html/data/69992228e08cb48e4b79abe68d48bee15c2be429.png`
  - video: `purchasing-html/data/ae24aa13652c3a1829af83a59d61941756515952.webm`
  - error-context: `purchasing-html/data/f7da3cd6cea46b78a28cfe00da3249781438feb5.md`
  - trace: `purchasing-html/data/644167dd3bb0088900a97052a403b0787271b371.zip`

- **failed** — pharmacy-purchasing-serial — PUR-01 offers an unauthorized supplier as an explained, unselectable option (`pharmacy-purchasing.spec.ts:195`).
  - Assertion: `pharmacy-purchasing.spec.ts:212`. Symptom: Error: expect(locator).toBeVisible() failed  Locator: getByText('Trade with this supplier is not authorized').first() Expected: visible Timeout: 30000ms Error: element(s) not found
  - screenshot: `purchasing-html/data/d35ecf38160c3e2521b385d56fa146f052455157.png`
  - video: `purchasing-html/data/75bca7642b3c1485dbf3fadf137c764d2fc61cc2.webm`
  - error-context: `purchasing-html/data/d2b546bd54c8454ebbb5d469eb2d34e0f9ce5818.md`
  - trace: `purchasing-html/data/b9ad5ef30d6d78df2d268a7813937a025413d13c.zip`

- **passed** — pharmacy-purchasing-serial — PUR-05 never offers the receiver as their own bypass approver (`pharmacy-purchasing.spec.ts:223`).

- **failed** — pharmacy-purchasing-serial — a validation failure names its field, focuses it, and keeps the rest valid (`pharmacy-purchasing.spec.ts:237`).
  - Assertion: `pharmacy-purchasing.spec.ts:260`. Symptom: Error: expect(locator).toBeVisible() failed  Locator: getByRole('alert').filter({ hasText: 'A licence must expire after it was issued.' }).first() Expected: visible Timeout: 20000ms Error: element(s) not found
  - screenshot: `purchasing-html/data/faaa33204e3deadb2a1ed3114ebb9b7b791e5674.png`
  - video: `purchasing-html/data/1737e933a0ada396db1deb566af8627949b4a441.webm`
  - error-context: `purchasing-html/data/6d85522abc40b70af61bc501f6f4608a3756edbe.md`
  - trace: `purchasing-html/data/cf0605635a15e3f646d2cd2c4f608235f9a7ed3f.zip`

## Limits and disposition

Execution evidence is complete; failures remain. No fixes attempted. Local DBs stopped with recorded shutdown exits. All browser tests were attempted (counter serial skips covered individually); downstream steps inside failed tests remain unverified. Board review requested on this issue, not release approval. No rollback required for product source; disposable fixture changes affect only owned local databases.
