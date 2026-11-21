# Counter v2, phase 2B: visual QA evidence

Screenshots were taken from the running app: `next dev`, PostgreSQL 16 with migrations, and the
pharmacy counter E2E seed, using the pinned Chromium at `/opt/pw-browsers/chromium`. They were
not taken from a mocked harness.

The before set comes from `develop` at 7dd8187. The after set comes from this change.

Each image holds one panel at five widths (1440, 1366, 1024, 768, 375), in light and dark.

| Image | Design state | Panel |
| --- | --- | --- |
| `*-bill.png` | A1, C2, C3 | The bill with no panel open (completes phase 2A's matrix) |
| `*-payment-cash.png` | A2, C4 | Payment sheet, cash with change |
| `*-payment-khata.png` | B1 | Payment sheet, khata |
| `*-payment-reduced-motion.png` | — | Payment sheet with reduced motion, 1440 light |
| `*-paid.png` | A3 | The paid bill |
| `*-receipt.png` | A3, C5 | Receipt sheet |
| `*-discount.png` | A4 | Discount sheet |
| `*-checks.png` | A5 | Patient and prescription sheet, which holds the controlled medicine steps |
| `*-returns.png` | B3 | Returns sheet |
| `*-no-permission.png` | C6 | Returns, as a cashier with no refund access (1440 and 375) |
| `*-offline.png` | B2, C7 | Offline banner. Offline selling is off, so the counter is a price check. |

The E2E seed has no controlled medicine, so `*-checks.png` shows the sheet without the controlled
steps. The arrangement of those steps is covered by unit tests in `counter-rx-panel.test.tsx`.

## Keyboard only (1440, light, reduced motion)

The test opened each sheet from the keyboard, pressed Tab 30 times and Shift+Tab 10 times about
120 ms apart, then pressed Escape.

| Sheet | Before: focus kept in sheet | Before: focus returned to | After: focus kept in sheet | After: focus returned to |
| --- | --- | --- | --- | --- |
| Payment | yes | Scan or search | yes | Scan or search |
| Discount | no (a non-modal popover) | "Skip to scan or search" | yes | Scan or search |
| Patient and checks | yes | Scan or search | yes | Scan or search |
| Returns | yes | Returns & refunds | yes | Returns & refunds |

In both runs, Escape closed every sheet and the focused control had a visible focus style.

No screenshot in either set has document-level horizontal overflow.
