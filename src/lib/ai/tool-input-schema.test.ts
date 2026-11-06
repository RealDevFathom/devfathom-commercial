import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildAssistantTools } from './tools';
import { MODULE_CATALOG } from '@/lib/module-catalog';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: () => ({}) }));

describe('provider tool schema contract', () => {
  it.each(['AGENCY', 'PHARMACY', 'RESTAURANT'] as const)(
    'serializes every exposed %s tool with an object root',
    (vertical) => {
      for (const role of ['ADMIN', 'HR', 'EMPLOYEE']) {
        for (const hint of ['', 'supplier credit follow-up work packs']) {
          const tools = buildAssistantTools(
            {
              organizationId: 'schema-org',
              userId: 'schema-user',
              role,
              vertical,
              enabledModules: MODULE_CATALOG.map(({ key }) => key),
            },
            { hint }
          );
          expect(Object.keys(tools).length).toBeGreaterThan(0);
          for (const [name, definition] of Object.entries(tools)) {
            const schema = JSON.parse(
              JSON.stringify(z.toJSONSchema(definition.inputSchema as z.ZodType))
            );
            expect(schema, `${vertical}/${role}/${name}`).toMatchObject({ type: 'object' });
          }
        }
      }
    }
  );
});
