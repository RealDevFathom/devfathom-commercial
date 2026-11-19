# DEV-103 final part: visual QA evidence

Production build (`next build`, standalone) served against a seeded local PostgreSQL 16 (runtime
role without BYPASSRLS), headless Chromium at device scale 1. Synthetic data only: one pharmacy
organization (Asia/Karachi) with Pharmacy Finance and Pharmacy Reports, two active branches
("Main Branch", "Gulshan Branch"), three people with their own PIN:

- "Saad Owner": owner-level, every capability. Captures are signed in as Saad unless named otherwise.
- "Hina Finance": owner-level, only `admin:access`, `finance:read`, `pharmacy:manage` and the two
  report grants. No counter grant.
- "Ali Staff": not owner-level, counter grant only.

30 supplier expense invoices on Main Branch (Hina recorded AP-QA-0001 to 0010, Saad the rest),
six of them with payments of 234.56.

## Branch picker (general journal, journal entry lookup, posted cash coverage, trial-balance control)

| State | Files |
| --- | --- |
| Default, nothing chosen (picker lists both branches by name) | `{general-journal,journal-lookup,liquidity,trial-balance}-default-{375,768,1024,1440}-{light,dark}.png` |
| Branch chosen and read | `*-selected-{375,768,1024,1440}-{light,dark}.png` |
| Branch in the URL that is not the organization's (prompt shown, router refuses) | `*-unlisted-branch-1024-{light,dark}.png` |
| Non-owner: no branches offered, router refuses | `*-denied-non-owner-{375,1024}-light.png` |
| Keyboard focus on the picker | `*-keyboard-focus-1024-{light,dark}.png` |
| Reduced motion | `*-default-reduced-motion-1024-{light,dark}.png` |

## Reversal search and paging (supplier expense aging, "Reverse an invoice or payment")

| State | Files |
| --- | --- |
| First page (25 invoices, "Older invoices") | `reversal-page1-{375,768,1024,1440}-{light,dark}.png` |
| Second page ("Newer invoices", no older page) | `reversal-page2-{375,1024}-{light,dark}.png` |
| Search by amount 234.56 (matches the payments) | `reversal-search-amount-{375,768,1024,1440}-{light,dark}.png` |
| Search by payee and a day range | `reversal-search-payee-dates-{768,1440}-{light,dark}.png` |
| Invalid search (three decimals, to before from): fields named, nothing searched | `reversal-search-invalid-{375,768,1024,1440}-{light,dark}.png` |
| Search with no match | `reversal-search-empty-{375,1024}-{light,dark}.png` |
| Keyboard focus in the search form | `reversal-keyboard-focus-1024-{light,dark}.png` |
| Reduced motion | `reversal-page1-reduced-motion-1024-{light,dark}.png` |
| Hina (no counter grant) sees Saad's entries as reversible | `reversal-hina-view-768-dark.png` |

## Results (`log.json`)

No document horizontal overflow at any width, no console errors, no page errors. Each picker
lists "Choose a branch", then the two branches by name. Keyboard: the picker is reachable with Tab
and shows the focus ring; the next Tab goes to the page's next field (as-of or cutoff date, entry
ID, from date) or its submit button. In the search form Tab goes payee, reference, amount, then the
date fields (Chromium's date segments), then Search. "Older invoices" on page 1 opens
`rvPage=2`, which shows "Page 2", "Newer invoices" and no older link; submitting the form starts
again from page 1 and keeps the aging request (branch, as-of day, payee filter). Saad's own entries
read "You recorded this, so Hina Finance or another manager or owner must reverse it": Hina has
no counter grant and now counts as someone else who could approve.

Defect found and fixed during the pass: with a field error at 1024 px the five search fields in one
row wrapped their labels and lost their alignment. The form now uses three columns from 1024 px,
fields aligned to the top and the actions to the bottom.

Not covered: loading state (server-rendered GET forms, no client loading UI) and Escape behaviour
(no dialog on these screens). The destructive confirmation, wrong-PIN error and saved states of the
reversal form are unchanged from `qa-evidence/dev-103-ap-reversal`.
