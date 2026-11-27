import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ApiRequestError, type ApiContext } from '@/lib/api-auth';
import { academicsOffice } from './academics';
import {
  bindOfficeScope,
  canPerformOfficeAction,
  universityStaffContext,
  UniversityAccessError,
} from './access';
import { financeOffice } from './finance';
import type { UniversityOffice } from './office-types';

const ref = z.string().trim().min(1).max(100);
const amountPaisa = z.int().positive().max(999_999_999_999);
const headers = { version: z.literal(1), externalId: z.string().trim().min(1).max(160) };
const bankKey = { provider: ref, transactionId: ref, amountPaisa };
export const universityCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...headers,
    kind: z.literal('grade.draft'),
    payload: z.strictObject({ enrollmentId: ref, mark: z.int().min(0).max(100) }),
  }),
  z.strictObject({
    ...headers,
    kind: z.literal('bank.collection'),
    payload: z.strictObject({ ...bankKey, reference: ref, valueDate: z.iso.date() }),
  }),
  z.strictObject({
    ...headers,
    kind: z.literal('bank.settlement'),
    payload: z.strictObject({ ...bankKey, date: z.iso.date(), settlement: ref }),
  }),
  z.strictObject({
    ...headers,
    kind: z.literal('finance.gl-acknowledgment'),
    payload: z.strictObject({
      entry: z.string().trim().min(1).max(4000),
      journal: ref,
      amountPaisa,
    }),
  }),
]);
type Command = z.infer<typeof universityCommandSchema>;
const operations: Record<Command['kind'], { office: UniversityOffice; actionKey: string }> = {
  'grade.draft': { office: academicsOffice, actionKey: 'submit-grade' },
  'bank.collection': { office: financeOffice, actionKey: 'receipt' },
  'bank.settlement': { office: financeOffice, actionKey: 'settle' },
  'finance.gl-acknowledgment': { office: financeOffice, actionKey: 'acknowledge-gl' },
};
function officeFields(command: Command): Record<string, string> {
  if (command.kind === 'grade.draft')
    return { enrollmentId: command.payload.enrollmentId, mark: String(command.payload.mark) };
  const { amountPaisa, ...fields } = command.payload;
  return {
    ...fields,
    amount: Math.floor(amountPaisa / 100) + '.' + String(amountPaisa % 100).padStart(2, '0'),
  };
}

/** The parent REST transaction owns authorization, the domain operation and its durable receipt. */
export async function runUniversityCommand(ctx: ApiContext, command: Command) {
  const { organizationId: org, db } = ctx;
  const { office, actionKey } = operations[command.kind];
  if (
    ctx.entitlements.vertical !== 'UNIVERSITY' ||
    !ctx.entitlements.enabledModules.includes(office.moduleKey)
  )
    throw new ApiRequestError(403, 'The provider topic is unavailable.');
  const [grant] = await db.$queryRaw<
    { token_id: string }[]
  >`SELECT token_id FROM university_connector_topics WHERE organization_id=${org} AND kind=${command.kind} AND token_id=${ctx.tokenId} FOR SHARE`;
  if (!grant) throw new ApiRequestError(403, 'The provider topic is unavailable.');
  await db.$queryRaw`SELECT set_config('app.current_user_id',${ctx.userId},true)`;
  const staff = await universityStaffContext(db, org, ctx.userId, ctx.entitlements).catch(
    (error) => {
      if (error instanceof UniversityAccessError)
        throw new ApiRequestError(403, 'The token owner cannot perform this operation.');
      throw error;
    }
  );
  const action = office.actions.find((a) => a.key === actionKey);
  if (!action) throw new Error('University provider action configuration is missing.');
  if (!canPerformOfficeAction(staff, office, action))
    throw new ApiRequestError(403, 'The token owner cannot perform this operation.');
  await bindOfficeScope(staff, office);
  // Recheck the target even on replay. An instructor may have been removed from a section since the command was recorded.
  if (command.kind === 'grade.draft') {
    const [target] = await db.$queryRaw<
      { id: string }[]
    >`SELECT e.id FROM university_enrollments e JOIN university_sections s ON (s.organization_id,s.id)=(e.organization_id,e.section_id)
      WHERE e.organization_id=${org} AND e.id=${command.payload.enrollmentId} AND e.status='ENROLLED'
      AND (${staff.admin || staff.roleKey !== 'university-instructor'} OR s.instructor_id=${ctx.userId})`;
    if (!target)
      throw new ApiRequestError(403, 'The enrollment is outside the token owner’s scope.');
  }
  const lock = JSON.stringify([org, command.kind, command.externalId]);
  await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${lock},0))`;
  // The strict Zod schema gives parsed fields a stable order, independently of incoming JSON key order.
  const hash = createHash('sha256')
    .update(JSON.stringify([command.version, command.payload]))
    .digest('hex');
  const [prior] = await db.$queryRaw<
    { payload_hash: string; result: unknown }[]
  >`SELECT payload_hash,result FROM university_command_inbox WHERE organization_id=${org} AND kind=${command.kind} AND external_id=${command.externalId}`;
  if (prior) {
    if (prior.payload_hash !== hash)
      throw new ApiRequestError(409, 'The external ID was already used with a different payload.');
    return {
      version: 1,
      kind: command.kind,
      externalId: command.externalId,
      replayed: true,
      result: prior.result,
    };
  }
  let result: unknown;
  try {
    result = await action.run(staff, officeFields(command));
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'FORBIDDEN')
      throw new ApiRequestError(403, 'The token owner cannot perform this operation.');
    if (
      (error instanceof TRPCError &&
        ['BAD_REQUEST', 'PRECONDITION_FAILED', 'NOT_FOUND', 'CONFLICT'].includes(error.code)) ||
      (error instanceof Error && error.constructor === Error)
    )
      throw new ApiRequestError(
        422,
        'The university office could not apply the command. Check the record, amount and current state.'
      );
    throw error;
  }
  await db.$executeRaw`INSERT INTO university_command_inbox(organization_id,kind,external_id,payload_hash,actor_id,token_id,result)
    VALUES(${org},${command.kind},${command.externalId},${hash},${ctx.userId},${ctx.tokenId},${JSON.stringify(result)}::jsonb)`;
  return {
    version: 1,
    kind: command.kind,
    externalId: command.externalId,
    replayed: false,
    result,
  };
}
