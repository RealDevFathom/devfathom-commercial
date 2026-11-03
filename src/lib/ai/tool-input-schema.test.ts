// @vitest-environment node

import { asSchema } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { buildAssistantTools } from '@/lib/ai/tools';
import { MODULE_CATALOG } from '@/lib/module-catalog';
import { ALL_VERTICALS } from '@/lib/vertical-catalog';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: () => ({}) }));

describe('provider tool input schemas', () => {
  for (const vertical of ALL_VERTICALS) {
    for (const role of ['ADMIN', 'HR', 'EMPLOYEE']) {
      for (const hint of ['', 'pharmacy work pack']) {
        const tools = buildAssistantTools(
          {
            organizationId: 'schema_test',
            userId: 'schema_test',
            vertical,
            role,
            enabledModules: MODULE_CATALOG.map(({ key }) => key),
          },
          { hint }
        );

        describe(`${vertical}/${role}/${hint || 'full continuation'}`, () => {
          it('registers tools for conversion', () => {
            expect(Object.keys(tools).length).toBeGreaterThan(0);
            if (vertical === 'PHARMACY' && role === 'ADMIN') {
              expect(tools).toHaveProperty('askPharmacyFinanceInsights');
              if (hint) expect(tools).toHaveProperty('askPharmacyWorkPacks');
            }
          });

          for (const [name, registeredTool] of Object.entries(tools)) {
            it(`${name} sends an object input schema`, async () => {
              // Same conversion used by the installed SDK's prepareToolsAndToolChoice.
              const schema = await asSchema(registeredTool.inputSchema).jsonSchema;
              expect(schema.type).toBe('object');
            });
          }
        });
      }
    }
  }
});
