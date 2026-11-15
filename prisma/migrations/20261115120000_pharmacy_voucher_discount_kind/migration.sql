BEGIN;

-- DEV-27: vouchers are recorded as their own discount kind so the POS can
-- refuse them on Rx, OTC drug, supplement and medical-device lines.
ALTER TYPE "PharmacyDiscountKind" ADD VALUE IF NOT EXISTS 'VOUCHER';

COMMIT;
