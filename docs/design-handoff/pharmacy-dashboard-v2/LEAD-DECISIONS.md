# Pharmacy dashboard v2: decisions that go with the handoff

Read `HANDOFF.md` first. Where this file and the handoff differ, this file wins. The owner approved
the concept on 27 November 2026 and left the improvements below to the lead.

## Decided

1. **Daily figures: build the query.** Add `pharmacyReports.dailyTrade` as described in handoff §5.
   One grouped read, at most 30 days, behind `reports:financial`, with the same branch-scope rule
   as `commandCentre`. A day is the business's own calendar day (its time zone), not UTC. A refund
   counts on the day it was made. The "one request per day" fallback is not allowed.
2. **Reorder count per branch.** Return it from one call (add a per-branch breakdown to the
   existing all-branches read). Do not call `commandCentre` once per branch.
3. **Phones.** The branch table in `screens/DashV2A1-375x812-full.png` wraps its columns and is
   not acceptable. Below 640px each branch is a stacked row: name and share, the pill bar, sales
   and margin %, then one labelled line for lost sales, expiring in 30 days and khata overdue.
   The sales chart shows at most seven x-axis labels at that width; labels never overlap.
4. **Every card leads somewhere.** The four tiles are links to their report (each metric's
   `drillThrough`), with a visible focus ring. Row-3 links stay as drawn.
5. **Cash over or short with more than one branch out.** "Short at 2 branches" / "Over at 2
   branches" / "Out at 2 branches" when they differ in direction; the figure is the net.
6. **Approvals waiting.** When the count from the existing approvals read is above zero, show a
   pill in the heading row, "3 approvals waiting", linking to the approvals screen. Hidden at zero.
   It counts every approval queue, as already decided for the current dashboard.
7. **"Live" must be true.** Refetch on window focus and every five minutes. Show "Live" only while
   the figures are under ten minutes old; otherwise show "Updated 14:05" in neutral text.
8. **One branch.** A business with one branch gets no branch control and no Branches card; the
   sales chart takes the full row.
9. **Nothing yet.** No sales today: tiles show `Rs 0`, the chart sentence is "No sales yet today."
   A business under 14 days old draws only the days it has; no invented average.
10. **Amber.** Use `--warning`. Do not add a hex value. Confirm 3:1 against the card in both themes.
11. **Layout direction.** Use logical properties (start/end), never left/right, so the screen
    mirrors correctly later.
12. **Shell.** Keep the existing app shell and navigation. The prototype's header is not part of
    this work.

## Rules that already stand

- No permission keys, metric keys or "Source: ..." text anywhere staff can read.
- Without `reports:financial`: no money values, including the expiry values and the branch table.
- Owners and administrators see all branches; everyone else sees the branches they are admitted to.
- Other roles, edit mode and the preference controls keep working (handoff §6).
- No chart library. No new tables. No new colours.

## Order of work

This screen is in the same file as the open dashboard pull request (2390). Start after that one
has merged, from the new `develop`.

## Proof required

- Database tests for `dailyTrade`: day boundary in the business time zone, refund day, branch
  scope, another business refused, no `reports:financial` refused, 31 days refused.
- Component tests: branch pick and un-pick, range switch, readout on focus, restricted state,
  one-branch layout, empty day.
- Screenshots at 1440 x 900, 1024 x 768, 768 x 1024 and 375 x 812, light and dark, and the Studio
  visual QA matrix completed.
