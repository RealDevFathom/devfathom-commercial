# pharmacy-catalog-v1.json.gz

Preloaded medicine catalog for new pharmacy tenants (version `pharmacy-catalog-v1`, 18,924 items).
Private: never publish, log item contents, or paste into PRs/issues beyond counts.
Fields: name, alias (legacy item code, NOT a barcode), active, packUnits, packQty, class (generic only), category,
defaultSalePriceMinor / defaultPurchasePriceMinor (integer paisa; null when unknown; only applied when the owner enables
"use catalog default prices", off by default). Generic/salt, manufacturer, barcode intentionally blank.
NOT included from the source export: stock quantity, stock value, unit price, supplier/distributor names (source column 8
and distributor-named classes) — those are the source pharmacy's private data. Every tenant starts at zero stock.
NARCOTICS/FRIDGE classes are hints only; they set no controlled/cold-chain flag without pharmacist catalogue review.
