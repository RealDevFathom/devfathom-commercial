# Healthwire collection gate

Status recorded 2026-09-02 (Asia/Karachi): the owner states that Healthwire permission was purchased, but no permission reference, licensed account scope, allowed URL pattern, or retention terms are present in this checkout.

## Collection status

- Bulk requests: `0`
- Raw fetch artifacts: none
- Normalized catalog rows: `0`
- Failed URLs: none (no requests were made)
- Personal data collected: none
- Stop condition: collection remains paused until the owner supplies a permission reference and explicit source scope.

Healthwire is treated only as a commercial catalog source. DRAP remains the regulatory reference. No registration, legality, completeness, medical, or clinical claim is inferred from an unavailable source.

## Existing schema/readiness evidence

The current pharmacy schema keeps raw/provenance assertions separate from canonical medicine rows through `pharmacy_medicine_provenance`, with `sourceType`, `source`, `retrievedAt`, `confidence`, `reviewer`, `status`, and `assertedValue`. Canonical rows are held in `pharmacy_medicines`; duplicate review decisions and publication batches are separate append-only surfaces.

Existing deterministic normalization and validation evidence:

- `normalizeMedicineText` folds case, whitespace, and punctuation while preserving Urdu letters.
- `medicineDuplicateKey` groups exact normalized product name + strength + dosage form and does not fuzzy-merge near names.
- Regulated medicines cannot become saleable without presentation, strength, registration, and accepted/corrected DRAP registration provenance.
- `tests/pharmacy-medicine-rls.test.ts` covers tenant isolation, barcode uniqueness, regulator-provenance precedence, append-only review decisions, supersession rollback, and a 20,000-row search fixture.

## Reproducibility commands

```text
git reset --hard 76faf6a1
git rev-parse HEAD
cp -Rc /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1116-compose-the-final-accepted-restaurant-artifacts-into-one-clean-private-candidate/node_modules ./node_modules
bunx prisma generate
bunx vitest run src/lib/pharmacy/medicine.test.ts
```

Observed results: `HEAD=76faf6a142b83325cad10dd1722cc3cb35fa0f96`; Prisma Client generated successfully; catalog test file passed with `11 passed`.
