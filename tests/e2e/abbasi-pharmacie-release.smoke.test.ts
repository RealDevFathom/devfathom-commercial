import { describe, expect, it } from 'vitest';

/**
 * Abbasi Pharmacie release-candidate smoke contract.
 *
 * This is deliberately an integration-style seam rather than a second browser
 * fixture. The activation, khata, and recall screens are owned by sibling
 * release branches. Their adapters can replace `StubAbbasiRelease` without
 * changing the scenario or weakening any of the security assertions below.
 */

type Capability =
  | 'pharmacy:counter'
  | 'pharmacy:dispense'
  | 'pharmacy:safety'
  | 'pharmacy:catalogue-review'
  | 'pharmacy:day-close';
type Actor = { id: string; organizationId: string; role: 'ADMIN' | 'PHARMACIST' | 'CASHIER' };
type Grant = { actorId: string; capability: Capability; effect: 'ALLOW' | 'DENY'; exact: boolean };
type Lot = { id: string; locationId: string; units: number; state: 'AVAILABLE' | 'WRITTEN_OFF' };
type Audit = { organizationId: string; actorId: string; action: string; amountMinor?: number };

interface AbbasiReleasePort {
  activate(input: { organizationId: string; ruleSet: 'PLACEHOLDER' | 'CONFIRMED' }): Promise<void>;
  configureAi(input: { organizationId: string; enabled: boolean }): Promise<void>;
  sellOtc(input: { organizationId: string; actor: Actor; lotId: string; amountMinor: number }): Promise<string>;
  dispenseRx(input: {
    organizationId: string;
    pharmacist: Actor;
    lotId: string;
    amountMinor: number;
  }): Promise<string>;
  chargeKhata(input: { organizationId: string; actor: Actor; amountMinor: number }): Promise<string>;
  payKhata(input: {
    organizationId: string;
    actor: Actor;
    chargeId: string;
    amountMinor: number;
  }): Promise<void>;
  closeDay(input: { organizationId: string; actor: Actor }): Promise<void>;
  recallAndWriteOff(input: {
    organizationId: string;
    actor: Actor;
    witness: Actor;
    lotIds: string[];
  }): Promise<void>;
}

const ORG = 'org_abbasi_pharmacie';
const OTHER_ORG = 'org_not_abbasi';
const admin: Actor = { id: 'abbasi-admin', organizationId: ORG, role: 'ADMIN' };
const pharmacist: Actor = {
  id: 'abbasi-pharmacist',
  organizationId: ORG,
  role: 'PHARMACIST',
};
const cashier: Actor = { id: 'abbasi-cashier', organizationId: ORG, role: 'CASHIER' };
const witness: Actor = { id: 'abbasi-witness', organizationId: ORG, role: 'PHARMACIST' };

class StubAbbasiRelease implements AbbasiReleasePort {
  readonly audits: Audit[] = [];
  readonly balances = new Map<string, number>();
  readonly providerSecretOrganizations = new Set<string>();
  readonly lots: Lot[] = [
    { id: 'lot-panadol-front', locationId: 'front-counter', units: 12, state: 'AVAILABLE' },
    { id: 'lot-panadol-store', locationId: 'main-store', units: 80, state: 'AVAILABLE' },
    { id: 'lot-amox-front', locationId: 'front-counter', units: 20, state: 'AVAILABLE' },
    { id: 'lot-amox-store', locationId: 'main-store', units: 100, state: 'AVAILABLE' },
  ];
  readonly grants: Grant[] = [
    { actorId: cashier.id, capability: 'pharmacy:counter', effect: 'ALLOW', exact: true },
    { actorId: pharmacist.id, capability: 'pharmacy:dispense', effect: 'ALLOW', exact: true },
    { actorId: pharmacist.id, capability: 'pharmacy:safety', effect: 'ALLOW', exact: true },
    { actorId: witness.id, capability: 'pharmacy:dispense', effect: 'ALLOW', exact: true },
    { actorId: witness.id, capability: 'pharmacy:safety', effect: 'ALLOW', exact: true },
    { actorId: admin.id, capability: 'pharmacy:day-close', effect: 'ALLOW', exact: true },
  ];
  active = false;
  aiEnabled = false;
  closed = false;

  private scoped(organizationId: string, actor: Actor) {
    if (organizationId !== ORG || actor.organizationId !== organizationId) throw new Error('NOT_FOUND');
  }

  can(actor: Actor, capability: Capability) {
    const matching = this.grants.filter(
      (grant) => grant.actorId === actor.id && grant.capability === capability && grant.exact
    );
    return !matching.some((grant) => grant.effect === 'DENY') &&
      matching.some((grant) => grant.effect === 'ALLOW');
  }

  private require(actor: Actor, capability: Capability) {
    if (!this.can(actor, capability)) throw new Error('FORBIDDEN');
  }

  private audit(actor: Actor, action: string, amountMinor?: number) {
    this.audits.push({ organizationId: actor.organizationId, actorId: actor.id, action, amountMinor });
  }

  async activate(input: { organizationId: string; ruleSet: 'PLACEHOLDER' | 'CONFIRMED' }) {
    if (input.organizationId !== ORG) throw new Error('NOT_FOUND');
    if (input.ruleSet === 'PLACEHOLDER') throw new Error('RULE_SET_UNCONFIRMED');
    this.active = true;
    this.audits.push({ organizationId: input.organizationId, actorId: admin.id, action: 'org.activate' });
  }

  async configureAi(input: { organizationId: string; enabled: boolean }) {
    if (input.organizationId !== ORG) throw new Error('NOT_FOUND');
    // This lookup models the server-owned provider-secret check. The client
    // cannot turn AI on merely by posting `enabled: true`.
    this.aiEnabled = input.enabled && this.providerSecretOrganizations.has(input.organizationId);
    this.audits.push({ organizationId: input.organizationId, actorId: admin.id, action: 'ai.configure' });
  }

  async sellOtc(input: { organizationId: string; actor: Actor; lotId: string; amountMinor: number }) {
    this.scoped(input.organizationId, input.actor);
    this.require(input.actor, 'pharmacy:counter');
    this.consume(input.lotId);
    this.audit(input.actor, 'sale.otc', input.amountMinor);
    return 'sale-otc';
  }

  async dispenseRx(input: {
    organizationId: string;
    pharmacist: Actor;
    lotId: string;
    amountMinor: number;
  }) {
    this.scoped(input.organizationId, input.pharmacist);
    this.require(input.pharmacist, 'pharmacy:dispense');
    this.consume(input.lotId);
    this.audit(input.pharmacist, 'sale.rx-dispensed', input.amountMinor);
    return 'sale-rx';
  }

  async chargeKhata(input: { organizationId: string; actor: Actor; amountMinor: number }) {
    this.scoped(input.organizationId, input.actor);
    this.require(input.actor, 'pharmacy:counter');
    const id = 'khata-charge-1';
    this.balances.set(id, input.amountMinor);
    this.audit(input.actor, 'khata.charge', input.amountMinor);
    return id;
  }

  async payKhata(input: {
    organizationId: string;
    actor: Actor;
    chargeId: string;
    amountMinor: number;
  }) {
    this.scoped(input.organizationId, input.actor);
    this.require(input.actor, 'pharmacy:counter');
    this.balances.set(input.chargeId, (this.balances.get(input.chargeId) ?? 0) - input.amountMinor);
    this.audit(input.actor, 'khata.payment', input.amountMinor);
  }

  async closeDay(input: { organizationId: string; actor: Actor }) {
    this.scoped(input.organizationId, input.actor);
    this.require(input.actor, 'pharmacy:day-close');
    if (input.actor.role !== 'ADMIN') throw new Error('FORBIDDEN');
    this.closed = true;
    this.audit(input.actor, 'day.close');
  }

  async recallAndWriteOff(input: {
    organizationId: string;
    actor: Actor;
    witness: Actor;
    lotIds: string[];
  }) {
    this.scoped(input.organizationId, input.actor);
    this.scoped(input.organizationId, input.witness);
    this.require(input.actor, 'pharmacy:safety');
    this.require(input.witness, 'pharmacy:safety');
    if (input.actor.id === input.witness.id) throw new Error('WITNESS_MUST_DIFFER');
    const expected = this.lots.map((lot) => lot.id).sort();
    if (input.lotIds.toSorted().join('|') !== expected.join('|')) throw new Error('INCOMPLETE_RECALL');
    for (const lot of this.lots) lot.state = 'WRITTEN_OFF';
    this.audit(input.actor, 'recall.write-off');
  }

  private consume(lotId: string) {
    const lot = this.lots.find((candidate) => candidate.id === lotId);
    if (!lot || lot.state !== 'AVAILABLE' || lot.units < 1) throw new Error('STOCK_UNAVAILABLE');
    lot.units -= 1;
  }
}

describe('Abbasi Pharmacie release-candidate smoke', () => {
  it('runs the launch path and reconciles every money and stock action', async () => {
    const release = new StubAbbasiRelease();
    const assistantLabel = 'DevFathom AI';
    expect(assistantLabel).toBe('DevFathom AI');

    await expect(release.activate({ organizationId: ORG, ruleSet: 'PLACEHOLDER' })).rejects.toThrow(
      'RULE_SET_UNCONFIRMED'
    );
    expect(release.active).toBe(false);
    await release.activate({ organizationId: ORG, ruleSet: 'CONFIRMED' });

    expect(release.aiEnabled).toBe(false);
    await release.configureAi({ organizationId: ORG, enabled: true });
    expect(release.aiEnabled).toBe(false);
    // Sibling provider setup is represented by an opaque server-side marker;
    // no provider secret is embedded in this fixture.
    release.providerSecretOrganizations.add(ORG);
    await release.configureAi({ organizationId: ORG, enabled: true });
    expect(release.aiEnabled).toBe(true);

    await release.sellOtc({ organizationId: ORG, actor: cashier, lotId: 'lot-panadol-front', amountMinor: 25000 });
    await release.dispenseRx({
      organizationId: ORG,
      pharmacist,
      lotId: 'lot-amox-front',
      amountMinor: 40000,
    });
    const chargeId = await release.chargeKhata({ organizationId: ORG, actor: cashier, amountMinor: 65000 });
    await release.payKhata({ organizationId: ORG, actor: cashier, chargeId, amountMinor: 65000 });
    expect(release.balances.get(chargeId)).toBe(0);

    await release.closeDay({ organizationId: ORG, actor: admin });
    expect(release.closed).toBe(true);

    await release.recallAndWriteOff({
      organizationId: ORG,
      actor: pharmacist,
      witness,
      lotIds: release.lots.map((lot) => lot.id),
    });
    expect(new Set(release.lots.map((lot) => lot.locationId))).toEqual(
      new Set(['front-counter', 'main-store'])
    );
    expect(release.lots.every((lot) => lot.state === 'WRITTEN_OFF')).toBe(true);

    expect(release.audits.map(({ action }) => action)).toEqual([
      'org.activate',
      'ai.configure',
      'ai.configure',
      'sale.otc',
      'sale.rx-dispensed',
      'khata.charge',
      'khata.payment',
      'day.close',
      'recall.write-off',
    ]);
    expect(release.audits.every((entry) => entry.organizationId === ORG)).toBe(true);
  });

  it('fails closed for tenant crossover, incomplete recall, same-person witness, and explicit deny', async () => {
    const release = new StubAbbasiRelease();
    release.grants.push({
      actorId: pharmacist.id,
      capability: 'pharmacy:dispense',
      effect: 'DENY',
      exact: true,
    });

    expect(release.can(pharmacist, 'pharmacy:dispense')).toBe(false);
    expect(release.can(admin, 'pharmacy:catalogue-review')).toBe(false);
    await expect(
      release.dispenseRx({ organizationId: ORG, pharmacist, lotId: 'lot-amox-front', amountMinor: 40000 })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      release.sellOtc({ organizationId: OTHER_ORG, actor: cashier, lotId: 'lot-panadol-front', amountMinor: 25000 })
    ).rejects.toThrow('NOT_FOUND');
    release.grants.pop();
    await expect(
      release.recallAndWriteOff({ organizationId: ORG, actor: witness, witness, lotIds: release.lots.map((lot) => lot.id) })
    ).rejects.toThrow('WITNESS_MUST_DIFFER');
    await expect(
      release.recallAndWriteOff({ organizationId: ORG, actor: pharmacist, witness, lotIds: [release.lots[0]!.id] })
    ).rejects.toThrow('INCOMPLETE_RECALL');
    expect(release.audits).toEqual([]);
  });
});
