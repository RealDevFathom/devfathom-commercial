# DEV-103 AP invoice and payment reversal: visual QA evidence

Production build (`next build`, standalone) served against a seeded local PostgreSQL 16 (runtime
role without BYPASSRLS), headless Chromium. One pharmacy organization with Pharmacy Finance, two
owner-level people with their own PIN ("Saad Owner", "Hina Manager"), two branches. The bills and
payments were entered through the page's own forms: Hina recorded AP-QA-0001 (paid 4,000.00) and
AP-QA-0002, Saad recorded AP-QA-0003. Captures are taken signed in as Saad unless named otherwise.

Route: `/pharmacy/accounts/ap-aging?branch=…&asOf=…`, section "Reverse an invoice or payment".

| State | Files |
| --- | --- |
| Default (payment in force, invoice blocked until it is reversed, own entry routed to Hina, reversible invoice) | `reversal-default-{375,768,1024,1440}-{light,dark}.png` |
| Reduced motion | `reversal-default-1024-{light,dark}-reduced-motion.png` |
| Empty (branch with no posted invoice) | `reversal-empty-{375,768,1024,1440}-{light,dark}.png` |
| Keyboard: reason → PIN → button, visible focus ring | `keyboard-focus-button-1024-{light,dark}.png` |
| Destructive confirmation (reason and PIN entered, destructive button) | `destructive-confirmation-1024-{light,dark}.png` |
| Error: wrong PIN, values kept, `aria-invalid` | `error-wrong-pin-1024-{light,dark}.png` |
| Loading / disabled ("Reversing…") | `loading-disabled-1024-light.png` |
| Saved payment reversal; aging owes the amount again | `saved-payment-reversed-1024-light.png`, `aging-after-payment-reversal-1024-light.png` |
| Saved invoice reversal (leaves open invoices) | `saved-invoice-reversed-1024-light.png` |
| Second person: Hina sees Saad's invoice reversible and her own payment routed to Saad | `reversal-manager-view-768-dark.png` |

Results (`log.json`): 29 captures, no document horizontal overflow at any width, no console or page
errors. Tab order from the reason goes to the PIN, then to the destructive button. A wrong PIN
answers "Nothing was reversed. Enter your manager or owner PIN." and keeps the typed reason. The
audit log holds a FAILURE row (`AP_REVERSAL_PIN_REFUSED`) for each refused PIN and, for each
reversal, the approver, the person who recorded the entry, the policy, the reason and the time.

Defect found and fixed during the pass: a saved reversal removes its own row when the list
re-renders, so its confirmation disappeared with the form. The confirmation is now announced above
the list (`ReversalNoticeArea`), which stays mounted.

Not covered: Escape behaviour (no dialog on this screen; the PIN and reason fields are the
confirmation step, as on the set-off reversal).
