import pathlib,json,re,hashlib,zipfile,subprocess
root=pathlib.Path.cwd();out=root/'.qa-run/rerun-0929'
ansi=re.compile(r'\x1b\[[0-9;]*m')
def tests(d):
 for s in d.get('suites',[]):
  yield from tests(s)
 for p in d.get('specs',[]):
  for t in p['tests']:
   for r in t['results']:yield p,t,r
results={p.name.removesuffix('-results.json'):json.loads(p.read_text()) for p in sorted(out.glob('*-results.json'))}
report='''# Pharmacy browser QA — 2026-09-29

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

'''
steps=[json.loads(l) for l in (out/'exits.jsonl').read_text().splitlines()]
for e in steps:
 if '\n' not in e['command'] and e['step'] not in ['finance-entitlements','finance-verified-entitlements']:
  report+=f"- `{e['step']}`: `{e['command']}` — exit **{e['exit']}**.\n"
report+='\nSetup SQL and exact scripts are in the evidence bundle; `exits.jsonl` records all command exits, including migrations/seeds/shutdown.\n\n## Per-run counts\n\n| Run | Passed | Failed | Skipped | Flaky | HTML report |\n|---|---:|---:|---:|---:|---|\n'
for name,d in results.items():
 st=d['stats'];report+=f"| {name} | {st['expected']} | {st['unexpected']} | {st['skipped']} | {st['flaky']} | `{name}-html/index.html` |\n"
report+='\n## Per-case evidence\n\nPaths below are relative to the extracted bundle root. HTML data includes screenshots, videos and trace ZIPs; use `bunx playwright show-report <report-dir>` or `bunx playwright show-trace <trace.zip>`. Original paths remain in JSON, with portable archive paths mapped here.\n'
for name,d in results.items():
 report+=f'\n### {name}\n'
 datafiles=list((out/(name+'-html')/'data').glob('*'))
 hashes={hashlib.sha256(p.read_bytes()).digest():str(p.relative_to(out)) for p in datafiles}
 for p,t,r in tests(d):
  report+=f"\n- **{r['status']}** — {t['projectName']} — {p['title']} (`{p['file']}:{p['line']}`).\n"
  if r.get('error'):
   err=r['error'];loc=err.get('location',{});msg=ansi.sub('',err.get('message',''))
   report+=f"  - Assertion: `{pathlib.Path(loc.get('file','')).name}:{loc.get('line','?')}`. Symptom: {msg.split('Call log:')[0].strip().replace(chr(10),' ')}\n"
  for a in r.get('attachments',[]):
   path=pathlib.Path(a.get('path',''))
   if path.is_file():
    mapped=hashes.get(hashlib.sha256(path.read_bytes()).digest(),str(path))
    report+=f"  - {a['name']}: `{mapped}`\n"
report+='\n## Limits and disposition\n\nExecution evidence is complete; failures remain. No fixes attempted. Local DBs stopped with recorded shutdown exits. All browser tests were attempted (counter serial skips covered individually); downstream steps inside failed tests remain unverified. Board review requested on this issue, not release approval. No rollback required for product source; disposable fixture changes affect only owned local databases.\n'
(out/'report.md').write_text(report)
# Self-contained HTML reports already contain original trace/video/screenshot payloads.
groups={'counter-original':['counter'],'counter-supplemental':['counter-supplemental-'+str(i) for i in range(1,7)],'purchasing':['purchasing'],'finance':['finance','finance-corrected','finance-verified']}
for group,names in groups.items():
 with zipfile.ZipFile(out/(group+'-evidence.zip'),'w',zipfile.ZIP_DEFLATED) as z:
  z.write(out/'report.md','report.md')
  for name in names:
   for p in (out/(name+'-html')).rglob('*'):
    if p.is_file():z.write(p,p.relative_to(out))
  for p in out.iterdir():
   if p.is_file() and p.suffix in ['.log','.json','.jsonl','.py','.sql'] and not p.name.startswith('upload'):
    if p.name.startswith(tuple(names)) or p.name in ['shutdown-verification.json','exits.jsonl','run.py','supplemental.py','orchestrator.log','finance-entitlements.sql','finance-entitlements.log']:
     z.write(p,p.name)
 print(group,(out/(group+'-evidence.zip')).stat().st_size)
print('REPORT',len(report))
