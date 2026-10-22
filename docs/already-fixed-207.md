# GitHub issue #207 is already fixed

Verified against the current code on 2026-10-22. No production or test code was
changed for this issue because the reported goods-in copy is already corrected:

- `src/lib/pharmacy/pack-conversion.ts:101-105` collapses a terminal `UNIT`
  conversion of one canonical unit to `1 unit` instead of rendering an equation.
- `src/lib/pharmacy/purchasing-console.ts:246-252` applies the same `1 unit`
  label to medicine options shown under **Packs for receiving**.
- `src/app/(app)/pharmacy/purchasing/receiving/page.tsx:1002-1009` renders a
  one-unit pack conversion as `1 unit` on the goods-in capture fieldset.
- `src/lib/pharmacy/pack-conversion.test.ts:131-140` provides focused regression
  coverage for the terminal `UNIT` label and singular/plural canonical-unit copy.

Together, these paths cover both places from the report: the medicine option and
the selected goods-in line. The obsolete `1 UNIT = 1 units` output is not emitted
for a pack chain ending in a single `UNIT`.
