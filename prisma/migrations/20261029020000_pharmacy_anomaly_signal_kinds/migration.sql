-- Additive enum expansion; existing anomaly rows and their history remain intact.
ALTER TYPE "PharmacyAnomalySignalKind" ADD VALUE 'VOID_ABUSE';
ALTER TYPE "PharmacyAnomalySignalKind" ADD VALUE 'TENDER_MISMATCH';
