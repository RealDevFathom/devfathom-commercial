# Pharmacy default medicine catalogue — seed

`v1.csv.gz` is the platform default medicine catalogue, version 1: 18,933 items, gzipped
(uncompressed sha256 `5bd01d7489068e8ae678d6625c77f0c250326e957fcb6ba52d091afe64310e3d`).
It holds no patient data and no prices or stock.

## Columns

| Column                | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `sourceKey`           | Source catalogue key (`catalog-<POS alias>`); unique within a version |
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
known) with zero stock: no batches, lots, pack levels or prices. Every copy starts
`saleable = false` — the catalogue carries no DRAP registration, which the saleable gate requires —
so a pharmacist completes an item before it can be bought or sold.

New pharmacies queue a `pharmacy.default-catalogue.v1` platform job when they are created. Status
and retry live under Platform → Jobs → Pharmacy default catalogue.

To publish a new version, rebuild the seed as `v2.csv.gz` and load it with `--version 2`. Applying
it adds only items a pharmacy does not hold yet; items it already holds are never overwritten, and
changed ones are reported in the job result.
