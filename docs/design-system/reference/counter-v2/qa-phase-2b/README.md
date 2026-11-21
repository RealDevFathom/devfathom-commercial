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

## Added by DEV-1005: the states the review found missing

These were taken by the counter browser lane itself (`tests/e2e/pharmacy-counter.spec.ts`,
helper `qaShots`) from the running app: `next dev`, PostgreSQL 16 with migrations and a restricted
runtime role (`rolsuper` and `rolbypassrls` both false), the pharmacy counter E2E seed, Chromium at
`/opt/pw-browsers/chromium`, every action from the keyboard. The lane writes each shot to
`playwright-artifacts/pharmacy-counter-qa-phase-2b/`; the images here are those shots, labelled and
laid out in the same way as above. Every shot is checked for document-level horizontal overflow
before it is taken.

The E2E seed now holds a controlled capsule (Fathomadol E2E) and a staff PIN for the seeded
pharmacist, so the controlled steps are shown on the real panel, not only in unit tests.

| Image                                      | Design state | What it shows                                                                                                                     |
| ------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `after-payment-wallet-split.png`           | A2           | 4.00 taken in cash, the rest by JazzCash with the payer's name and transaction ID                                                 |
| `after-payment-not-confirmed.png`          | A7           | The JazzCash payment reached the server but its answer was lost: the sheet is locked until the outcome is checked                 |
| `after-payment-khata-over-limit.png`       | B1           | Khata charge over the family limit, with the limit meter (limit, used, available) and the owner approval box                      |
| `after-payment-method-not-set-up.png`      | B8           | JazzCash switched off for the branch while the sheet was open: "JAZZCASH is not enabled at this branch" and payment by it refused |
| `after-controlled-step-1-patient.png`      | A5           | Controlled medicine, step 1: patient and address                                                                                  |
| `after-controlled-step-2-prescription.png` | A5           | Step 2: an emergency supply with the prescriber's name                                                                            |
| `after-controlled-step-3-pharmacist.png`   | A5           | Step 3: the approving pharmacist and their PIN                                                                                    |

Each image holds one state at 1440, 1366, 1024, 768 and 375, light and dark, with reduced motion
and the keyboard focus on the control named in the test.

A wallet that is not set up is not offered as a method at all (Easypaisa above is absent); B8 is
therefore shown the one way the running app reaches it: a set-up method switched off while it is
chosen.

## Keyboard only, with reduced motion (1366 and 375, light and dark)

One image per panel, `after-keyboard-<panel>.png`: `drawer-open` (the counter before a bill),
`bill`, `payment-cash`, `payment-khata`, `paid`, `receipt`, `discount`, `discount-approval`,
`checks` (patient, prescription and the controlled steps), `returns`, `no-permission` (a cashier)
and `offline`. In each, the control inside the panel was reached with Shift+Tab then Tab, and the
lane asserts it matches `:focus-visible` before the shot, so the ring in the image is the one a
keyboard user sees.
