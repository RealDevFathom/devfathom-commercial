import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { emitUniversityEvent, recordEventReceipt } from './events';
import {
  officeRoleAllowed,
  type UniversityContext,
  type UniversityField,
  type UniversityOffice,
} from './office-types';

const feeHeads = [
  'TUITION',
  'ADMISSION',
  'APPLICATION',
  'EXAM',
  'LIBRARY',
  'TRANSPORT',
  'LAB',
  'UTILITIES',
  'SPORTS',
  'DEPOSIT',
  'HOSTEL',
  'OTHER',
] as const;
type FeeHead = (typeof feeHeads)[number] | 'OPENING';
type FormInput = Record<string, string>;
const bursar = ['university-bursar'];
const approver = ['university-finance-approver'];
const staff = [...bursar, ...approver];
const maxPaisa = 999_999_999_999;
const AR = 'STUDENT_RECEIVABLE';
const BANK = 'BANK_CLEARING';

function required(value: unknown, label: string, limit = 100) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > limit ||
    /[\u0000-\u001f]/u.test(value.trim())
  ) {
    throw new Error(`Enter a valid ${label} (up to ${limit} characters).`);
  }
  return value.trim();
}

function date(value: unknown) {
  const input = required(value, 'date', 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input) ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString().slice(0, 10) !== input
  )
    throw new Error('Use a valid YYYY-MM-DD date.');
  return input;
}
export function parsePkr(value: unknown) {
  const input = required(value, 'PKR amount', 20);
  if (!/^\d+(?:\.\d{1,2})?$/.test(input))
    throw new Error('Enter a PKR amount with up to two decimal places.');
  const [rupees, fraction = ''] = input.split('.');
  const amount = Number(rupees) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > maxPaisa)
    throw new Error('PKR amount exceeds the supported limit.');
  return amount;
}
function positive(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > maxPaisa)
    throw new Error('Amount in paisa must be positive and within range.');
  return amount;
}
function assertRole(ctx: UniversityContext, roles: string[]) {
  if (!officeRoleAllowed(ctx, roles))
    throw new Error('Your finance role does not permit this action.');
}
function key(...parts: string[]) {
  return parts.map(encodeURIComponent).join('/');
}
async function lock(ctx: UniversityContext, resource: string) {
  await ctx.db
    .$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtextextended(${key(ctx.organizationId, 'finance', resource)},0))`;
}

export type StudentCharge = {
  personId: string;
  reference: string;
  feeHead: string;
  amountPaisa: number;
  commencementDate: string;
  dueDate: string;
};
type Account = StudentCharge & {
  currency: 'PKR';
  balancePaisa: number;
  paidPaisa: number;
  scholarshipPaisa: number;
  refundPaisa: number;
  bankName: string | null;
  beneficiary: string | null;
  iban: string | null;
  feeHead: FeeHead;
};
type Posting = {
  entryKey: string;
  reference: string;
  kind: string;
  debit: string;
  credit: string;
  amount: number;
  reason: string;
  reversalOf?: string;
};

async function post(ctx: UniversityContext, p: Posting) {
  const [existing] = await ctx.db.$queryRaw<{ same: boolean }[]>`
    SELECT (reference=${p.reference} AND kind=${p.kind} AND debit_account=${p.debit} AND credit_account=${p.credit}
            AND amount_paisa=${p.amount} AND reason=${p.reason} AND reversal_of IS NOT DISTINCT FROM ${p.reversalOf ?? null}) AS same
      FROM university_finance_entries WHERE organization_id=${ctx.organizationId} AND entry_key=${p.entryKey}`;
  if (existing) {
    if (!existing.same)
      throw new Error('Posting reference is already used for a different transaction.');
    return;
  }
  // Share this period lock with concurrent posters. The close action takes it exclusively.
  // Use the database transaction clock, including a transaction that spans Pakistan midnight.
  await ctx.db.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock_shared(
    hashtextextended(${key(ctx.organizationId, 'finance', 'close/')} || to_char(now() AT TIME ZONE 'Asia/Karachi','YYYY-MM'),0))`;
  await ctx.db.$executeRaw`
    INSERT INTO university_finance_entries (organization_id,entry_key,reference,kind,debit_account,credit_account,amount_paisa,actor_id,reason,reversal_of)
    VALUES (${ctx.organizationId},${p.entryKey},${p.reference},${p.kind},${p.debit},${p.credit},${positive(p.amount)},${ctx.userId},${p.reason},${p.reversalOf ?? null})`;
  await emitUniversityEvent(ctx, 'finance.posted', p.entryKey, {
    entryKey: p.entryKey,
    challan: p.reference,
    kind: p.kind,
    debitAccount: p.debit,
    creditAccount: p.credit,
    amountPaisa: p.amount,
    currency: 'PKR',
    reversalOf: p.reversalOf ?? null,
  });
}

/** Caller authorizes the academic/service charge and supplies its stable source reference. */
export async function issueStudentCharge(ctx: UniversityContext, raw: StudentCharge) {
  const reference = required(raw.reference, 'challan reference');
  const personId = required(raw.personId, 'person ID');
  const amount = positive(raw.amountPaisa);
  const feeHead = required(raw.feeHead, 'fee head');
  if (!(feeHeads as readonly string[]).includes(feeHead)) throw new Error('Unknown fee head.');
  const start = date(raw.commencementDate),
    due = date(raw.dueDate);
  await lock(ctx, key('challan', reference));
  const inserted = await ctx.db.$executeRaw`
    INSERT INTO university_challans (organization_id,reference,person_id,fee_head,amount_paisa,commencement_date,due_date)
    VALUES (${ctx.organizationId},${reference},${personId},${feeHead},${amount},${start}::date,${due}::date)
    ON CONFLICT (organization_id,reference) DO NOTHING`;
  if (!inserted) {
    const [row] = await ctx.db.$queryRaw<{ same: boolean }[]>`
      SELECT person_id=${personId} AND fee_head=${feeHead} AND amount_paisa=${amount} AND commencement_date=${start}::date AND due_date=${due}::date AS same
      FROM university_challans WHERE organization_id=${ctx.organizationId} AND reference=${reference}`;
    if (!row?.same) throw new Error('Challan reference is already used.');
    return { reference };
  }
  await post(ctx, {
    entryKey: key('charge', reference),
    reference,
    kind: 'CHARGE',
    debit: AR,
    credit: `FEES_${feeHead}`,
    amount,
    reason: 'Fee assessment',
  });
  return { reference };
}

type StudentOpeningBalance = {
  personId: string;
  reference: string;
  balancePaisa: number;
  asOf: string;
  evidence: string;
};
/** Migration caller verifies the signed source trial balance and authorizes the cutover. */
export async function importStudentOpeningBalance(
  ctx: UniversityContext,
  raw: StudentOpeningBalance
) {
  const reference = required(raw.reference, 'legacy balance reference'),
    personId = required(raw.personId, 'student ID'),
    asOf = date(raw.asOf);
  const reason = required(raw.evidence, 'migration evidence reference', 300);
  if (raw.balancePaisa === 0) return { reference, posted: false };
  const amount = positive(Math.abs(raw.balancePaisa)),
    debt = raw.balancePaisa > 0;
  await lock(ctx, key('challan', reference));
  await ctx.db
    .$executeRaw`INSERT INTO university_challans (organization_id,reference,person_id,fee_head,amount_paisa,commencement_date,due_date)
    VALUES (${ctx.organizationId},${reference},${personId},'OPENING',${amount},${asOf}::date,${asOf}::date) ON CONFLICT DO NOTHING`;
  const [same] = await ctx.db.$queryRaw<
    { ok: boolean }[]
  >`SELECT fee_head='OPENING' AND person_id=${personId} AND amount_paisa=${amount} AND commencement_date=${asOf}::date AS ok
      FROM university_challans WHERE organization_id=${ctx.organizationId} AND reference=${reference}`;
  if (!same?.ok) throw new Error('Legacy opening reference belongs to another balance.');
  await post(ctx, {
    entryKey: key('opening', reference),
    reference,
    kind: debt ? 'OPENING_DEBIT' : 'OPENING_CREDIT',
    debit: debt ? AR : 'OPENING_BALANCE_CONTROL',
    credit: debt ? 'OPENING_BALANCE_CONTROL' : AR,
    amount,
    reason: asOf + ' · ' + reason,
  });
  return { reference, posted: true, balancePaisa: raw.balancePaisa };
}

async function applyOpeningCredit(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, approver);
  const source = required(input.reference, 'legacy credit reference'),
    target = required(input.target, 'destination challan');
  if (source === target) throw new Error('Choose a different destination challan.');
  for (const ref of [source, target].sort()) await lock(ctx, key('challan', ref));
  const [from] = await accounts(ctx.db, ctx.organizationId, null, source),
    [to] = await accounts(ctx.db, ctx.organizationId, null, target);
  if (
    !from ||
    !to ||
    from.feeHead !== 'OPENING' ||
    to.feeHead === 'OPENING' ||
    from.personId !== to.personId
  )
    throw new Error('Choose a legacy credit and challan for the same student.');
  const amount = positive(parsePkr(input.amount)),
    reason = required(input.evidence, 'allocation evidence', 300),
    tag = key('opening-allocation', required(input.transferId, 'allocation reference'));
  const [existing] = await ctx.db.$queryRaw<
    { id: string }[]
  >`SELECT entry_key AS id FROM university_finance_entries WHERE organization_id=${ctx.organizationId} AND entry_key=${tag + '/source'}`;
  if (!existing && (amount > -from.balancePaisa || amount > to.balancePaisa))
    throw new Error('Allocation exceeds the available opening credit or destination debt.');
  await post(ctx, {
    entryKey: tag + '/source',
    reference: source,
    kind: 'OPENING_ALLOCATED',
    debit: AR,
    credit: 'FEE_TRANSFER_CLEARING',
    amount,
    reason,
  });
  await post(ctx, {
    entryKey: tag + '/destination',
    reference: target,
    kind: 'OPENING_APPLIED',
    debit: 'FEE_TRANSFER_CLEARING',
    credit: AR,
    amount,
    reason,
  });
  return { source, target, amountPaisa: amount };
}

async function accounts(
  db: ScopedDb,
  organizationId: string,
  personId: string | null,
  reference: string | null
) {
  return db.$queryRaw<Account[]>`
    SELECT c.person_id AS "personId", c.reference, c.fee_head AS "feeHead",c.amount_paisa::float8 AS "amountPaisa",
      bank.bank_name AS "bankName", bank.beneficiary,bank.iban,c.commencement_date::text AS "commencementDate", c.due_date::text AS "dueDate", 'PKR' AS currency,
      COALESCE(SUM(CASE WHEN e.debit_account='STUDENT_RECEIVABLE' THEN e.amount_paisa WHEN e.credit_account='STUDENT_RECEIVABLE' THEN -e.amount_paisa ELSE 0 END),0)::float8 AS "balancePaisa",
      COALESCE(SUM(CASE WHEN e.kind IN ('PAYMENT','TRANSFER_IN','OPENING_APPLIED') THEN e.amount_paisa WHEN e.kind='TRANSFER_OUT' OR orig.kind='PAYMENT' THEN -e.amount_paisa ELSE 0 END),0)::float8 AS "paidPaisa",
      COALESCE(SUM(CASE WHEN e.kind='SCHOLARSHIP' THEN e.amount_paisa WHEN orig.kind='SCHOLARSHIP' THEN -e.amount_paisa ELSE 0 END),0)::float8 AS "scholarshipPaisa",
      COALESCE(SUM(CASE WHEN e.kind='REFUND_PAID' THEN e.amount_paisa ELSE 0 END),0)::float8 AS "refundPaisa"
    FROM university_challans c LEFT JOIN university_fee_collection_accounts bank ON bank.organization_id=c.organization_id
    LEFT JOIN university_finance_entries e ON e.organization_id=c.organization_id AND e.reference=c.reference
    LEFT JOIN university_finance_entries orig ON orig.organization_id=e.organization_id AND orig.entry_key=e.reversal_of
    WHERE c.organization_id=${organizationId} AND (${personId}::text IS NULL OR c.person_id=${personId})
      AND (${reference}::text IS NULL OR c.reference=${reference})
    GROUP BY c.organization_id,c.reference,bank.organization_id ORDER BY c.due_date DESC,c.reference`;
}

export function readStudentFinance(db: ScopedDb, organizationId: string, personId: string) {
  return accounts(db, organizationId, required(personId, 'student ID'), null);
}
async function lockedAccount(ctx: UniversityContext, raw: unknown) {
  const reference = required(raw, 'challan reference');
  await lock(ctx, key('challan', reference));
  const [account] = await accounts(ctx.db, ctx.organizationId, null, reference);
  if (!account) throw new Error('Challan was not found.');
  return account;
}

async function awardScholarship(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, bursar);
  const account = await lockedAccount(ctx, input.reference),
    amount = positive(parsePkr(input.amount));
  const ref = required(input.award, 'scholarship or sponsor award reference');
  const entryKey = key('scholarship', account.reference, ref);
  const [existing] = await ctx.db.$queryRaw<
    { entry_key: string }[]
  >`SELECT entry_key FROM university_finance_entries WHERE organization_id=${ctx.organizationId} AND entry_key=${entryKey}`;
  if (!existing && amount > account.balancePaisa)
    throw new Error('Award exceeds the unpaid challan balance.');
  await post(ctx, {
    entryKey,
    reference: account.reference,
    kind: 'SCHOLARSHIP',
    debit: 'SCHOLARSHIPS',
    credit: AR,
    amount,
    reason: ref,
  });
  return { entryKey };
}

type BankRow = {
  provider: string;
  transactionId: string;
  reference: string;
  amountPaisa: number;
  valueDate: string;
};
export async function ingestUniversityBankLine(
  ctx: UniversityContext,
  row: BankRow,
  overrideReference?: string
) {
  assertRole(ctx, bursar);
  const provider = required(row.provider, 'provider'),
    tx = required(row.transactionId, 'bank transaction reference');
  const reference = required(row.reference, 'bank challan reference'),
    valueDate = date(row.valueDate),
    amount = positive(row.amountPaisa);
  await lock(ctx, key('bank', provider, tx));
  await ctx.db.$executeRaw`
    INSERT INTO university_bank_receipts (organization_id,provider,transaction_id,supplied_reference,paid_paisa,value_date,status,actor_id)
    VALUES (${ctx.organizationId},${provider},${tx},${reference},${amount},${valueDate}::date,'UNMATCHED',${ctx.userId})
    ON CONFLICT (organization_id,provider,transaction_id) DO NOTHING`;
  const [receipt] = await ctx.db.$queryRaw<
    { status: string; same: boolean; matched: string | null }[]
  >`
    SELECT status,matched_reference AS matched, (supplied_reference=${reference} AND paid_paisa=${amount} AND value_date=${valueDate}::date) AS same
      FROM university_bank_receipts WHERE organization_id=${ctx.organizationId} AND provider=${provider} AND transaction_id=${tx}`;
  if (!receipt?.same) throw new Error('Bank transaction reference has conflicting evidence.');
  if (receipt.status !== 'UNMATCHED') {
    if (overrideReference && receipt.matched !== overrideReference)
      throw new Error('Receipt is already posted.');
    return { status: receipt.status, reference: receipt.matched };
  }
  const matched = overrideReference
    ? required(overrideReference, 'corrected challan reference')
    : reference;
  await lock(ctx, key('challan', matched));
  const [account] = await accounts(ctx.db, ctx.organizationId, null, matched);
  const error = !account
    ? 'Unknown challan reference'
    : amount > account.balancePaisa
      ? 'Amount exceeds unpaid balance'
      : null;
  if (error) {
    await ctx.db.$executeRaw`UPDATE university_bank_receipts SET exception=${error},updated_at=now()
        WHERE organization_id=${ctx.organizationId} AND provider=${provider} AND transaction_id=${tx}`;
    return { status: 'UNMATCHED', exception: error };
  }
  await post(ctx, {
    entryKey: key('bank', provider, tx),
    reference: matched,
    kind: 'PAYMENT',
    debit: BANK,
    credit: AR,
    amount,
    reason: key(provider, tx),
  });
  await ctx.db
    .$executeRaw`UPDATE university_bank_receipts SET matched_reference=${matched},status='POSTED',exception=NULL,updated_at=now()
      WHERE organization_id=${ctx.organizationId} AND provider=${provider} AND transaction_id=${tx}`;
  return { status: 'POSTED', reference: matched };
}

async function importStatement(ctx: UniversityContext, input: FormInput) {
  const raw = input.lines;
  if (typeof raw !== 'string' || raw.length > 150_000)
    throw new Error('Supply up to 200 statement lines.');
  let lines: unknown;
  try {
    lines = JSON.parse(raw);
  } catch {
    throw new Error('Enter a JSON array of statement lines.');
  }
  if (!Array.isArray(lines) || !lines.length || lines.length > 200)
    throw new Error('Import between 1 and 200 statement lines.');
  const result = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object')
      throw new Error('Each statement line must be an object.');
    result.push(
      await ingestUniversityBankLine(ctx, {
        provider: input.provider,
        transactionId: line.transactionId,
        reference: line.reference,
        amountPaisa: parsePkr(line.amount),
        valueDate: line.valueDate,
      })
    );
  }
  return { count: result.length, unmatched: result.filter((r) => r.status === 'UNMATCHED').length };
}
async function matchReceipt(ctx: UniversityContext, input: FormInput) {
  const [row] = await ctx.db.$queryRaw<
    BankRow[]
  >`SELECT provider, transaction_id AS "transactionId",supplied_reference AS reference,
    paid_paisa::float8 AS "amountPaisa",value_date::text AS "valueDate" FROM university_bank_receipts
    WHERE organization_id=${ctx.organizationId} AND provider=${input.provider} AND transaction_id=${input.transactionId}`;
  if (!row) throw new Error('Statement line was not found.');
  return ingestUniversityBankLine(ctx, row, input.reference);
}

async function settleReceipt(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, staff);
  const provider = required(input.provider, 'provider'),
    tx = required(input.transactionId, 'bank transaction reference');
  const settlement = required(input.settlement, 'bank settlement reference'),
    valueDate = date(input.date),
    amount = positive(parsePkr(input.amount));
  await lock(ctx, key('bank', provider, tx));
  const updated = await ctx.db
    .$executeRaw`UPDATE university_bank_receipts SET status='SETTLED',settlement_reference=${settlement},settled_date=${valueDate}::date,updated_at=now()
    WHERE organization_id=${ctx.organizationId} AND provider=${provider} AND transaction_id=${tx}
    AND value_date<=${valueDate}::date AND paid_paisa=${amount} AND (status='POSTED' OR (status='SETTLED' AND settlement_reference=${settlement} AND settled_date=${valueDate}::date))`;
  if (!updated)
    throw new Error('Settlement amount, date or reference does not match the posted receipt.');
  return { status: 'SETTLED' };
}

export function hecTuitionRefundPercent(commencementDate: string, requestDate: string) {
  const days =
    Math.floor((Date.parse(date(requestDate)) - Date.parse(date(commencementDate))) / 86_400_000) +
    1;
  if (days <= 10) return 100;
  if (days <= 15) return 80;
  if (days <= 20) return 60;
  if (days <= 30) return 50;
  return 0;
}
function wholeDays(input: string) {
  if (!/^\d{1,5}$/.test(input)) throw new Error('Enter a whole number of days.');
  return Number(input);
}
function prorate(amount: number, numerator: number, denominator: number) {
  // Half-up in whole paisa; integer arithmetic avoids drift at the top of the allowed range.
  return Number(
    (BigInt(amount) * BigInt(numerator) * BigInt(2) + BigInt(denominator)) /
      (BigInt(2) * BigInt(denominator))
  );
}
type RefundBasis = {
  feeHead: FeeHead;
  paidPaisa: number;
  commencementDate: string;
  requestDate: string;
  disciplinary: boolean;
  domestic: boolean;
  policyReference?: string;
  institutionPaisa?: number;
  usedDays?: number;
  totalDays?: number;
  damagePaisa?: number;
};
export function calculateFeeRefund(input: RefundBasis) {
  positive(input.paidPaisa);
  if (input.feeHead === 'OPENING')
    throw new Error('Use the source fee evidence to assess a refund for an opening balance.');
  if (!input.domestic || ['OTHER', 'HOSTEL'].includes(input.feeHead)) {
    required(input.policyReference, 'approved institution policy reference');
    if (
      !Number.isSafeInteger(input.institutionPaisa) ||
      input.institutionPaisa! < 0 ||
      input.institutionPaisa! > input.paidPaisa
    )
      throw new Error('Enter the approved institutional amount within the fees paid.');
    if (input.domestic && input.disciplinary) return 0;
    return input.institutionPaisa!;
  }
  if (input.feeHead === 'DEPOSIT') {
    const damage = input.damagePaisa ?? 0;
    if (!Number.isSafeInteger(damage) || damage < 0)
      throw new Error('Invalid documented damage deduction.');
    return Math.max(0, input.paidPaisa - damage);
  }
  if (input.disciplinary) return 0;
  if (input.feeHead === 'TUITION')
    return prorate(
      input.paidPaisa,
      hecTuitionRefundPercent(input.commencementDate, input.requestDate),
      100
    );
  if (['ADMISSION', 'APPLICATION'].includes(input.feeHead)) return 0;
  if (['LIBRARY', 'EXAM'].includes(input.feeHead)) return input.paidPaisa;
  const { usedDays, totalDays } = input;
  if (
    !Number.isSafeInteger(usedDays) ||
    !Number.isSafeInteger(totalDays) ||
    totalDays! <= 0 ||
    usedDays! < 0 ||
    usedDays! > totalDays!
  )
    throw new Error('Enter the used and total eligible service days.');
  return prorate(input.paidPaisa, totalDays! - usedDays!, totalDays!);
}

async function requestRefund(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, bursar);
  const a = await lockedAccount(ctx, input.reference),
    id = required(input.requestId, 'refund request reference'),
    requestDate = date(input.date);
  const evidence = required(input.evidence, 'withdrawal and payment evidence reference', 300);
  const beneficiary = required(input.beneficiary, 'refund beneficiary', 180);
  const [person] = await ctx.db.$queryRaw<
    { domestic: boolean; future: boolean }[]
  >`SELECT lower(trim(nationality)) IN ('pk','pak','pakistani','pakistan') AS domestic,
    ${requestDate}::date>((now() AT TIME ZONE 'Asia/Karachi')::date) AS future FROM university_people WHERE organization_id=${ctx.organizationId} AND id=${a.personId}`;
  if (!person || person.future) throw new Error('Use the actual date the request was received.');
  const basis: RefundBasis = {
    feeHead: a.feeHead,
    paidPaisa: a.paidPaisa,
    commencementDate: a.commencementDate,
    requestDate,
    disciplinary: input.reason === 'DISCIPLINARY_EXPULSION',
    domestic: person.domestic,
    ...(input.usedDays ? { usedDays: wholeDays(input.usedDays) } : {}),
    ...(input.totalDays ? { totalDays: wholeDays(input.totalDays) } : {}),
    ...(input.damage ? { damagePaisa: parsePkr(input.damage) } : {}),
    ...(input.policy ? { policyReference: required(input.policy, 'policy reference') } : {}),
    ...(input.institutionAmount ? { institutionPaisa: parsePkr(input.institutionAmount) } : {}),
  };
  const policy =
    !basis.domestic || ['OTHER', 'HOSTEL'].includes(a.feeHead)
      ? required(input.policy, 'institution policy reference')
      : 'HEC National Fee Refund Policy 2024';
  const amount = calculateFeeRefund(basis);
  if (!amount) throw new Error('The assessed refund is zero under this policy.');
  const encoded = JSON.stringify(basis);
  const [existing] = await ctx.db.$queryRaw<
    { same: boolean; status: string }[]
  >`SELECT reference=${a.reference} AND request_date=${requestDate}::date
    AND amount_paisa=${amount} AND beneficiary=${beneficiary} AND evidence=${evidence} AND basis=${encoded}::jsonb AS same,status
    FROM university_fee_refunds WHERE organization_id=${ctx.organizationId} AND id=${id}`;
  if (existing) {
    if (!existing.same) throw new Error('Refund reference is already in use.');
    return { id, status: existing.status, amountPaisa: amount };
  }
  if (a.refundPaisa || amount > a.paidPaisa) throw new Error('Payment has already been refunded.');
  const inserted = await ctx.db.$executeRaw`INSERT INTO university_fee_refunds
    (organization_id,id,reference,request_date,policy_version,evidence,beneficiary,basis,amount_paisa,status,requested_by)
    VALUES (${ctx.organizationId},${id},${a.reference},${requestDate}::date,${policy},${evidence},${beneficiary},${encoded}::jsonb,${amount},'REQUESTED',${ctx.userId}) ON CONFLICT DO NOTHING`;
  if (!inserted) throw new Error('A refund request already exists for this challan.');
  return { id, status: 'REQUESTED', amountPaisa: amount };
}
async function decideRefund(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, approver);
  const id = required(input.requestId, 'refund request reference'),
    status = input.decision;
  if (!['APPROVED', 'REJECTED'].includes(status)) throw new Error('Select a refund decision.');
  const count = await ctx.db
    .$executeRaw`UPDATE university_fee_refunds SET status=${status},approved_by=${ctx.userId}
    WHERE organization_id=${ctx.organizationId} AND id=${id} AND requested_by<>${ctx.userId} AND
    (status='REQUESTED' OR (status=${status} AND approved_by=${ctx.userId}))`;
  if (!count) throw new Error('A different authorized officer must decide a pending request.');
  return { id, status };
}
async function disburseRefund(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, staff);
  const id = required(input.requestId, 'refund request reference'),
    payout = required(input.payout, 'bank disbursement reference');
  const [r] = await ctx.db.$queryRaw<
    { reference: string; amount: number; status: string; payout: string }[]
  >`SELECT reference,amount_paisa::float8 AS amount,status,disbursement_reference AS payout
    FROM university_fee_refunds WHERE organization_id=${ctx.organizationId} AND id=${id} FOR UPDATE`;
  if (!r || (r.status !== 'APPROVED' && !(r.status === 'DISBURSED' && r.payout === payout)))
    throw new Error('Choose an approved refund and verify the disbursement reference.');
  if (r.status === 'DISBURSED') return { id, status: r.status };
  const a = await lockedAccount(ctx, r.reference);
  if (a.paidPaisa - a.refundPaisa < r.amount)
    throw new Error('Refund exceeds remaining paid funds.');
  await post(ctx, {
    entryKey: key('refund-credit', id),
    reference: r.reference,
    kind: 'REFUND_CREDIT',
    debit: `FEES_${a.feeHead}`,
    credit: AR,
    amount: r.amount,
    reason: id,
  });
  await post(ctx, {
    entryKey: key('refund-payout', id),
    reference: r.reference,
    kind: 'REFUND_PAID',
    debit: AR,
    credit: BANK,
    amount: r.amount,
    reason: payout,
  });
  await ctx.db
    .$executeRaw`UPDATE university_fee_refunds SET status='DISBURSED',disbursement_reference=${payout} WHERE organization_id=${ctx.organizationId} AND id=${id}`;
  return { id, status: 'DISBURSED' };
}

async function returnUnmatchedReceipt(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, approver);
  const provider = required(input.provider, 'provider'),
    tx = required(input.transactionId, 'bank transaction reference'),
    evidence = required(input.payout, 'bank return reference');
  await lock(ctx, key('bank', provider, tx));
  const count = await ctx.db
    .$executeRaw`UPDATE university_bank_receipts SET status='RETURNED',exception=${evidence},updated_at=now()
    WHERE organization_id=${ctx.organizationId} AND provider=${provider} AND transaction_id=${tx}
      AND (status='UNMATCHED' OR (status='RETURNED' AND exception=${evidence}))`;
  if (count !== 1)
    throw new Error('Choose an unmatched receipt and enter its confirmed bank return.');
  await emitUniversityEvent(ctx, 'finance.unmatched-returned', key(provider, tx), {
    provider,
    transactionId: tx,
    bankReturnReference: evidence,
  });
  return { status: 'RETURNED', transactionId: tx };
}

async function transferFee(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, approver);
  const source = required(input.reference, 'source challan reference'),
    target = required(input.target, 'destination challan reference');
  if (source === target) throw new Error('Source and destination must be different challans.');
  for (const reference of [source, target].sort()) await lock(ctx, key('challan', reference));
  const [from] = await accounts(ctx.db, ctx.organizationId, null, source),
    [to] = await accounts(ctx.db, ctx.organizationId, null, target);
  if (!from || !to || from.personId !== to.personId || from.feeHead !== to.feeHead)
    throw new Error('Select two matching fee heads for the same student.');
  const evidence = required(input.evidence, 'policy approval or medical evidence reference', 300);
  const type = required(input.transferType, 'transfer type'),
    received = date(input.date);
  if (!['TRANSFER', 'POSTPONEMENT', 'MEDICAL_POSTPONEMENT'].includes(type))
    throw new Error('Select a valid transfer type.');
  if (type !== 'TRANSFER') {
    if (from.feeHead !== 'TUITION' || to.commencementDate <= from.commencementDate)
      throw new Error('Carry forward tuition to a later semester.');
    const days =
      Math.floor((Date.parse(received) - Date.parse(from.commencementDate)) / 86400000) + 1;
    if (days > 14 && type !== 'MEDICAL_POSTPONEMENT')
      throw new Error('Late postponement requires verified medical evidence.');
  }
  const tag = key('fee-transfer', required(input.transferId, 'transfer reference')),
    amount = positive(parsePkr(input.amount));
  const reason = JSON.stringify({ type, received, evidence, source, target });
  const [existing] = await ctx.db.$queryRaw<
    { entry_key: string }[]
  >`SELECT entry_key FROM university_finance_entries WHERE organization_id=${ctx.organizationId} AND entry_key=${tag + '/out'}`;
  if (!existing) {
    const [refund] = await ctx.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM university_fee_refunds WHERE organization_id=${ctx.organizationId} AND reference IN (${source},${target}) AND status<>'REJECTED' LIMIT 1`;
    if (refund || amount > from.paidPaisa - from.refundPaisa || amount > to.balancePaisa)
      throw new Error(
        'Transfer exceeds available funds, destination balance, or conflicts with a refund.'
      );
  }
  await post(ctx, {
    entryKey: tag + '/credit',
    reference: source,
    kind: 'TRANSFER_CREDIT',
    debit: 'FEES_' + from.feeHead,
    credit: AR,
    amount,
    reason,
  });
  await post(ctx, {
    entryKey: tag + '/out',
    reference: source,
    kind: 'TRANSFER_OUT',
    debit: AR,
    credit: 'FEE_TRANSFER_CLEARING',
    amount,
    reason,
  });
  await post(ctx, {
    entryKey: tag + '/in',
    reference: target,
    kind: 'TRANSFER_IN',
    debit: 'FEE_TRANSFER_CLEARING',
    credit: AR,
    amount,
    reason,
  });
  return { source, target, amountPaisa: amount };
}

async function acknowledgeGl(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, approver);
  const entryKey = required(input.entry, 'posting reference', 4000),
    journal = required(input.journal, 'GL journal reference');
  const [entry] = await ctx.db.$queryRaw<
    { amount: number; event_id: string }[]
  >`SELECT e.amount_paisa::float8 AS amount, o.id AS event_id
    FROM university_finance_entries e JOIN university_events o ON o.organization_id=e.organization_id AND o.kind='finance.posted' AND o.source_key=e.entry_key
    WHERE e.organization_id=${ctx.organizationId} AND e.entry_key=${entryKey}`;
  if (!entry || entry.amount !== positive(parsePkr(input.amount)))
    throw new Error('Journal amount does not match the posting.');
  await ctx.db
    .$executeRaw`INSERT INTO university_finance_gl_acknowledgments (organization_id,entry_key,journal_reference,actor_id)
    VALUES (${ctx.organizationId},${entryKey},${journal},${ctx.userId}) ON CONFLICT DO NOTHING`;
  const [ack] = await ctx.db.$queryRaw<
    { journal_reference: string }[]
  >`SELECT journal_reference FROM university_finance_gl_acknowledgments WHERE organization_id=${ctx.organizationId} AND entry_key=${entryKey}`;
  if (ack?.journal_reference !== journal)
    throw new Error('Posting was already acknowledged with a different journal.');
  await recordEventReceipt(ctx, entry.event_id, 'ACKNOWLEDGED', journal);
  return { entryKey, journal };
}

async function reversePosting(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, approver);
  const entryKey = required(input.entry, 'original posting reference', 4000),
    reason = required(input.evidence, 'reason and supporting evidence', 300);
  const [entry] = await ctx.db.$queryRaw<
    { reference: string; kind: string; amount: number; debit: string; credit: string }[]
  >`
    SELECT reference,kind,amount_paisa::float8 AS amount,debit_account AS debit,credit_account AS credit FROM university_finance_entries
    WHERE organization_id=${ctx.organizationId} AND entry_key=${entryKey}`;
  if (!entry || !['CHARGE', 'SCHOLARSHIP', 'PAYMENT'].includes(entry.kind))
    throw new Error('Select an original charge, payment or scholarship.');
  if (entry.kind === 'PAYMENT') await lock(ctx, entryKey);
  const a = await lockedAccount(ctx, entry.reference);
  const reversalKey = key('reversal', entryKey);
  const [reversed] = await ctx.db.$queryRaw<
    { entry_key: string }[]
  >`SELECT entry_key FROM university_finance_entries WHERE organization_id=${ctx.organizationId} AND reversal_of=${entryKey}`;
  if (!reversed) {
    if (entry.kind === 'PAYMENT' && entry.amount > a.paidPaisa)
      throw new Error('Funds already transferred to another challan.');
    if (entry.kind === 'CHARGE' && a.balancePaisa !== entry.amount)
      throw new Error('Reverse dependent receipts and awards before reversing the charge.');
    const [pending] = await ctx.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM university_fee_refunds WHERE organization_id=${ctx.organizationId} AND reference=${entry.reference} AND status<>'REJECTED' LIMIT 1`;
    if (pending) throw new Error('Posting belongs to a challan with an active or paid refund.');
  }
  await post(ctx, {
    entryKey: reversalKey,
    reference: entry.reference,
    kind: 'REVERSAL',
    debit: entry.credit,
    credit: entry.debit,
    amount: entry.amount,
    reason,
    reversalOf: entryKey,
  });
  if (entry.kind === 'PAYMENT') {
    const [, provider, transactionId] = entryKey.split('/').map(decodeURIComponent);
    await ctx.db
      .$executeRaw`UPDATE university_bank_receipts SET status='REVERSED',exception=${reason},updated_at=now()
    WHERE organization_id=${ctx.organizationId} AND provider=${provider} AND transaction_id=${transactionId}`;
  }
  return { entryKey: reversalKey };
}
async function closeMonth(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, approver);
  const month = required(input.month, 'accounting month', 7),
    start = date(`${month}-01`);
  await lock(ctx, key('close', month));
  const [closed] = await ctx.db.$queryRaw<
    { month_start: string }[]
  >`SELECT month_start::text FROM university_finance_closed_periods WHERE organization_id=${ctx.organizationId} AND month_start=${start}::date`;
  if (closed) return { month, status: 'CLOSED' };
  const [state] = await ctx.db.$queryRaw<
    { elapsed: boolean; pending: boolean; unsettled: boolean }[]
  >`
    SELECT ${start}::date<date_trunc('month',now() AT TIME ZONE 'Asia/Karachi') AS elapsed,
    EXISTS (SELECT 1 FROM university_finance_entries e WHERE organization_id=${ctx.organizationId} AND posting_date>=${start}::date
      AND posting_date<${start}::date + interval '1 month' AND NOT EXISTS (SELECT 1 FROM university_finance_gl_acknowledgments a WHERE a.organization_id=e.organization_id AND a.entry_key=e.entry_key)) AS pending,
    EXISTS (SELECT 1 FROM university_bank_receipts WHERE organization_id=${ctx.organizationId} AND value_date>=${start}::date
      AND value_date<${start}::date + interval '1 month' AND status IN ('UNMATCHED','POSTED')) AS unsettled`;
  if (!state?.elapsed || state.pending || state.unsettled)
    throw new Error('Reconcile all statement lines and GL postings after the month ends.');
  await ctx.db
    .$executeRaw`INSERT INTO university_finance_closed_periods (organization_id,month_start,closed_by) VALUES (${ctx.organizationId},${start}::date,${ctx.userId}) ON CONFLICT DO NOTHING`;
  return { month, status: 'CLOSED' };
}

export function normalizePakistanIban(raw: string) {
  const iban = raw.replace(/\s/g, '').toUpperCase();
  if (!/^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/.test(iban))
    throw new Error('Enter a 24-character Pakistan IBAN.');
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (letter) =>
    String(letter.charCodeAt(0) - 55)
  );
  if (BigInt(digits) % BigInt(97) !== BigInt(1)) throw new Error('IBAN check digits are invalid.');
  return iban;
}
async function setCollectionAccount(ctx: UniversityContext, input: FormInput) {
  assertRole(ctx, approver);
  const bank = required(input.bank, 'bank name'),
    beneficiary = required(input.beneficiary, 'bank account title');
  const iban = normalizePakistanIban(required(input.iban, 'Pakistan IBAN', 40));
  await ctx.db
    .$executeRaw`INSERT INTO university_fee_collection_accounts (organization_id,bank_name,beneficiary,iban,updated_by)
    VALUES (${ctx.organizationId},${bank},${beneficiary},${iban},${ctx.userId})
    ON CONFLICT (organization_id) DO UPDATE SET bank_name=EXCLUDED.bank_name, beneficiary=EXCLUDED.beneficiary,
    iban=EXCLUDED.iban, updated_by=EXCLUDED.updated_by, updated_at=now()`;
  return { bank, beneficiary };
}

function field(
  name: string,
  label: string,
  type: UniversityField['type'] = 'text',
  optional = false
): UniversityField {
  return { name, label, type, required: !optional };
}
function select(name: string, label: string, options: readonly string[]): UniversityField {
  return { name, label, type: 'select', required: true, options };
}
const referenceField = field('reference', 'Challan reference');
const providerFields = [
  field('provider', 'Bank or collection provider'),
  field('transactionId', 'Bank transaction reference'),
];
const amountField = field('amount', 'Amount in PKR');
const requestField = field('requestId', 'Refund request reference');
const entryField = field('entry', 'Ledger posting reference');
async function readOffice(ctx: UniversityContext) {
  assertRole(ctx, staff);
  return ctx.db.$queryRaw<Record<string, unknown>[]>`
    WITH records AS (
      SELECT 'Challan'::text AS category,reference AS record, fee_head AS details,amount_paisa::float8/100 AS pkr, created_at AS at
      FROM university_challans WHERE organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Bank receipt',transaction_id,provider || ' · ' || status || ' · ' || coalesce(exception,matched_reference,supplied_reference),paid_paisa::float8/100,updated_at
      FROM university_bank_receipts WHERE organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Refund',id,reference || ' · ' || status || ' · ' || beneficiary,amount_paisa::float8/100,request_date::timestamp AT TIME ZONE 'Asia/Karachi'
      FROM university_fee_refunds WHERE organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Ledger',e.entry_key,e.debit_account || ' / ' || e.credit_account || ' · ' || coalesce(a.journal_reference,'Awaiting GL acknowledgment'),
        e.amount_paisa::float8/100,e.posting_date::timestamp AT TIME ZONE 'Asia/Karachi'
      FROM university_finance_entries e LEFT JOIN university_finance_gl_acknowledgments a USING (organization_id,entry_key) WHERE e.organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Fee review',source_key,kind || ' · ' || COALESCE(payload->>'chargeReference',payload->>'personId',''),NULL,occurred_at
        FROM university_events WHERE organization_id=${ctx.organizationId} AND kind IN ('student.program.withdrawn','service.released') AND status='PENDING'
      UNION ALL SELECT 'Month close',to_char(month_start,'YYYY-MM'),'Closed',NULL,closed_at FROM university_finance_closed_periods WHERE organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Collection account',bank_name,beneficiary || ' · ' || iban,NULL,updated_at FROM university_fee_collection_accounts WHERE organization_id=${ctx.organizationId}
    ) SELECT category,record,details,pkr FROM records ORDER BY at DESC,category,record LIMIT 150`;
}

export const financeOffice: UniversityOffice = {
  title: 'Student finance',
  description:
    'Issue PKR fee challans, reconcile bank receipts, process refunds and close accounts.',
  moduleKey: 'university-finance',
  roles: staff,
  read: readOffice,
  actions: [
    {
      key: 'collection-account',
      label: 'Set collection account',
      roles: approver,
      fields: [
        field('bank', 'Bank name'),
        field('beneficiary', 'University account title'),
        field('iban', 'Pakistan IBAN'),
      ],
      run: setCollectionAccount,
    },
    {
      key: 'issue-challan',
      label: 'Issue a fee challan',
      roles: bursar,
      fields: [
        field('personId', 'University person ID'),
        referenceField,
        select('feeHead', 'Fee head', feeHeads),
        amountField,
        field('commencementDate', 'Commencement of classes', 'date'),
        field('dueDate', 'Payment due date', 'date'),
      ],
      run: (ctx, input) => {
        assertRole(ctx, bursar);
        return issueStudentCharge(ctx, {
          personId: input.personId,
          reference: input.reference,
          feeHead: input.feeHead,
          amountPaisa: parsePkr(input.amount),
          commencementDate: input.commencementDate,
          dueDate: input.dueDate,
        });
      },
    },
    {
      key: 'scholarship',
      label: 'Post scholarship or sponsorship',
      roles: bursar,
      fields: [referenceField, amountField, field('award', 'Award or sponsor reference')],
      run: awardScholarship,
    },
    {
      key: 'receipt',
      label: 'Record bank statement line',
      roles: bursar,
      fields: [
        ...providerFields,
        referenceField,
        amountField,
        field('valueDate', 'Bank value date', 'date'),
      ],
      run: (ctx, input) =>
        ingestUniversityBankLine(ctx, {
          provider: input.provider,
          transactionId: input.transactionId,
          reference: input.reference,
          amountPaisa: parsePkr(input.amount),
          valueDate: input.valueDate,
        }),
    },
    {
      key: 'statement',
      label: 'Import statement lines',
      roles: bursar,
      fields: [
        field('provider', 'Bank or collection provider'),
        field(
          'lines',
          'JSON array with transactionId, reference, amount (PKR string) and valueDate',
          'textarea'
        ),
      ],
      run: importStatement,
    },
    {
      key: 'match-receipt',
      label: 'Resolve unmatched bank receipt',
      roles: bursar,
      fields: [...providerFields, referenceField],
      run: matchReceipt,
    },
    {
      key: 'settle',
      label: 'Confirm bank settlement',
      roles: staff,
      fields: [
        ...providerFields,
        amountField,
        field('date', 'Settlement date', 'date'),
        field('settlement', 'Settlement reference'),
      ],
      run: settleReceipt,
    },
    {
      key: 'request-refund',
      label: 'Request fee refund',
      roles: bursar,
      fields: [
        requestField,
        referenceField,
        field('date', 'Withdrawal application received', 'date'),
        field('beneficiary', 'Student, guardian or sponsor receiving funds'),
        field('evidence', 'Withdrawal and payment evidence reference'),
        select('reason', 'Withdrawal reason', ['WITHDRAWAL', 'DISCIPLINARY_EXPULSION']),
        field('usedDays', 'Service days used', 'number', true),
        field('totalDays', 'Total eligible service days', 'number', true),
        field('damage', 'Documented deposit deductions (PKR)', 'text', true),
        field(
          'policy',
          'Institutional policy reference for hostel, other or overseas fees',
          'text',
          true
        ),
        field('institutionAmount', 'Institution-approved refund (PKR)', 'text', true),
      ],
      run: requestRefund,
    },
    {
      key: 'decide-refund',
      label: 'Decide refund request',
      roles: approver,
      fields: [requestField, select('decision', 'Decision', ['APPROVED', 'REJECTED'])],
      run: decideRefund,
    },
    {
      key: 'disburse',
      label: 'Record refund disbursement',
      roles: staff,
      fields: [requestField, field('payout', 'Bank disbursement reference')],
      run: disburseRefund,
    },
    {
      key: 'return-unmatched',
      label: 'Record return of unmatched payment',
      roles: approver,
      fields: [...providerFields, field('payout', 'Bank-confirmed return reference')],
      run: returnUnmatchedReceipt,
    },
    {
      key: 'apply-opening-credit',
      label: 'Allocate migrated student credit',
      roles: approver,
      fields: [
        field('transferId', 'Allocation reference'),
        referenceField,
        field('target', 'Destination challan'),
        amountField,
        field('evidence', 'Allocation evidence reference'),
      ],
      run: applyOpeningCredit,
    },
    {
      key: 'transfer-fee',
      label: 'Transfer or carry forward paid fees',
      roles: approver,
      fields: [
        field('transferId', 'Transfer approval reference'),
        referenceField,
        field('target', 'Destination challan reference'),
        amountField,
        field('date', 'Application received', 'date'),
        select('transferType', 'Approval basis', [
          'TRANSFER',
          'POSTPONEMENT',
          'MEDICAL_POSTPONEMENT',
        ]),
        field('evidence', 'Approved program transfer or verified postponement evidence'),
      ],
      run: transferFee,
    },
    {
      key: 'acknowledge-gl',
      label: 'Reconcile general ledger posting',
      roles: approver,
      fields: [entryField, amountField, field('journal', 'External GL journal reference')],
      run: acknowledgeGl,
    },
    {
      key: 'reverse',
      label: 'Reverse ledger posting',
      roles: approver,
      fields: [entryField, field('evidence', 'Reason and evidence reference')],
      run: reversePosting,
    },
    {
      key: 'close',
      label: 'Close accounting month',
      roles: approver,
      fields: [field('month', 'Month (YYYY-MM)')],
      run: closeMonth,
    },
  ],
};
