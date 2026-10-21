import { describe, expect, it } from 'vitest';

import {
  assertFiscalLinkage,
  beginFiscalAttempt,
  fiscalRetentionUntil,
  fiscalRetryDelaySeconds,
  receiptFiscalFields,
  SandboxIntegrator,
  selectFiscalIntegrator,
  settleFiscalAttempt,
  type FiscalQueueItem,
} from './fiscal';

const queued = (overrides: Partial<FiscalQueueItem> = {}): FiscalQueueItem => ({
  status: 'QUEUED',
  attempts: 0,
  maxAttempts: 3,
  nextAttemptAt: null,
  externalReference: null,
  externalQr: null,
  lastError: null,
  ...overrides,
});

describe('fiscal queue', () => {
  it('uses deterministic capped exponential retry times', () => {
    expect(fiscalRetryDelaySeconds(1, 60)).toBe(60);
    expect(fiscalRetryDelaySeconds(2, 60)).toBe(120);
    expect(fiscalRetryDelaySeconds(20, 60)).toBe(3_600);
    const active = beginFiscalAttempt(queued());
    const retry = settleFiscalAttempt(
      active,
      { outcome: 'TRANSIENT_ERROR', reason: 'offline' },
      new Date('2026-09-04T10:00:00.000Z'),
      60
    );
    expect(retry).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'offline' });
    expect(retry.nextAttemptAt?.toISOString()).toBe('2026-09-04T10:01:00.000Z');
  });

  it('dead-letters exactly when the bounded attempt budget is exhausted', () => {
    const active = beginFiscalAttempt(queued({ attempts: 2 }));
    const dead = settleFiscalAttempt(
      active,
      { outcome: 'TRANSIENT_ERROR', reason: 'still offline' },
      new Date('2026-09-04T10:00:00.000Z'),
      60
    );
    expect(dead).toMatchObject({ status: 'DEAD', attempts: 3, nextAttemptAt: null });
    expect(() => beginFiscalAttempt(dead)).toThrow();
  });

  it('keeps explicit rejected and accepted lifecycle outcomes', () => {
    const rejected = settleFiscalAttempt(
      beginFiscalAttempt(queued()),
      { outcome: 'REJECTED', reason: 'schema rejected' },
      new Date(),
      60
    );
    expect(rejected).toMatchObject({ status: 'REJECTED', lastError: 'schema rejected' });
  });
});

describe('integrator and linkage safety', () => {
  it('defaults missing or OFF configuration to no integration', () => {
    expect(selectFiscalIntegrator(undefined)).toBeNull();
    expect(selectFiscalIntegrator(null)).toBeNull();
    expect(selectFiscalIntegrator('OFF')).toBeNull();
  });

  it('records sandbox submissions and returns only a SANDBOX-labelled non-FBR reference', async () => {
    const integrator = selectFiscalIntegrator('SANDBOX');
    expect(integrator).toBeInstanceOf(SandboxIntegrator);
    const result = await integrator!.submit({
      localReference: 'LOCAL-42',
      kind: 'INVOICE',
      originalLocalReference: null,
      payloadHash: 'hash',
      payload: { totalMinor: 1200 },
    });
    expect(result).toEqual({
      outcome: 'ACCEPTED',
      externalReference: 'SANDBOX-LOCAL-42',
      externalQr: null,
    });
    expect((integrator as SandboxIntegrator).submissions).toHaveLength(1);
  });

  it('requires credit/debit notes to link to an original and invoices not to', () => {
    expect(() => assertFiscalLinkage({ kind: 'INVOICE' })).not.toThrow();
    expect(() =>
      assertFiscalLinkage({ kind: 'CREDIT_NOTE', originalDocumentId: 'invoice-1' })
    ).not.toThrow();
    expect(() => assertFiscalLinkage({ kind: 'CREDIT_NOTE' })).toThrow(/original/);
    expect(() => assertFiscalLinkage({ kind: 'DEBIT_NOTE' })).toThrow(/original/);
    expect(() =>
      assertFiscalLinkage({
        kind: 'DEBIT_NOTE',
        originalDocumentId: 'note-1',
        originalKind: 'CREDIT_NOTE',
      })
    ).toThrow(/invoice/);
    expect(() => assertFiscalLinkage({ kind: 'INVOICE', originalDocumentId: 'invoice-1' })).toThrow(
      /cannot link/
    );
  });

  it('marks a full six-year minimum retention window', () => {
    expect(fiscalRetentionUntil(new Date('2026-09-04T00:00:00.000Z')).toISOString()).toBe(
      '2032-09-04T00:00:00.000Z'
    );
  });

  it('omits fiscal receipt fields while off and for sandbox identifiers', () => {
    expect(
      receiptFiscalFields({ mode: undefined, externalReference: null, externalQr: null })
    ).toBe(undefined);
    expect(
      receiptFiscalFields({
        mode: 'SANDBOX',
        externalReference: 'SANDBOX-LOCAL-42',
        externalQr: null,
      })
    ).toBeUndefined();
  });
});
