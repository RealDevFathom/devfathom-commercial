# Pharmacy default medicine catalogue — seed

`v1.csv.gz` is the platform default medicine catalogue, version 1: 18,933 items, gzipped
(uncompressed sha256 `5bd01d7489068e8ae678d6625c77f0c250326e957fcb6ba52d091afe64310e3d`).
It holds no patient data and no prices or stock.

## Columns

| Column                | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `sourceKey`           | Source catalogue key (`catalog-<POS alias>`), verbatim; unique within a version |
| `productName`         | Source product name, or `brandName` when the source left it empty    |
| `brandName`           | Brand as exported                                                    |
| `manufacturer`        | Manufacturer as exported                                             |
| `strength`            | Strength when the source had one (about a third of rows)             |
| `dosageForm`          | Dosage form when the source had one (about 60% of rows)              |
| `productFamily`       | `PharmacyProductFamily`, from the POS `Category` (below)             |
| `controlledCandidate` | `true` when the POS filed the item under NARCOTICS                   |

## How it was built

`scripts/pharmacy/build-default-catalogue-seed.ts` joins the app reference export
(`reference-import.csv`) to the POS item export it came from (`pos-export.csv`) on
`rowSourceKey` `catalog-<alias>` = POS `aliasname`. One reference row has no alias; it joins on
its exact, unique name instead. Text is trimmed and whitespace-collapsed. Output is sorted, so the
same inputs give a byte-identical file.

### Source keys are exact strings

POS aliases are barcode-like strings with leading zeros, so a `sourceKey` is never trimmed,
case-folded, parsed as a number or stripped of zeros — in the builder, the seed parser, the loader
or the materialiser — and the POS join compares exact strings. Compared numerically, nine groups
(21 keys) of v1 would collide; compared exactly they are different products:

| Value | Keys                                                                         |
| ----- | ---------------------------------------------------------------------------- |
| 0     | `catalog-0` LITEPLUS TAB (Wilshire), `catalog-00` DISPRIN 300MG TAB (Reckitt), `catalog-000`, `catalog-0000`, `catalog-000000` |
| 11    | `catalog-11`, `catalog-000011`                                               |
| 33324 | `catalog-33324`, `catalog-033324`                                            |
| …     | `331078600091`, `735816607241`, `745604647823`, `745604648165`, `909846321006`, `7137571699364` each with a `0`-prefixed twin |

v1 holds 18,933 unique, exact keys, every one of them the reference `rowSourceKey` verbatim; all but
`catalog-row-11419` join a POS row by exact alias. Rebuilding from the source exports reproduces the
committed file byte for byte (the sha256 above). The builder refuses a key with surrounding
whitespace and a repeated POS alias rather than repairing either. Rows are ordered numerically by
digit string (never converted to a number), keys of equal value by their exact string — ordering
only, never identity.

Only the POS `Name`, `classname` and `Category` are read. Sale/purchase prices, `QTY`,
`StockValue` and every other POS column are dropped.

| POS `Category`                                         | Family           |
| ------------------------------------------------------ | ---------------- |
| `MEDICINE`, `MEDICINE.`, `NARCOTICS`                   | `PHARMACEUTICAL` |
| `SURGICAL ITEMS`, `INSTUMERNT ITEM`, `OPTICS`, `SUGER STRIPS` | `DEVICE`  |
| `COSMETIC`, `CONSUMER`, `MILK PRODUCTS`, `PAMPERS`, `CARDS`, `DRINK` | `FRONT_SHOP` |
| anything else / no POS match                           | `PHARMACEUTICAL` |

Unknown categories fall back to `PHARMACEUTICAL` because it has the strictest saleable gate.

## NARCOTICS

1,276 rows are `controlledCandidate`: the 1,273 with POS `classname = NARCOTICS` plus 3 whose
`Category` is `NARCOTICS` (two alprazolam strengths among them). The POS bucket is not a
regulatory schedule — it also holds creams, supplements and syrups — so it is never turned into
`controlled = true`. A materialised candidate is created `saleable = false`, `controlled = false`,
and its provenance row carries `controlledCandidate = true` for pharmacist review. The hold is
enforced: such a medicine cannot be published saleable until a reviewed `controlled` assertion
records the pharmacist's decision, and that decision sets the medicine's `controlled` flag.

## Using it

Never run these against a database you have not been asked to change.

```bash
bun run pharmacy:catalogue:load                 # load v1 into the platform tables (idempotent)
bun run pharmacy:catalogue:backfill             # dry run: what each pharmacy is missing
bun run pharmacy:catalogue:backfill --apply --actor ops@example.com  # materialise into existing pharmacies
```

Each pharmacy gets its own `Medicine` copies (plus a presentation when a strength or dosage form is
known) with zero stock: no batches, lots, pack levels or prices.

### Medicines a pharmacy already entered by hand

An item is never copied when it is a likely duplicate of a medicine the pharmacy entered by hand
(manual entry, the importer wizard, a reference connector — anything without catalogue
provenance). It is a likely duplicate when all of these agree (`src/lib/pharmacy/default-catalogue-match.ts`):

- **Name**: a brand or product name of the item equals a brand or product name of the medicine,
  ignoring case, spaces and punctuation.
- **Strength**: the item's strength equals the medicine's structured strength (by value, unit
  case-insensitive), or neither has one. When only one side has a strength it still agrees if that
  strength is a whole token of the shared name (`300mg` in `DISPRIN 300MG TAB`; never `1mg` in `11mg`).
- **Dosage form**: equals one of the medicine's presentation dosage forms, or neither has one.
- **Manufacturer**, when both name one.

The dry run lists every pair under `likelyDuplicates`: the catalogue `sourceKey`, the existing
medicine id and name, the action, and the reason it matched. On `--apply` the existing medicine is
linked through a provenance row (`source = platform-default`, catalogue version, `sourceKey`,
`linkedExisting = true`) and none of its fields are written. A provenance row is one per medicine,
so a second item matching an already-linked medicine is reported as `skip` and neither created nor
linked. Re-running is stable: a linked item counts as already held, a skipped one is reported again,
nothing is created. A linked item flagged NARCOTICS carries the same review flag on its provenance
row, and because a hand-entered medicine may already sell, the link also holds it from sale
(`saleable = false`, the only field a link writes) unless a reviewed `controlled` decision was
already published for it. Publishing that decision through the reference workbench — the same
review a copy needs — releases it; until then it is listed in the workbench with the NARCOTICS
note. Each `likelyDuplicates` entry carries `controlledCandidate` and `holdFromSale`; the dry run
also reports `controlledCandidates` (copies plus links) and `wouldHoldFromSale`, and the apply
result and its audit rows report `controlledCandidates`, `linkedControlledCandidates` and
`heldFromSale`. Non-narcotic links are never held. Every copy starts
`saleable = false` — the catalogue carries no DRAP registration, which the saleable gate requires —
so a pharmacist completes an item before it can be bought or sold.

### Completing an item (the pharmacist's path)

Unsaleable copies and held NARCOTICS links are listed in the tenant's reference review workbench
(`pharmacyMedicine.referenceCandidates`): the **Default catalogue** view lists them all, 100 at a
time, searchable by product or brand name or the exact `sourceKey`; **NARCOTICS review** narrows to
the flagged ones. A status panel (`catalogueReviewSummary`) shows how many await review, how many
need a controlled decision, and how many of the pharmacy's own medicines are held from sale. None
of these reach a sale path: the counter, search, purchasing and stock keep filtering on
`saleable = true`.

For an item with nothing in review, the workbench opens a short form prefilled from the catalogue
item (or, for a held link, the pharmacy's own record): product name, strength, dosage form, pack,
DRAP registration, an optional generic name, and — for a NARCOTICS item — the controlled decision.
`draftCatalogueReview` turns it into UNREVIEWED assertions (catalogue values as `IMPORT` from
`platform-default:<key>:v<version>:<sourceKey>`, pharmacist entries as `USER`), refusing a draft
that could never publish. From there it is the ordinary review: ACCEPT (`recordReviewDecision`),
then `publishAssertions`, whose saleable gate and NARCOTICS hold are unchanged. Publishing reuses an
identical presentation, strength, barcode or alias the medicine already has — so a copy's
catalogue-created presentation is completed rather than duplicated, and a released hand-entered
medicine keeps its own records.

### Reference imports never duplicate an item

A reference connector or manual import row without a `targetMedicineId` first looks for the
catalogue medicine it describes: the medicine holding the row's `rowSourceKey` as catalogue
`sourceKey` (exact string), else the one catalogue copy with the same product name and manufacturer
(case-insensitive, whitespace collapsed; no manufacturer matches none). A match becomes the row's
target — for an unsaleable copy every regulated value is proposed, so it can be published — and
more than one candidate rejects the row as `AMBIGUOUS_CATALOGUE_MATCH`. The same match runs again
when a proposal imported before the catalogue was applied is confirmed.

### Provenance is checked against the catalogue

Tenants insert their own provenance rows (the apply runs in the tenant's scope), so a trigger
(`pharmacy_validate_catalogue_provenance`) checks every insert: `catalogueKey` and
`catalogueVersion` must equal the version `catalogueVersionId` names, the version must hold the
`sourceKey`, and a NARCOTICS item is never recorded without `controlledCandidate`.

New pharmacies queue a `pharmacy.default-catalogue.v1` platform job when they are created. Status
and retry live under Platform → Jobs → Pharmacy default catalogue, which lists every pharmacy with
server-side pagination (`?page=<n>&pageSize=<1-200>`, default 50, ordered by name then id, with
the total count and previous/next controls).

To publish a new version, rebuild the seed as `v2.csv.gz` and load it with `--version 2`. Applying
it adds only items a pharmacy does not hold yet; items it already holds are never overwritten, and
changed ones are reported in the job result.
