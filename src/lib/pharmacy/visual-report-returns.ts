import { Prisma } from '@/generated/prisma/client';

/** Both identified lots and packs held in quarantine are physical returns against a known sale line. */
export const physicalReturnLines = Prisma.sql`
  SELECT sr."branchId",sr."createdAt" AS at,sr.reason,r.id,r.units,r.source,l."medicineId",m."productName"
  FROM bounds b JOIN pharmacy_sale_returns sr ON sr."organizationId"=current_setting('app.current_organization_id',true)
    AND sr."branchId"=b.id AND sr."createdAt">=b.start_at AND sr."createdAt"<b.stop_at
  JOIN LATERAL (
    SELECT id,"saleLineId","canonicalUnits" AS units,'PHARMACY_SALE_RETURN_LINE'::"FinanceSourceKind" AS source
    FROM pharmacy_sale_return_lines WHERE "organizationId"=sr."organizationId" AND "branchId"=sr."branchId" AND "returnId"=sr.id
    UNION ALL
    SELECT id,"saleLineId","canonicalUnits",'PHARMACY_UNIDENTIFIED_RETURN_HOLD'::"FinanceSourceKind"
    FROM pharmacy_unidentified_return_holds WHERE "organizationId"=sr."organizationId" AND "branchId"=sr."branchId" AND "returnId"=sr.id
  ) r ON TRUE
  JOIN pharmacy_sale_lines l ON l."organizationId"=sr."organizationId" AND l."branchId"=sr."branchId" AND l.id=r."saleLineId"
  JOIN pharmacy_medicines m ON m."organizationId"=l."organizationId" AND m.id=l."medicineId"`;
