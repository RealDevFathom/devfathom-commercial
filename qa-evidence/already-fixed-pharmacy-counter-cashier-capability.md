# Already fixed: pharmacy counter Cashier capability

## Disposition

The reported authorization mismatch does **not** reproduce at `16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca`.
No production or test code change is required.

The fix is already present in commit `2ee391bd31b90fbead408843f8c26f24892f6143`
(`fix(pharmacy): let canonical cashiers read and settle counter bills`), which is an ancestor of the
reviewed revision.

## Static evidence

- The Cashier template grants the canonical colon-form capability, `pharmacy:counter`
  (`src/lib/vertical-catalog.ts:792-795`).
- The shared receipt gate's accepted actions include both canonical `pharmacy:counter` and legacy
  `pharmacy.counter` (`src/server/routers/pharmacy-sales.ts:275-283`). The gate evaluates role and
  override rules against every accepted action (`src/server/routers/pharmacy-sales.ts:350-357`).
- Cart, non-Khata/non-credit tender, receipt, and return-history operations all call that shared gate
  (`src/server/routers/pharmacy-sales.ts:712-723`, `src/server/routers/pharmacy-sales.ts:1250-1257`,
  `src/server/routers/pharmacy-sales.ts:1577-1586`, and
  `src/server/routers/pharmacy-sales.ts:1595-1604`).
- A focused regression test grants the canonical `pharmacy:counter` value and exercises receipt,
  cart, return history, and both cash and card tender successfully
  (`src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:305-336`). The preceding test
  separately preserves coverage for the legacy dotted grant
  (`src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:275-303`).

## Verification performed

Static inspection only, as requested. No dependencies were installed and no test, build, database,
or package-manager command was run in the constrained Bun 1.2.14 / no-database / npm-403
environment.

Commands used for the inspection:

```text
rg -n "pharmacy[:.]counter|counter receipt|counter-receipt" --glob '!node_modules' .
sed -n '245,370p' src/server/routers/pharmacy-sales.ts
sed -n '250,335p' src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts
sed -n '770,810p' src/lib/vertical-catalog.ts
rg -n "requireCounterReceiptAccess|counterReceipt:|counterCart:|returnHistory:|tender:" src/server/routers/pharmacy-sales.ts
git log --oneline --all -- src/server/routers/pharmacy-sales.ts src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts
git show --stat --oneline 2ee391b
```
