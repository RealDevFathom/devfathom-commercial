# DevFathom UX: POS redesign and terminal audit

Owner: UX consultant · Issue: WHA-1574 · Baseline: `d9957a9a` · Status: proposed, for board review

These documents extend, and never override, `docs/design-system/DEVFATHOM-STUDIO.md` (the design
contract). Where the POS needs an exception (full-bleed terminal, 56px top bar), the spec
requests a contract change to land with POS-UX-2.

| Doc                                                                    | What it is                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01-heuristic-audit.md](01-heuristic-audit.md)                         | Nielsen heuristic audit plus cashier task analysis (taps to first item, taps to payment, error recovery, offline cues). Covers the restaurant POS, KDS, drawer/day close, inventory receiving (restaurant and pharmacy) and the pharmacy counter. 57 surface findings plus 6 cross-cutting, each with severity and `file:line` evidence |
| [02-pos-single-screen-spec.md](02-pos-single-screen-spec.md)           | Single-screen restaurant POS benchmarked on the reference café POS. Covers the layout grid and breakpoints, component keep-vs-new inventory, interaction states, keyboard/tablet ergonomics, design tokens, and API dependencies / owner decisions                                                                                      |
| [03-pos-ux-acceptance-criteria.md](03-pos-ux-acceptance-criteria.md)   | Acceptance criteria for POS-UX-1..6, including the e2e selector migration contract                                                                                                                                                                                                                                                      |
| [04-pharmacy-counter-principles.md](04-pharmacy-counter-principles.md) | One-page principles and targets for the pharmacy dispensing counter lane                                                                                                                                                                                                                                                                |
| [05-super-admin-principles.md](05-super-admin-principles.md)           | One-page principles and targets for the platform / super-admin lane                                                                                                                                                                                                                                                                     |

## UX-02 (WHA-1583): counter flows, platform console, offline language

Baseline `13af3d1e`. These build on docs 01–05 and don't change them, except that `08` supersedes
the offline banner copy in `02` §5 (POS-UX-5 picks it up).

| Doc                                                                    | What it is                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [06-pharmacy-counter-flows-spec.md](06-pharmacy-counter-flows-spec.md) | Counter return/refund, cash drawer, close drawer, close day, prescription capture (photo) and the controlled-register prompt. Pack-level (box/strip/tablet) quantities, Urdu aliases, FEFO batches, Rx and controlled gating. API gaps P-API-1..15, decisions D-P1..10 |
| [07-super-admin-console-ia.md](07-super-admin-console-ia.md)           | One console for agencies, pharmacies and restaurants: nav IA, vertical scope, role visibility, and screens for tenants, entitlements, people, billing, audit, health, support sessions, feature flags and announcements. Maps to SA-01..SA-12 (WHA-1578)               |
| [08-offline-state-language.md](08-offline-state-language.md)           | Shared connection states (online / degraded / offline / syncing / conflict) for POS, KDS and counter: words (English + Urdu drafts), detection timing, what works offline per terminal, and one Pending status vocabulary for held orders and pending tenders          |
| [09-ux02-acceptance-criteria.md](09-ux02-acceptance-criteria.md)       | Acceptance criteria for PHC-UX-1..6, PHC-API-A..E, SA-UX-1..11, OFF-UX-1..4 and OFF-API-1                                                                                                                                                                              |

Suggested order: OFF-UX-1 → OFF-UX-4a (the counter gets a visible state) → PHC-UX-1 → PHC-UX-2 →
PHC-UX-4 → PHC-UX-5 → PHC-UX-3 → PHC-UX-6. Platform: SA-04..SA-07 (security, WHA-1578) first,
then SA-UX-1 → SA-UX-3 → SA-UX-4, then the rest in any order. OFF-UX-4b waits for OFF-API-1.

## Headline numbers (restaurant POS)

| Metric                               | Today                             | Target                          |
| ------------------------------------ | --------------------------------- | ------------------------------- |
| Page scroll at 1024×768              | Yes (five stacked cards)          | None; columns scroll internally |
| Taps to first item                   | 2 + scroll                        | 1                               |
| Taps to a settled takeaway cash sale | 7 + 1–2 scrolls                   | 3                               |
| Typed fields in the common sale path | qty/course/seat + 2 tender fields | 0                               |

## Suggested order of work

1. POS-UX-1: extract the hook, per-intent pending. No visible change.
2. POS-UX-2: frame, rail, table sheet, Register menu, PIN pad, contract Terminal recipe.
3. POS-UX-3: catalog, search, one-tap tiles, modifier dialog.
4. POS-UX-4: cart column, pinned totals, Pay/Send, checkout fast path, quick tender.
5. POS-UX-5: draft on first tap, held orders, offline banner.
6. POS-UX-6: customer strip, delivery sheet, e2e selector migration, dead-code removal.

POS-UX-3 and POS-UX-4 can run in parallel once POS-UX-2 lands.

Pending owner decisions: D-3, D-4 and D-5, and API-1..3 plus Q2 (spec §9).
