import { describe, expect, it } from 'vitest';

import { evidenceSnapshotAdapter } from '@/lib/cameras/evidence';
import {
  cameraGatewayPublicState,
  resolveCameraGatewayRuntime,
  type CameraGatewayRuntime,
} from '@/lib/cameras/camera-gateway-runtime';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { RawPrintValidationError } from '@/lib/restaurant/printing/contract';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';
import { parseGs1DataMatrix, gtinCheckDigit } from '@/lib/pharmacy/gs1-datamatrix';
import { MANUAL_TENDER_TYPES } from '@/lib/pharmacy/manual-payments';
import {
  counterReceiptTotals,
  type CounterReceipt,
  type CounterReceiptLine,
} from '@/lib/pharmacy/counter-receipt';
import { buildPharmacyReceiptEscPosJob } from '@/lib/pharmacy/receipt-print';

// DEV-744: pins the code facts that docs/pharmacy/hardware-acceptance-matrix.md
// relies on. These are simulator, generated-file and parser tests. None of them
// touches, or proves anything about, a physical device.

const GS = '\u001d';
const NOW = new Date('2026-11-04T00:00:00.000Z');
const GTIN = `${'0896123456789'}${gtinCheckDigit('0896123456789')}`;
const NO_TAX = { ntn: null, strn: null };

function line(overrides: Partial<CounterReceiptLine> = {}): CounterReceiptLine {
  return {
    saleLineId: 'line-1',
    identityStatus: 'ISSUED',
    medicineName: 'Panadol',
    strength: '500 mg',
    presentation: 'Tablet',
    batchNumber: 'B-2201',
    expiresAt: '2027-04-30T00:00:00.000Z',
    saleUnit: 'STRIP',
    quantity: 2,
    canonicalUnits: 20,
    unitPriceMinor: 2_500,
    discountMinor: 0,
    lineTotalMinor: 5_000,
    ...overrides,
  };
}

function receipt(lines: CounterReceiptLine[] = [line()]): CounterReceipt {
  const tenders = [{ tenderId: 't-1', type: 'CASH', amountMinor: 5_000, changeGivenMinor: 0 }];
  return {
    saleId: 'sale-1',
    receiptNumber: 12,
    branchName: 'Test Branch',
    businessDate: '2026-11-04',
    completedAt: '2026-11-04T09:00:00.000Z',
    currency: 'PKR',
    lines,
    tenders,
    totals: counterReceiptTotals({ lines, tenders }),
  };
}

const escOptions = (paperWidth: 58 | 80, reprint = false) => ({
  layout: { ...DEFAULT_RECEIPT_LAYOUT, paperWidth },
  taxIdentity: NO_TAX,
  reprint,
});

function decode(job: ReturnType<typeof buildPharmacyReceiptEscPosJob>): number[] {
  return [...Buffer.from(job.escPos.data, 'base64')];
}

describe('cameras: no real device path exists for Pharmacy (SIMULATOR only)', () => {
  it('is unavailable unless a mode is configured', () => {
    const runtime = resolveCameraGatewayRuntime({});
    expect(runtime).toEqual({ available: false, mode: 'unavailable', adapter: null });
    expect(cameraGatewayPublicState(runtime)).toEqual({
      available: false,
      mode: 'unavailable',
      reason: 'not-configured',
    });
  });

  it('refuses the simulator outside development and test', () => {
    expect(() =>
      resolveCameraGatewayRuntime({ CAMERA_GATEWAY_MODE: 'simulated', NODE_ENV: 'production' })
    ).toThrow();
    expect(
      resolveCameraGatewayRuntime({ CAMERA_GATEWAY_MODE: 'simulated', NODE_ENV: 'test' }).mode
    ).toBe('simulated');
  });

  it('fails closed on an unknown mode and on a real gateway with no bindings', () => {
    expect(() => resolveCameraGatewayRuntime({ CAMERA_GATEWAY_MODE: 'dahua' })).toThrow();
    expect(() =>
      resolveCameraGatewayRuntime({ CAMERA_GATEWAY_MODE: 'mediamtx', CAMERA_MEDIAMTX_BINDINGS: '' })
    ).toThrow();
  });

  it('offers a still-image adapter only to the simulator, never to a real gateway', () => {
    expect(evidenceSnapshotAdapter({ available: false, mode: 'unavailable', adapter: null })).toBe(
      null
    );
    const simulated = resolveCameraGatewayRuntime({
      CAMERA_GATEWAY_MODE: 'simulated',
      NODE_ENV: 'test',
    });
    expect(evidenceSnapshotAdapter(simulated)).toBe(
      simulated.available ? simulated.adapter : undefined
    );

    const unsupported = async (): Promise<never> => {
      throw new Error('unsupported');
    };
    const mediamtx = {
      available: true,
      mode: 'mediamtx',
      transport: {},
      adapter: { getSnapshot: unsupported },
    } as unknown as CameraGatewayRuntime;
    expect(evidenceSnapshotAdapter(mediamtx)).toBe(null);
  });
});

describe('thermal printing: generated ESC/POS bytes, never dispatched', () => {
  it('produces initialise ... full-cut bytes and a matching byte count', () => {
    const job = buildPharmacyReceiptEscPosJob(receipt(), 'en', escOptions(80));
    const bytes = decode(job);
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(bytes.slice(-3)).toEqual([0x1d, 0x56, 0x00]);
    expect(job.escPos.byteCount).toBe(bytes.length);
    expect(job.escPos.encoding).toBe('base64');
    expect(job).not.toHaveProperty('delivered');
    expect(job).not.toHaveProperty('printed');
  });

  it.each([
    [58, 32],
    [80, 48],
  ] as const)('wraps a %i mm receipt within %i columns', (paperWidth, columns) => {
    const long = line({
      medicineName: 'Amoxicillin Clavulanic Acid Extended Release Suspension',
      strength: '625 mg / 5 ml',
    });
    const job = buildPharmacyReceiptEscPosJob(receipt([long]), 'en', escOptions(paperWidth));
    const text = Buffer.from(job.escPos.data, 'base64').subarray(8, -3).toString('ascii');
    expect(text).toContain('Amoxicillin');
    const longest = Math.max(...text.split('\n').map((row) => row.length));
    expect(job.paperWidth).toBe(paperWidth);
    expect(longest).toBeLessThanOrEqual(columns);
  });

  it('emits printable ASCII only in the body', () => {
    const bytes = decode(buildPharmacyReceiptEscPosJob(receipt(), 'en', escOptions(80)));
    const body = bytes.slice(8, -3);
    expect(body.every((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e))).toBe(true);
  });

  it('refuses Urdu on the raw path and points to the browser/OS fallback', () => {
    try {
      buildPharmacyReceiptEscPosJob(receipt(), 'ur', escOptions(80));
      expect.unreachable('Urdu must not reach the raw printer path');
    } catch (error) {
      expect(error).toBeInstanceOf(RawPrintValidationError);
      expect((error as RawPrintValidationError).code).toBe('UNSUPPORTED_PRINT_TEXT');
      expect((error as RawPrintValidationError).fallback).toBe('BROWSER_OS');
    }
  });

  it('refuses non-ASCII medicine names on the raw path instead of printing garbage', () => {
    const urduName = receipt([line({ medicineName: 'پیناڈول' })]);
    // Sanity: an ASCII issued name does reach the paper, so the refusal below is meaningful.
    expect(
      Buffer.from(
        buildPharmacyReceiptEscPosJob(receipt(), 'en', escOptions(80)).escPos.data,
        'base64'
      ).toString('ascii')
    ).toContain('Panadol');
    expect(() => buildPharmacyReceiptEscPosJob(urduName, 'en', escOptions(80))).toThrow(
      RawPrintValidationError
    );
  });

  it('marks a reprint only when the caller asks (client-supplied flag, see DEV-195)', () => {
    const original = Buffer.from(
      buildPharmacyReceiptEscPosJob(receipt(), 'en', escOptions(80, false)).escPos.data,
      'base64'
    ).toString('ascii');
    const reprint = Buffer.from(
      buildPharmacyReceiptEscPosJob(receipt(), 'en', escOptions(80, true)).escPos.data,
      'base64'
    ).toString('ascii');
    expect(original).not.toContain('REPRINT');
    expect(reprint).toContain('REPRINT - not a new sale');
  });

  it('cannot render a receipt that has not been issued a number', () => {
    expect(() =>
      buildPharmacyReceiptEscPosJob({ ...receipt(), receiptNumber: null }, 'en', escOptions(80))
    ).toThrow();
  });

  it('renders the same bytes for the same job (no hidden state or time)', () => {
    const job = buildPharmacyReceiptEscPosJob(receipt(), 'en', escOptions(58));
    expect([...renderEscPos(job.document)]).toEqual(decode(job));
  });
});

describe('scanners: keyboard-wedge text into the GS1 parser', () => {
  const body = `01${GTIN}17270430${'10'}B2201${GS}21A3F09C1E77B2`;

  it('parses with the AIM identifier and a real group separator', () => {
    const result = parseGs1DataMatrix(`]d2${body}`, NOW);
    expect(result).toMatchObject({
      kind: 'parsed',
      fields: { gtin: GTIN, batch: 'B2201', serial: 'A3F09C1E77B2' },
    });
  });

  it('accepts separators that a scanner profile substitutes for GS', () => {
    for (const substitute of ['|', '~', '<GS>']) {
      const result = parseGs1DataMatrix(`]d2${body.replace(GS, substitute)}`, NOW);
      expect(result.kind, substitute).toBe('parsed');
    }
  });

  it('recognises a raw element string when no AIM identifier is sent', () => {
    expect(parseGs1DataMatrix(body, NOW).kind).toBe('parsed');
  });

  it('rejects, rather than guesses, a scan whose GS character was dropped', () => {
    // A wedge that swallows 0x1D glues the batch to the serial AI.
    const dropped = `]d2${body.replace(GS, '')}`;
    expect(parseGs1DataMatrix(dropped, NOW).kind).not.toBe('parsed');
  });

  it('does not treat a legacy EAN-13 as GS1', () => {
    expect(parseGs1DataMatrix('8961234567894', NOW).kind).toBe('not-gs1');
  });
});

describe('card terminals: only manual tenders exist, none is a terminal integration', () => {
  it('limits manual received-externally tenders to the three named wallets', () => {
    expect([...MANUAL_TENDER_TYPES]).toEqual(['RAAST', 'JAZZCASH', 'EASYPAISA']);
    expect(MANUAL_TENDER_TYPES).not.toContain('CARD');
  });
});
