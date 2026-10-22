import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('agency invoice issuer contract', () => {
  it.each([
    'src/server/routers/finance.ts',
    'src/app/api/v1/invoices/[id]/route.ts',
    'src/lib/ai/tools/finance.ts',
  ])('%s resolves the issuer from the authenticated tenant', (path) => {
    const contents = source(path);
    expect(contents).toContain('readInvoiceIssuer');
    expect(contents).toMatch(/organizationId|workspaceId\(ctx\)/);
  });

  it('prints the returned agency identity rather than DevFathom platform branding', () => {
    const contents = source(
      'src/app/(app)/finance/invoices/[id]/print/print-invoice.tsx'
    );
    expect(contents).toContain('invoice.issuer?.name');
    expect(contents).toContain('invoice.issuer?.address');
    expect(contents).toContain('invoice.issuer?.taxId');
    expect(contents).not.toContain('hub.devfathom.com');
  });
});
