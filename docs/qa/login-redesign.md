# Studio login redesign

## Routes and behavior

- `/login`: neutral workspace access. `?vertical=pharmacy`, `restaurant`, or `hotel` selects the matching presentation. Tenant metadata takes precedence over query presentation; recognized subdomain labels also select presentation. None of these values changes authentication scope.
- `/login/register`: workspace type selection. The three vertical query values show the corresponding request form.
- `/login/till`: explains enrolled-device requirements and links to the existing `/pos` terminal operator/PIN flow. No PIN verification or invented operators live on the public login page.

Authentication continues through the existing `/api/login`, Auth.js providers, SSO start routes, and native `/login/submit`. MFA/recovery codes, workspace selection, forgot-password, invite acceptance, CSRF checks and rate limiting retain their existing handlers.

## Request review

There was no public registration backend. `/api/workspace-requests` performs same-origin, rate-limit, streamed-size, field and document-signature checks, then creates a `PlatformLead` with status `NEW`, source `workspace-request:<vertical>`, and structured intake notes. It creates no active organization, user or session. Success is returned only after persistence.

Pharmacy evidence is persisted privately in the lead notes, limited to 1 MB (PDF/JPEG/PNG). CRM readers can download structured request details and the licence attachment through the platform-host-only API. Anonymous callers and operators without CRM read access cannot download evidence. This deliberately reuses the existing lead model and review queue; larger documents or a dedicated evidence lifecycle would warrant separate storage later.

Operators review/qualify requests in the existing CRM and use the existing organization provisioning and account invitation workflows. Intake does not automatically provision a workspace or send an invitation. Request forms collect contact details instead of an unused password; the owner sets a password through the existing invitation flow after approval.

Hotel copy describes property setup and proposed operating details, without claiming that reservation, folio or night-audit workflows exist.

## Visual evidence

All 12 supplied reference images were inspected. The implementation reuses Studio semantic tokens, fonts, logo, `Button`, and `StatusPill`. The existing fixed ink authentication hero recipe is retained in both themes. Mobile collapses the hero while retaining logo and workspace context.

Screenshots are captured under `/tmp/login-shots` by `tests/e2e/login-redesign.spec.ts`:

- `{neutral,pharmacy,restaurant,hotel}-sign-in-{375,768,1024,1440}-{light,dark}.png`
- `workspace-type-{375,768,1024,1440}-{light,dark}.png`
- `{pharmacy,restaurant,hotel}-register-{375,768,1024,1440}-{light,dark}.png`
- `till-unlock-{375,768,1024,1440}-{light,dark}.png`
- Additional request pending/error and sign-in error captures.

The matrix checks light/dark, normal/reduced motion, visible keyboard focus, Escape, document overflow, one H1, client errors, and automated WCAG A/AA checks at 375/1440. Additional tests cover RTL reflow, the credential keyboard sequence, failed request value retention/loading, and persisted submissions for all three verticals including licence bytes. Destructive confirmation and permission-gated workspace operations are not part of public intake; evidence download permission denial is covered separately.

## Reproduction

Use a disposable local PostgreSQL database with the repository's extension preparation and all migrations applied. Supply `DATABASE_URL`, a local `AUTH_SECRET`, `AUTH_TRUST_HOST=true`, and `SHARED_APP_HOSTS=127.0.0.1,localhost` without printing credentials.

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npx vitest run src/app/login src/app/api/login src/app/api/workspace-requests src/app/api/platform/workspace-requests src/lib/auth/login-intent.test.ts src/lib/auth/shared-login.test.ts
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4321 npx playwright test --config tests/e2e/login-redesign.config.ts
```

The browser suite requires a running server and the same disposable `DATABASE_URL` for verifying stored requests. Its submission tests consume the real intake rate limit; use a fresh database or clear only the disposable database's intake rate-limit buckets between repeated runs.

## Final validation — 2026-10-28

| Check                      | Result                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Related unit tests         | 113 passed across 12 files, using local PostgreSQL configuration                                                                                                                                                                                                                                                                                                    |
| Browser QA                 | All 14 distinct cases passed with JavaScript enabled: final full run 13 passed, one renderer crash; isolated retry of that 375px case passed                                                                                                                                                                                                                        |
| Accessibility and layout   | All eight width/theme matrix cases passed, including automated WCAG A/AA checks at 375/1440, reduced motion, focus, Escape, overflow and console checks; RTL and credential keyboard order passed                                                                                                                                                                   |
| Real intake                | All three vertical submissions persisted in PostgreSQL; pharmacy document bytes verified; error recovery preserves values; pending success follows persistence                                                                                                                                                                                                      |
| Evidence access            | Authenticated CRM reviewer download returned 200; anonymous download returned 403                                                                                                                                                                                                                                                                                   |
| Screenshots                | 84 PNGs in `/tmp/login-shots`; 32 representative images committed in the [gallery](login-redesign/README.md), with a complete [manifest](login-redesign/manifest.json)                                                                                                                                                                                              |
| Targeted lint and Prettier | Passed                                                                                                                                                                                                                                                                                                                                                              |
| Standalone typecheck       | Final `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck` attempt terminated with exit 143 (`Terminated`); no successful complete typecheck                                                                                                                                                                                                                  |
| Production build           | No successful production artifact. Default Turbopack compilation completed in 79s, then its 4 GB TypeScript worker exhausted its heap. Subsequent build attempts were resource-terminated; the webpack build explicitly reported worker `SIGTERM`. No further build retries were made                                                                               |
| Whole-repository lint      | Earlier completed run found existing errors in restaurant webhook `route.replay.test.ts` (`no-require-imports`), `app-shell.test.ts` (`no-children-prop`), and pharmacy `counter-console.tsx` (`set-state-in-effect`), plus a login parse error that was fixed. Final targeted lint is clean. A whole-tree rerun was stopped to free memory for the final typecheck |
| Whole-repository Prettier  | 87 existing unrelated files failed formatting; those files were left untouched                                                                                                                                                                                                                                                                                      |

Captures use the dev server because production builds did not complete. An early SSR-only fallback was attempted during resource pressure; final matrix evidence and all reported passing browser checks use JavaScript enabled. Developer overlays are hidden only during screenshot capture. The isolated local database had all 171 repository migrations applied, including the required extension privilege preparation. No Azure source or deployment files were changed.

## PR 681 integration follow-up — 2026-10-29

Normal merges incorporate `origin/develop` and `origin/recover/followup-2`. The
server workspace guard, default landing callback, SSO entitlement lookup, Auth.js
providers, MFA/recovery codes, and enrolled terminal PIN destination remain intact.

`src/components/auth/auth-shell.tsx` now owns the split composition, mobile logo,
form widths, and focusable skip destination for sign-in, workspace intake, till
help, forgot-password, reset-password, and invitation acceptance. The recovery
adapter only supplies context; it owns no layout. All routes inherit the Studio
semantic tokens and reduced-motion behavior. Recovery submit controls use the
shared `Button`; password reveal and auth action links provide 44px targets.

Agency and studio aliases select the agency presentation. Persisted `AGENCY` and
`HOSPITALITY` metadata take precedence over presentation queries. Agency requests
use the existing workspace chooser and invitation guidance; no unsupported intake
payload is submitted and no role or permission is inferred from a URL.

Regression coverage adds shared-shell landmarks and skip focus, tenant vertical
precedence, the solo-owner single-workspace continuation, associated recovery
field/server errors, password mismatch, value retention, and neutral password-reset
confirmation. Browser coverage adds agency/studio sign-in and recovery routes to
the 375/768/1024/1440 light/dark matrix, with both motion preferences represented.

Follow-up validation results and screenshot evidence are recorded below after
completion. Earlier validation above describes the previous implementation only.

| Follow-up check                     | Result                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Production build                    | `npm run build` passed, including TypeScript and 216 prerendered routes; no checks bypassed                         |
| Typecheck                           | Standalone `npm run typecheck` passed; final release rerun recorded below                                           |
| Lint                                | Whole-repository `npm run lint` passed; changed-source and browser-suite lint passed                                |
| Formatting                          | Changed source, new tests, and browser files passed Prettier                                                        |
| Focused regressions                 | 142 tests / 15 files passed; final auth/recovery subset 67 tests / 11 files passed                                  |
| Restricted-role database regression | All five growth-review RLS/storage cases passed with NOSUPERUSER / NOBYPASSRLS                                      |
| Production browser QA               | All 14 distinct cases passed: 13 in the full run, then the single interrupted 1440px case passed in isolation       |
| Visual evidence                     | [Complete 124-image gallery](login-redesign/followup/README.md), with dimensions and SHA-256 hashes in its manifest |

The browser server used a restricted local runtime role. All three intake submissions
persisted and private pharmacy document bytes were verified; CRM evidence access
returned 200 to the authorized reviewer and 403 anonymously. Width/theme/motion,
keyboard, overflow, WCAG A/AA, RTL and credential error checks passed. The matrix
uses distinct invalid invitation tokens to respect the unchanged per-token limit,
waits for the normal query retries, and asserts the expected 404/unavailable state;
all unexpected console and render errors still fail the test.

The interrupted 1440px browser navigation coincided with near-exhausted host memory;
its isolated rerun passed without source changes. Earlier build setup failures were
an external dependency symlink and missing production environment configuration.
The final standard build used a local dependency directory, disposable auth secret
and ordinary production checks. No Azure source or deployment files were changed.

Full-suite detail (all 905 configured test files were considered):

- Initial full run: 10,685 passed, 1,518 skipped, five restricted-role assertions
  failed because the migration-admin URL was supplied. Those same five cases
  passed after switching to the restricted runtime URL.
- Restricted-role full run: 10,688 passed, 1,518 skipped, two five-second UI
  timeouts under host contention. The meetings test searched accessible names
  across 170 cards; its lookup now stays within the pagination footer while
  retaining the entire fixture and the button role/name/click assertions.
- Final single-worker rerun of both affected UI files: **64 passed**, including
  both timed-out cases. Across the full runs and final reruns, all **10,690 enabled
  cases passed**. There was no single entirely green full-suite invocation.
- The 1,518 skipped cases retain the repository's existing opt-in integration
  gates; they were not enabled, removed, or represented as passing. No unit-test
  timeout or functional assertion was relaxed.
- Final release typecheck passed, including the browser-test updates. The
  meetings test refinement also passed its five-case file and ESLint.

The final production build predates only QA/test/documentation changes; no
application code changed after the successful build and production captures.
