import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { assertValidRule } from '@/lib/restaurant/sop-recurrence';

import { PHARMACY_SOP_ROLE_KEYS } from './sop-adapter';
import {
  PHARMACY_SOP_PACKS,
  PharmacySopRecurrenceError,
  findPharmacySopPack,
  installPharmacySopLibrary,
  pharmacySopPackForTemplateName,
  temperatureLogRecurrence,
} from './sop-library';

const meta = (key: string) => findPharmacySopPack(key)!.pharmacy;

describe('DEV-751 pharmacy SOP pack metadata', () => {
  it('ships nine packs with stable keys and the original install names', () => {
    expect(PHARMACY_SOP_PACKS.map((pack) => pack.key)).toEqual([
      'opening',
      'closing',
      'temperature-log',
      'controlled-counts',
      'expiry-pull',
      'receiving',
      'hygiene',
      'incident-capa',
      'training-attestation',
    ]);
    expect(new Set(PHARMACY_SOP_PACKS.map((pack) => pack.name)).size).toBe(9);
    expect(pharmacySopPackForTemplateName('Pharmacy — controlled counts')?.key).toBe(
      'controlled-counts'
    );
    expect(pharmacySopPackForTemplateName('Front of house — opening')).toBeUndefined();
    expect(findPharmacySopPack('nope')).toBeUndefined();
  });

  it('maps each pack to its owning pharmacy role, never a restaurant role', () => {
    expect(meta('opening').roleKey).toBe('pharmacy-qualified-person');
    expect(meta('closing').roleKey).toBe('pharmacy-qualified-person');
    expect(meta('controlled-counts').roleKey).toBe('pharmacy-qualified-person');
    for (const key of ['temperature-log', 'expiry-pull', 'receiving', 'hygiene']) {
      expect(meta(key).roleKey).toBe('pharmacy-assistant');
    }
    expect(meta('incident-capa').roleKey).toBe('pharmacy-manager');
    expect(meta('training-attestation')).toMatchObject({
      trigger: 'ASSIGNED',
      assigneeTarget: 'PERSON',
    });
    for (const pack of PHARMACY_SOP_PACKS) {
      expect(PHARMACY_SOP_ROLE_KEYS).toContain(pack.defaultJobRoleKey);
      expect(pack.defaultJobRoleKey).toBe(pack.pharmacy.roleKey);
      for (const verifier of pack.pharmacy.verifierRoleKeys) {
        expect(PHARMACY_SOP_ROLE_KEYS).toContain(verifier);
      }
    }
  });

  it('lets only the qualified person verify controlled counts', () => {
    expect(meta('controlled-counts').verifierRoleKeys).toEqual(['pharmacy-qualified-person']);
    expect(meta('opening').verifierRoleKeys).toContain('pharmacy-manager');
  });

  it('assigns triggers and schedules per pack', () => {
    expect(meta('opening')).toMatchObject({ trigger: 'SHIFT' });
    expect(meta('opening').suggestedRecurrence.frequency).toBe('DAILY');
    expect(meta('closing').suggestedRecurrence.frequency).toBe('DAILY');
    expect(meta('hygiene').suggestedRecurrence.frequency).toBe('DAILY');
    expect(meta('temperature-log')).toMatchObject({ trigger: 'INTERVAL' });
    expect(meta('temperature-log').suggestedRecurrence).toMatchObject({
      frequency: 'INTERVAL',
      interval: 240,
      dueTimeMinutes: meta('opening').suggestedRecurrence.dueTimeMinutes,
      intervalEndTimeMinutes: meta('closing').suggestedRecurrence.dueTimeMinutes,
    });
    expect(meta('controlled-counts').suggestedRecurrence.frequency).toBe('WEEKLY');
    expect(meta('expiry-pull').suggestedRecurrence.frequency).toBe('WEEKLY');
    for (const key of ['receiving', 'incident-capa']) {
      expect(meta(key).trigger).toBe('EVENT');
      expect(meta(key).suggestedRecurrence.frequency).toBe('ONCE');
    }
    expect(meta('training-attestation').suggestedRecurrence.frequency).toBe('ONCE');
  });

  it('keeps every suggested recurrence valid for the shared recurrence engine', () => {
    for (const pack of PHARMACY_SOP_PACKS) {
      for (const rule of [pack.pharmacy.suggestedRecurrence, pack.suggestedRecurrence]) {
        expect(() =>
          assertValidRule({
            ...rule,
            intervalEndTimeMinutes:
              'intervalEndTimeMinutes' in rule ? rule.intervalEndTimeMinutes : null,
            startDate: '2026-11-02',
            endDate: null,
          })
        ).not.toThrow();
      }
      // The shared SopPack shape has no INTERVAL; the engine-facing fallback stays valid.
      expect(pack.suggestedRecurrence.frequency).not.toBe('INTERVAL');
    }
  });

  it('marks steps that must link an existing pharmacy record', () => {
    const recordTypes = (key: string) =>
      findPharmacySopPack(key)!
        .steps.map((step) => step.requiredRecordType)
        .filter(Boolean);
    expect(recordTypes('temperature-log')).toEqual(['TEMPERATURE_LOG', 'TEMPERATURE_LOG']);
    expect(recordTypes('controlled-counts')).toEqual(['CONTROLLED_REGISTER_ENTRY']);
    expect(recordTypes('receiving')).toEqual(['GOODS_RECEIPT']);
    expect(recordTypes('expiry-pull')).toEqual(['MANUFACTURING_BATCH']);
    const excursion = findPharmacySopPack('temperature-log')!.steps.at(-1)!;
    expect(excursion.title).toMatch(/excursion/i);
    expect(excursion.requiresNote).toBe(true);
    expect(findPharmacySopPack('training-attestation')!.steps.at(-1)).toMatchObject({
      requiresSignature: true,
    });
  });

  it('gives no dosing advice and claims no regulatory compliance', () => {
    const text = JSON.stringify(PHARMACY_SOP_PACKS).toLowerCase();
    for (const banned of ['dose', 'dosing', 'dosage', 'compliant', 'compliance', 'mg ']) {
      expect(text).not.toContain(banned);
    }
  });
});

describe('temperatureLogRecurrence', () => {
  it('builds a configurable interval round between opening and closing', () => {
    expect(
      temperatureLogRecurrence({
        openingMinutes: 9 * 60,
        closingMinutes: 21 * 60,
        everyMinutes: 120,
        daysOfWeek: [6, 1, 1],
      })
    ).toEqual({
      frequency: 'INTERVAL',
      interval: 120,
      daysOfWeek: [1, 6],
      monthDay: null,
      dueTimeMinutes: 540,
      intervalEndTimeMinutes: 1260,
      windowMinutes: 120,
      graceMinutes: 30,
    });
  });

  it('refuses a round that cannot run', () => {
    expect(() => temperatureLogRecurrence({ everyMinutes: 10 })).toThrow(
      PharmacySopRecurrenceError
    );
    expect(() => temperatureLogRecurrence({ openingMinutes: 600, closingMinutes: 600 })).toThrow(
      PharmacySopRecurrenceError
    );
    expect(() => temperatureLogRecurrence({ daysOfWeek: [] })).toThrow(PharmacySopRecurrenceError);
  });
});

/**
 * A tiny in-memory template store that models the advisory lock: a second
 * transaction waits until the first commits, exactly as pg_advisory_xact_lock
 * serializes two installs for one organization.
 */
function libraryDatabase() {
  const templates: { id: string; name: string; versions: { id: string }[] }[] = [];
  let lockTail: Promise<void> = Promise.resolve();
  const lockCalls: string[] = [];
  const assignmentCreate = vi.fn();

  function txClient(): ScopedDb {
    return {
      $queryRaw: vi.fn(async (sql: { strings?: readonly string[] }) => {
        lockCalls.push((sql.strings ?? []).join('?'));
        return [];
      }),
      restaurantSopTemplate: {
        findFirst: vi.fn(async ({ where }: { where: { name: string } }) => {
          await Promise.resolve();
          return templates.find((template) => template.name === where.name) ?? null;
        }),
        create: vi.fn(async ({ data }: { data: { name: string } }) => {
          await Promise.resolve();
          const id = `tpl_${templates.length + 1}`;
          const row = { id, name: data.name, versions: [{ id: `${id}_v1` }] };
          templates.push(row);
          return row;
        }),
      },
      restaurantSopAssignment: { create: assignmentCreate, createMany: assignmentCreate },
    } as unknown as ScopedDb;
  }

  const $transaction = vi.fn(async (work: (tx: ScopedDb) => Promise<unknown>) => {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      return await work(txClient());
    } finally {
      release();
    }
  });
  return {
    db: { $transaction } as unknown as ScopedDb,
    templates,
    lockCalls,
    $transaction,
    assignmentCreate,
  };
}

describe('installPharmacySopLibrary', () => {
  it('installs every pack once and is a no-op the second time', async () => {
    const { db, templates } = libraryDatabase();
    const first = await installPharmacySopLibrary(db);
    const second = await installPharmacySopLibrary(db);
    expect(first.every((result) => result.created)).toBe(true);
    expect(second.every((result) => !result.created)).toBe(true);
    expect(templates).toHaveLength(PHARMACY_SOP_PACKS.length);
    expect(second.map((result) => result.templateId)).toEqual(
      first.map((result) => result.templateId)
    );
  });

  it('serializes concurrent installs behind a per-organization advisory lock', async () => {
    const { db, templates, lockCalls, $transaction } = libraryDatabase();
    const [left, right] = await Promise.all([
      installPharmacySopLibrary(db),
      installPharmacySopLibrary(db),
    ]);
    expect($transaction).toHaveBeenCalledTimes(2);
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls[0]).toContain('pg_advisory_xact_lock');
    expect(lockCalls[0]).toContain('pharmacy-sop-library:');
    expect(templates).toHaveLength(PHARMACY_SOP_PACKS.length);
    expect([...left, ...right].filter((result) => result.created)).toHaveLength(
      PHARMACY_SOP_PACKS.length
    );
  });

  it('creates templates only — no assignment or schedule', async () => {
    const { db, assignmentCreate } = libraryDatabase();
    const results = await installPharmacySopLibrary(db);
    expect(results).toHaveLength(9);
    expect(assignmentCreate).not.toHaveBeenCalled();
    // The in-memory client exposes no occurrence or job-role delegate, so any
    // attempt to schedule or grant would have thrown.
  });
});
