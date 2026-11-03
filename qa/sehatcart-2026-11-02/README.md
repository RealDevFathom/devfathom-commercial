# SehatCart develop QA pass (2026-11-02)

Working files for the QA pass logged in `/HANDOFF.md`.

- `findings-log.md` — running findings (N1…, plus re-verified GitHub issues) with evidence and code references.
- `rbac-static.tsv` — static authorization audit of every pharmacy tRPC procedure (+ organization admin and team).
- `harness/` — Playwright + tRPC scripts used for the live checks.
- `flows/` — JSON step files for `harness/steps.mjs` (UI flows).
- Screenshots and captured receipts are in `/qa-evidence/`.

## Running the harness

Credentials and session cookies are never stored in the repository.

```bash
export QA_REPO=$(pwd)                       # repo root (for node_modules and package.json)
export QA_SCRATCH=/tmp/qa-scratch           # session cookies + raw JSON outputs (outside the repo)
export QA_CREDS=/path/outside/repo/creds.json
# creds.json: {"baseUrl":"https://sehatcart.pharmacy.develop.devfathom.com",
#              "owner":{"email":"…","password":"…"}, "cashier":{…}, "manager":{…}, "pharmacist":{…}}
node qa/sehatcart-2026-11-02/harness/login-all.mjs
PERSIST=1 node qa/sehatcart-2026-11-02/harness/steps.mjs cashier qa/sehatcart-2026-11-02/flows/sale8.json
```

The scripts launch the pre-installed Chromium at `/opt/pw-browsers/chromium`; change `browser()` in `harness/lib.mjs` if your machine differs.
