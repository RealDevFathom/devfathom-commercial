import { Prisma } from '@/generated/prisma/client';

/** The completed sale line and applied tender measures used by Pharmacy Reports. */
export const reportSaleLineMinor = Prisma.sql`l."grossMinor" - l."discountMinor"`;
export const reportTenderTotal = Prisma.sql`SUM(t."amountMinor")`;
export const reportSaleLineJoin = Prisma.sql`s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s."id"=l."saleId"`;
