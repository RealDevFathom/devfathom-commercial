import { eventModule } from './connector-topics';
export { eventModule } from './connector-topics';
import type { UniversityContext, UniversityOffice } from './office-types';

type EventWriter = Pick<UniversityContext, 'db' | 'organizationId'>;

/** Store the external work in the transaction that produced the academic or financial change. */
export async function emitUniversityEvent(
  ctx: EventWriter,
  kind: string,
  sourceKey: string,
  payload: unknown
) {
  const encoded = JSON.stringify(payload);
  await ctx.db
    .$queryRaw`SELECT 1 FROM university_emit_event(${ctx.organizationId}, ${kind}, ${sourceKey}, ${encoded}::jsonb)`;
}

export async function recordEventReceipt(
  ctx: EventWriter,
  id: string,
  status: 'FAILED' | 'ACKNOWLEDGED',
  reference: string
) {
  const count = await ctx.db.$executeRaw`
    UPDATE university_events
       SET status = ${status}, acknowledgment = ${reference}, acknowledged_at = now()
     WHERE organization_id = ${ctx.organizationId} AND id = ${id}
       AND (status <> 'ACKNOWLEDGED' OR (status = ${status} AND acknowledgment = ${reference}))`;
  if (count !== 1) throw new Error('Unknown event or conflicting acknowledgment.');
}

export const integrationOffice: UniversityOffice = {
  title: 'Integration deliveries',
  description: 'Review changes queued for external systems and replay a failed delivery.',
  moduleKey: 'university-core',
  roles: ['university-admin'],
  read: (ctx) => ctx.db.$queryRaw`
    SELECT id, kind, source_key, status, occurred_at, acknowledgment FROM university_events
    WHERE organization_id = ${ctx.organizationId}
    ORDER BY (status = 'FAILED') DESC, occurred_at DESC, id LIMIT 100`,
  actions: [
    {
      key: 'assign-connector',
      label: 'Assign event delivery to an API token',
      fields: [
        { name: 'kind', label: 'Event kind (for example, student.registered)', required: true },
        { name: 'tokenId', label: 'Token ID from organization API settings', required: true },
      ],
      run: async (ctx, input) => {
        if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(input.kind) || !eventModule(input.kind))
          throw new Error('Enter a supported event kind.');
        const assigned = await ctx.db.$executeRaw`
        INSERT INTO university_connector_topics (organization_id, kind, token_id)
        SELECT ${ctx.organizationId}, ${input.kind}, id FROM api_tokens
         WHERE "organizationId" = ${ctx.organizationId} AND id = ${input.tokenId}
         AND ('university:integrations:read' = ANY(scopes) OR 'university:integrations:write' = ANY(scopes) OR '*' = ANY(scopes))
        ON CONFLICT (organization_id, kind) DO UPDATE SET token_id = excluded.token_id`;
        if (!assigned)
          throw new Error('Select a university integration token with integration access.');
        return { kind: input.kind, tokenId: input.tokenId };
      },
    },
    {
      key: 'remove-connector',
      label: 'Stop delivery for an event kind',
      fields: [{ name: 'kind', label: 'Event kind', required: true }],
      run: async (ctx, input) => {
        await ctx.db
          .$executeRaw`DELETE FROM university_connector_topics WHERE organization_id=${ctx.organizationId} AND kind=${input.kind}`;
        return { kind: input.kind };
      },
    },
    {
      key: 'replay',
      label: 'Retry failed delivery',
      fields: [{ name: 'eventId', label: 'Event ID', required: true }],
      run: async (ctx, input) => {
        const count = await ctx.db.$executeRaw`
        UPDATE university_events SET status = 'PENDING', acknowledged_at = NULL, acknowledgment = NULL
         WHERE organization_id = ${ctx.organizationId} AND id = ${input.eventId} AND status = 'FAILED'`;
        if (!count) throw new Error('Select a failed event to retry.');
        return { eventId: input.eventId, status: 'PENDING' };
      },
    },
  ],
};
