import { describe, expect, it } from 'vitest';

/**
 * Abbasi Pharmacie release-candidate smoke contract.
 *
 * The stock, sales, regulatory and close implementations land in separate release lanes. This
 * test deliberately talks to the narrow port below rather than importing those sibling branches.
 * Replacing `ReleaseStub` with an HTTP/TRPC adapter turns the same scenario into a deployed smoke
 * without changing the assertions. Keep every command tenant scoped: production adapters must
 * translate `organizationId` into both an explicit predicate and the RLS session setting.
 */
type Capability =
  | 'pharmacy:counter'
  | 'pharmacy:dispense'
  | 'pharmacy:safety'
  | 'pharmacy:catalogue-review'
  | 'pharmacy:day-close';

type Actor = {
  id: string;
  organizationId: string;
  role: 'ADMIN' | 'CASHIER' | 'PHARMACIST' | 'WITNESS';
  grants: Capability[];
  denies?: Capability[];
};

type Lot = { id: string; locationId: string; units: number };
type Audit = {
  organizationId: string;
  actorId: string;
  action: string;
  subjectId: string;
  amountMinor?: number;
};

interface AbbasiReleasePort {
  activatePlaceholderRules(organizationId: string, actor: Actor): Promise<void>;
  configureAi(organizationId: string, actor: Actor, providerSecretPresent: boolean): Promise<void>;
  sellOtc(organizationId: string, actor: Actor, amountMinor: number): Promise<string>;
  dispenseRx(
    organizationId: string,
    cashier: Actor,
    pharmacist: Actor,
    amountMinor: number
  ): Promise<string>;
  chargeKhata(organizationId: string, actor: Actor, amountMinor: number): Promise<string>;
  payKhata(
    organizationId: string,
    actor: Actor,
    chargeId: string,
    amountMinor: number
  ): Promise<void>;
  closeDay(organizationId: string, actor: Actor): Promise<void>;
  recallAndWriteOff(
    organizationId: string,
    actor: Actor,
    witness: Actor,
    lots: Lot[]
  ): Promise<void>;
  snapshot(organizationId: string): Promise<{
    active: boolean;
    aiEnabled: boolean;
    openKhataMinor: number;
    dayClosed: boolean;
    lots: Lot[];
    audits: Audit[];
  }>;
}

const ABBASI_ORG = 'org_abbasi_pharmacie';
const OTHER_ORG = 'org_neighbour_pharmacy';

function can(actor: Actor, capability: Capability) {
  // Mirrors the central authorization contract: DENY wins and sensitive pharmacy grants are
  // exact. In particular, ADMIN is not a wildcard for dispense, safety, or catalogue review.
  return !actor.denies?.includes(capability) && actor.grants.includes(capability);
}

class ReleaseStub implements AbbasiReleasePort {
  private readonly state = new Map<
    string,
    {
      active: boolean;
      aiEnabled: boolean;
      openKhataMinor: number;
      dayClosed: boolean;
      lots: Lot[];
      audits: Audit[];
    }
  >();

  seed(organizationId: string, lots: Lot[]) {
    this.state.set(organizationId, {
      active: false,
      aiEnabled: false,
      openKhataMinor: 0,
      dayClosed: false,
      lots: structuredClone(lots),
      audits: [],
    });
  }

  private org(organizationId: string) {
    const state = this.state.get(organizationId);
    if (!state) throw new Error('TENANT_NOT_FOUND');
    return state;
  }

  private authorize(organizationId: string, actor: Actor, capability: Capability) {
    if (actor.organizationId !== organizationId) throw new Error('CROSS_TENANT');
    if (!can(actor, capability)) throw new Error(`FORBIDDEN:${capability}`);
  }

  private audit(organizationId: string, actor: Actor, action: string, subjectId: string, amountMinor?: number) {
    this.org(organizationId).audits.push({
      organizationId,
      actorId: actor.id,
      action,
      subjectId,
      ...(amountMinor === undefined ? {} : { amountMinor }),
    });
  }

  async activatePlaceholderRules(organizationId: string, actor: Actor) {
    this.authorize(organizationId, actor, 'pharmacy:catalogue-review');
    this.org(organizationId).active = true;
    this.audit(organizationId, actor, 'pharmacy.organization.activate-placeholder-rules', organizationId);
  }

  async configureAi(organizationId: string, actor: Actor, providerSecretPresent: boolean) {
    if (actor.organizationId !== organizationId) throw new Error('CROSS_TENANT');
    if (!providerSecretPresent) {
      this.audit(organizationId, actor, 'pharmacy.ai.enable-denied', 'DevFathom AI');
      throw new Error('AI_PROVIDER_SECRET_REQUIRED');
    }
    this.org(organizationId).aiEnabled = true;
    this.audit(organizationId, actor, 'pharmacy.ai.enable', 'DevFathom AI');
  }

  async sellOtc(organizationId: string, actor: Actor, amountMinor: number) {
    this.authorize(organizationId, actor, 'pharmacy:counter');
    const id = 'sale_otc_abbasi';
    this.audit(organizationId, actor, 'pharmacy.sale.otc', id, amountMinor);
    return id;
  }

  async dispenseRx(organizationId: string, cashier: Actor, pharmacist: Actor, amountMinor: number) {
    this.authorize(organizationId, cashier, 'pharmacy:counter');
    this.authorize(organizationId, pharmacist, 'pharmacy:dispense');
    const id = 'sale_rx_abbasi';
    this.audit(organizationId, pharmacist, 'pharmacy.sale.rx-dispense', id, amountMinor);
    return id;
  }

  async chargeKhata(organizationId: string, actor: Actor, amountMinor: number) {
    this.authorize(organizationId, actor, 'pharmacy:counter');
    const id = 'khata_charge_abbasi';
    this.org(organizationId).openKhataMinor += amountMinor;
    this.audit(organizationId, actor, 'pharmacy.khata.charge', id, amountMinor);
    return id;
  }

  async payKhata(organizationId: string, actor: Actor, chargeId: string, amountMinor: number) {
    this.authorize(organizationId, actor, 'pharmacy:counter');
    this.org(organizationId).openKhataMinor -= amountMinor;
    this.audit(organizationId, actor, 'pharmacy.khata.payment', chargeId, amountMinor);
  }

  async closeDay(organizationId: string, actor: Actor) {
    this.authorize(organizationId, actor, 'pharmacy:day-close');
    if (actor.role !== 'ADMIN') throw new Error('ADMIN_REQUIRED');
    this.org(organizationId).dayClosed = true;
    this.audit(organizationId, actor, 'pharmacy.day-close', organizationId);
  }

  async recallAndWriteOff(organizationId: string, actor: Actor, witness: Actor, lots: Lot[]) {
    this.authorize(organizationId, actor, 'pharmacy:safety');
    this.authorize(organizationId, witness, 'pharmacy:safety');
    if (actor.id === witness.id) throw new Error('DIFFERENT_WITNESS_REQUIRED');
    const state = this.org(organizationId);
    for (const requested of lots) {
      const lot = state.lots.find(
        (candidate) => candidate.id === requested.id && candidate.locationId === requested.locationId
      );
      if (!lot || lot.units !== requested.units) throw new Error('EVERY_LOT_AT_EVERY_LOCATION_REQUIRED');
      lot.units = 0;
      this.audit(organizationId, actor, 'pharmacy.recall.write-off', `${lot.id}:${lot.locationId}`);
    }
  }

  async snapshot(organizationId: string) {
    return structuredClone(this.org(organizationId));
  }
}

function actor(
  id: string,
  role: Actor['role'],
  grants: Capability[],
  organizationId = ABBASI_ORG,
  denies?: Capability[]
): Actor {
  return { id, role, grants, organizationId, denies };
}

describe('Abbasi Pharmacie release path', () => {
  it('smokes activation, OTC, pharmacist-signed Rx, Khata payment, Admin close, and full recall write-off', async () => {
    const port = new ReleaseStub();
    const lots = [
      { id: 'lot-paracetamol', locationId: 'loc-front', units: 12 },
      { id: 'lot-paracetamol', locationId: 'loc-store', units: 24 },
      { id: 'lot-amoxicillin', locationId: 'loc-front', units: 8 },
    ];
    port.seed(ABBASI_ORG, lots);
    port.seed(OTHER_ORG, [{ id: 'lot-neighbour', locationId: 'loc-neighbour', units: 99 }]);

    const admin = actor('abbasi-admin', 'ADMIN', [
      'pharmacy:counter',
      'pharmacy:catalogue-review',
      'pharmacy:day-close',
    ]);
    const cashier = actor('abbasi-cashier', 'CASHIER', ['pharmacy:counter']);
    const pharmacist = actor('abbasi-pharmacist', 'PHARMACIST', [
      'pharmacy:dispense',
      'pharmacy:safety',
    ]);
    const witness = actor('abbasi-witness', 'WITNESS', ['pharmacy:safety']);

    await port.activatePlaceholderRules(ABBASI_ORG, admin);
    const afterActivation = await port.snapshot(ABBASI_ORG);
    expect(afterActivation).toMatchObject({ active: true, aiEnabled: false });

    await expect(port.configureAi(ABBASI_ORG, admin, false)).rejects.toThrow(
      'AI_PROVIDER_SECRET_REQUIRED'
    );
    expect((await port.snapshot(ABBASI_ORG)).aiEnabled).toBe(false);

    await expect(port.dispenseRx(ABBASI_ORG, cashier, admin, 4_500)).rejects.toThrow(
      'FORBIDDEN:pharmacy:dispense'
    );
    await port.sellOtc(ABBASI_ORG, cashier, 1_250);
    await port.dispenseRx(ABBASI_ORG, cashier, pharmacist, 4_500);
    const chargeId = await port.chargeKhata(ABBASI_ORG, cashier, 3_000);
    await port.payKhata(ABBASI_ORG, cashier, chargeId, 3_000);
    await port.closeDay(ABBASI_ORG, admin);
    await port.recallAndWriteOff(ABBASI_ORG, pharmacist, witness, lots);

    const abbasi = await port.snapshot(ABBASI_ORG);
    expect(abbasi).toMatchObject({
      active: true,
      aiEnabled: false,
      openKhataMinor: 0,
      dayClosed: true,
    });
    expect(abbasi.lots).toHaveLength(lots.length);
    expect(abbasi.lots.every((lot) => lot.units === 0)).toBe(true);
    expect(new Set(abbasi.lots.map((lot) => lot.locationId))).toEqual(
      new Set(['loc-front', 'loc-store'])
    );
    expect(abbasi.audits.map(({ action }) => action)).toEqual([
      'pharmacy.organization.activate-placeholder-rules',
      'pharmacy.ai.enable-denied',
      'pharmacy.sale.otc',
      'pharmacy.sale.rx-dispense',
      'pharmacy.khata.charge',
      'pharmacy.khata.payment',
      'pharmacy.day-close',
      'pharmacy.recall.write-off',
      'pharmacy.recall.write-off',
      'pharmacy.recall.write-off',
    ]);
    expect(abbasi.audits.every((entry) => entry.organizationId === ABBASI_ORG)).toBe(true);
    expect(abbasi.audits.find((entry) => entry.action.startsWith('pharmacy.ai'))?.subjectId).toBe(
      'DevFathom AI'
    );
    expect(abbasi.audits.filter((entry) => entry.amountMinor !== undefined)).toHaveLength(4);
    expect(await port.snapshot(OTHER_ORG)).toMatchObject({
      active: false,
      openKhataMinor: 0,
      dayClosed: false,
      lots: [{ units: 99 }],
      audits: [],
    });
  });

  it('keeps explicit DENY, exact grants, tenant boundaries, Admin close, and independent witness fail-closed', async () => {
    const port = new ReleaseStub();
    port.seed(ABBASI_ORG, [{ id: 'lot-1', locationId: 'loc-1', units: 5 }]);
    const deniedPharmacist = actor(
      'denied-pharmacist',
      'PHARMACIST',
      ['pharmacy:dispense'],
      ABBASI_ORG,
      ['pharmacy:dispense']
    );
    const cashier = actor('cashier', 'CASHIER', ['pharmacy:counter']);
    const safety = actor('safety', 'PHARMACIST', ['pharmacy:safety']);

    await expect(port.dispenseRx(ABBASI_ORG, cashier, deniedPharmacist, 100)).rejects.toThrow(
      'FORBIDDEN:pharmacy:dispense'
    );
    await expect(port.closeDay(ABBASI_ORG, cashier)).rejects.toThrow(
      'FORBIDDEN:pharmacy:day-close'
    );
    await expect(
      port.recallAndWriteOff(ABBASI_ORG, safety, safety, [
        { id: 'lot-1', locationId: 'loc-1', units: 5 },
      ])
    ).rejects.toThrow('DIFFERENT_WITNESS_REQUIRED');
    await expect(
      port.sellOtc(
        ABBASI_ORG,
        actor('foreign-cashier', 'CASHIER', ['pharmacy:counter'], OTHER_ORG),
        100
      )
    ).rejects.toThrow('CROSS_TENANT');
    expect((await port.snapshot(ABBASI_ORG)).audits).toEqual([]);
  });
});
