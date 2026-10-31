# PR #798 targeted visual QA

Chromium against `next dev`, 2026-10-31. Synthetic customer data only.

| Coverage | Customer entry and portal | Pharmacist queue and settings |
| --- | --- | --- |
| 375 / 768 / 1024 / 1440px | Passed | Passed |
| Light / dark | Passed | Passed |
| Normal / reduced motion | Passed | Passed |
| Document overflow | None | None |
| New action touch targets | At least 44px | At least 44px |
| axe WCAG A/AA checks | Zero violations | Zero violations |
| Hydration / render / client-fetch console errors | None | None |
| Keyboard / focus | Tab and Escape checked; visible focus | PIN entry, approval, native decline cancellation |
| States | Loading, SMS code entry, signed in, empty, consent required, disabled | Loading, active request, settings, PIN submission, decline confirmation |

The customer document was served from the real public route without a staff
cookie (HTTP 200). Its client API used deterministic fixtures for SMS sign-in,
receipts, rewards, balances and request states. The staff component used a
temporary local rendering harness with the shared Studio providers and fixture
APIs because this checkout has no authenticated tenant fixture. The harness was
removed. One 375px case also opened the embedded Rx capture form with the original
customer photo attached. Existing AppShell geometry was not changed.

Transport/unit tests cover authorization and failed submissions. Separate real
PostgreSQL tests cover persistence, concurrency and RLS; visual fixtures do not
establish those properties. Live SMS delivery and bank transfers were not sent.
Raast reconciliation remains the existing staff payment operation. PWA manifest
delivery and public entry were checked; an OS installation prompt was not tested.

Reused `PageHeader`, `SectionCard`, `Button`, `StatusPill`, `Field`, `WorkspaceState`,
Studio shell/canvas classes, and the existing semantic light/dark tokens. There is
no platform-control-plane change.

Evidence: [customer mobile](customer-375-light.png),
[customer desktop dark](customer-1440-dark.png),
[staff mobile with Rx capture](staff-375-light.png),
[customer matrix](matrix.json), [staff matrix](staff-matrix.json).
