import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { normalizeKhataPhone } from '../family-khata';
import type { Row } from '../../../../tools/abuzar-import/prepared';

type Decision<T> = { index: number; row: T; hash: string; reason: string | null };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const nameKey = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
type Scope = { organizationId: string; branchId: string };
function contactKeys(kind: string, name: string, phone: string) {
  return [
    kind + ' name ' + nameKey(name),
    ...(phone ? [kind + ' phone ' + normalizeKhataPhone(phone)] : []),
  ];
}
export async function planParties(db: ScopedDb, { organizationId }: Scope, rows: Row<'parties'>[]) {
  const imported = await db.$queryRaw<
    { sourceId: string; rowHash: string }[]
  >`SELECT "sourceId","rowHash" FROM pharmacy_abuzar_parties WHERE "organizationId"=${organizationId}`;
  const prior = new Map(imported.map((p) => [p.sourceId, p.rowHash]));
  const local = new Set<string>(),
    counts = new Map<string, number>();
  const suppliers = await db.pharmacySupplier.findMany({
    where: { organizationId },
    select: { name: true, contactPhone: true },
  });
  const customers = await db.pharmacyPatient.findMany({
    where: { organizationId },
    select: { displayName: true, phone: true },
  });
  for (const p of suppliers)
    for (const k of contactKeys('supplier', p.name, p.contactPhone ?? '')) local.add(k);
  for (const p of customers)
    for (const k of contactKeys('customer', p.displayName, p.phone ?? '')) local.add(k);
  for (const p of rows)
    for (const k of contactKeys(p.Kind, p.Name, p.Phone)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return rows.map((row, index): Decision<Row<'parties'>> => {
    const hash = digest(row),
      old = prior.get(row.RowID);
    let reason: string | null = null;
    if (old) reason = old === hash ? 'already imported' : 'source identity changed';
    else if (!row.Name || !['customer', 'supplier'].includes(row.Kind))
      reason = 'missing name or unknown party type';
    else if (row.Phone && !/^\+?\d{6,15}$/.test(normalizeKhataPhone(row.Phone)))
      reason = 'invalid phone';
    else if (
      contactKeys(row.Kind, row.Name, row.Phone).some((k) => local.has(k) || counts.get(k)! > 1)
    )
      reason = 'duplicate contact for review';
    return { index: index + 2, row, hash, reason };
  });
}

export async function appendParties(
  db: ScopedDb,
  { organizationId }: Scope,
  decisions: Awaited<ReturnType<typeof planParties>>
) {
  const patients = [],
    customers = [],
    suppliers = [];
  const links: {
    sourceId: string;
    customerId: string | null;
    supplierId: string | null;
    rowHash: string;
  }[] = [];
  for (const { row, hash, reason } of decisions) {
    if (reason) continue;
    const phone = row.Phone ? normalizeKhataPhone(row.Phone) : null;
    const id = randomUUID();
    if (row.Kind === 'customer') {
      const patientId = randomUUID();
      patients.push({ id: patientId, organizationId, displayName: row.Name, phone });
      customers.push({
        id,
        organizationId,
        patientId,
        displayName: row.Name,
        phoneLast4: phone?.slice(-4) ?? null,
      });
    } else suppliers.push({ id, organizationId, name: row.Name, contactPhone: phone });
    links.push({
      sourceId: row.RowID,
      customerId: row.Kind === 'customer' ? id : null,
      supplierId: row.Kind === 'supplier' ? id : null,
      rowHash: hash,
    });
  }
  await db.pharmacyPatient.createMany({ data: patients });
  await db.pharmacyCustomer.createMany({ data: customers });
  await db.pharmacySupplier.createMany({ data: suppliers });
  await db.$executeRaw`INSERT INTO pharmacy_abuzar_parties SELECT ${organizationId},r."sourceId",r."customerId",r."supplierId",r."rowHash" FROM jsonb_to_recordset(${JSON.stringify(links)}::jsonb) AS r("sourceId" text,"customerId" text,"supplierId" text,"rowHash" text)`;
}

const historyKinds = new Set([
  'sale',
  'purchase',
  'sale-return',
  'purchase-return',
  'purchase-order',
  'adjustment',
  'movement',
  'accounting',
]);
export async function planHistory(
  db: ScopedDb,
  scope: Scope,
  sourceBranch: string,
  rows: Row<'history'>[]
) {
  const imported = await db.$queryRaw<
    { sourceId: string; branchId: string; rowHash: string }[]
  >`SELECT "sourceId","rowHash","branchId" FROM pharmacy_abuzar_history WHERE "organizationId"=${scope.organizationId} AND "sourceBranch"=${sourceBranch}`;
  const prior = new Map(imported.map((h) => [h.sourceId, h]));
  return rows.map((row, index): Decision<Row<'history'>> => {
    const hash = digest(row),
      old = prior.get(row.RowID);
    const date = new Date(row.Date + 'T00:00:00Z');
    let reason: string | null = null;
    if (row.Branch !== sourceBranch) reason = 'other source branch';
    else if (old)
      reason =
        old.rowHash === hash && old.branchId === scope.branchId
          ? 'already imported'
          : 'source identity or branch changed';
    else if (!historyKinds.has(row.Kind) || !row.DocumentNo) reason = 'invalid history document';
    else if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== row.Date)
      reason = 'invalid document date';
    return { row, index: index + 2, hash, reason };
  });
}
export async function appendHistory(
  db: ScopedDb,
  scope: Scope,
  decisions: Awaited<ReturnType<typeof planHistory>>
) {
  for (let start = 0; start < decisions.length; start += 1000) {
    const batch = decisions
      .slice(start, start + 1000)
      .filter((d) => !d.reason)
      .map((d) => ({ ...d.row, hash: d.hash }));
    if (!batch.length) continue;
    await db.$executeRaw`INSERT INTO pharmacy_abuzar_history ("organizationId","branchId","sourceBranch","sourceId",kind,"documentNo","documentDate","productCode",quantity,"unitPrice",amount,"rowHash")
      SELECT ${scope.organizationId},${scope.branchId},r."Branch",r."RowID",r."Kind",r."DocumentNo",r."Date"::date,NULLIF(r."ICode",''),NULLIF(r."Quantity",''),NULLIF(r."UnitPrice",''),NULLIF(r."Amount",''),r.hash
      FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS r("Branch" text,"RowID" text,"Kind" text,"DocumentNo" text,"Date" text,"ICode" text,"Quantity" text,"UnitPrice" text,"Amount" text,hash text)`;
  }
}
