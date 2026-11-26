# Import a prepared Abuzar export

Use the pharmacy's own computer for preparation. The input is a directory containing five UTF-8 CSV files plus a manifest. Use stable source identifiers for repeat exports. Preserve leading zeros and quote commas, newlines and double quotes using CSV conventions. Supply a header even when a table is empty.

| File         | Header, in order                                                       |
| ------------ | ---------------------------------------------------------------------- |
| products.csv | ICode,CustomICode,Name,PackUnits,Class,Shelf,SalePrice,PurPrice,Active |
| parties.csv  | RowID,Kind,Name,Phone                                                  |
| stock.csv    | RowID,Branch,ICode,Quantity,Batch,Expiry                               |
| balances.csv | RowID,Branch,PartyID,Amount                                            |
| history.csv  | RowID,Branch,Kind,DocumentNo,Date,ICode,Quantity,UnitPrice,Amount      |

- Use the original ICode and pharmacy's legacy code. Active is 1 or 0. Retain the original NARCOTICS class. PackUnits is the number of individual units in a full pack.
- SalePrice and PurPrice in the **prepared products file** are PKR per full pack. Convert any per-unit source price to a pack amount using the verified pack size during preparation. History UnitPrice stays in PKR per individual unit. Keep missing prices blank.
- Stock Quantity is a count of single units. Keep unresolved source values so the report can identify them. Give each stock line a stable RowID. Use ISO dates. The import holds an unverified batch for correction and omits the placeholder expiry from the batch.
- Party kinds are customer and supplier. Each balance refers to the corresponding party RowID. Positive customer amounts are receivable, positive supplier amounts are payable. A negative amount is a credit in the opposite direction. Use decimal PKR amounts with up to two fractional digits.
- History kinds include sale, purchase, sale-return, purchase-return, purchase-order, adjustment, movement and accounting. DocumentNo is the original reference. Do not include medical notes or contact details in document identifiers.

Set `manifest.json` version to `abuzar/2` and sourceFingerprint to a lowercase SHA-256 covering the source snapshot. Under `tables`, use the five filename stems as keys. For each, supply the integer data row count in `rows` and the SHA-256 of the exact CSV file bytes in `sha256`. A quoted multiline field is part of one row. The local preflight command reads these six files and prints a report without a database connection.

```sh
bun tools/abuzar-import/inspect.ts /path/to/prepared-directory
```

In the pharmacy workspace open **Inventory → Import opening stock → Import a prepared Abuzar export**. Select all six files, the source branch code and the matching destination branch. Preview each step and confirm the displayed totals. Reports express amounts in paisa. Complete the staged catalogue review with the independent pharmacist before applying prices. Continue with parties, prices, opening stock, party balances and history. For opening entries choose the owner's cut-over date in an open period. For stock choose the destination location and provide independent pharmacist approval for controlled stock. Only the owner can select add to existing when the pharmacy has posted sales.

Repeat the preview after correcting an exception. Download the reconciliation for each source and destination branch pair, and review every row difference. Use the document search to read imported history. Keep reports under the pharmacy's control.

The web upload must fit the existing 4 MiB request limit after browser compression, including multipart overhead. The local inspector accepts at most 64 MiB per CSV, 96 MiB for the CSV files together, and 500,000 data rows per table. Validate packaging and the source-column conversion on the owner's Mac before cut-over.
