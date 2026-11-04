/**
 * DEV-753 — the owner switch for supplier compliance checks, as the register shows it.
 *
 * Pins the rules that make the switch truthful: the warning and its acknowledgement
 * come before turning the checks off, only the owner gets a control, staff see when
 * the checks are off, and a supplier nobody checked is never shown as verified.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));

import { SUPPLIER_COMPLIANCE_WARNING } from '@/lib/pharmacy/supplier-compliance';
import type { SupplierSummary } from '@/lib/pharmacy/purchasing-console';
import { PurchasingOutcomeScope } from '../_components/action-outcomes';
import { LicenceBadge, supplierOptions } from '../_components/form-controls';
import {
  SupplierComplianceSkipList,
  SupplierCompliancePanel,
  SupplierPolicyStanding,
} from './_components/supplier-compliance-panel';

type Read = Parameters<typeof SupplierCompliancePanel>[0]['read'];

function read(overrides: { checksEnabled: boolean; canManage: boolean; version?: number }): Read {
  return {
    policy: {
      checksEnabled: overrides.checksEnabled,
      version: overrides.version ?? (overrides.checksEnabled ? 0 : 1),
      source: overrides.checksEnabled && !overrides.version ? 'DEFAULT' : 'STORED',
      updatedAt: overrides.checksEnabled ? null : new Date('2026-11-04T08:00:00.000Z'),
      updatedByName: overrides.checksEnabled ? null : 'Saba Owner',
    },
    canManage: overrides.canManage,
    warningVersion: SUPPLIER_COMPLIANCE_WARNING.version,
  };
}

const onSetPolicy = vi.fn(async () => '/pharmacy/purchasing/suppliers');

function panel(props: Partial<Parameters<typeof SupplierCompliancePanel>[0]>) {
  return render(
    <PurchasingOutcomeScope>
      <SupplierCompliancePanel
        history={null}
        notice={null}
        onSetPolicy={onSetPolicy}
        read={read({ checksEnabled: true, canManage: false })}
        {...props}
      />
    </PurchasingOutcomeScope>
  );
}

function supplier(overrides: Partial<SupplierSummary>): SupplierSummary {
  return {
    id: 'sup',
    name: 'Karachi Distributors',
    legalName: null,
    authorized: false,
    active: true,
    serviceArea: null,
    contactName: null,
    contactPhone: null,
    paymentTermsDays: 0,
    creditLimitMinor: 0,
    eligibility: { orderable: false, reason: 'NOT_AUTHORIZED' },
    governingLicence: null,
    licences: [],
    compliance: { checked: true, policyVersion: 0, licenceStatus: 'NONE' },
    ...overrides,
  };
}

describe('DEV-753 owner panel', () => {
  it('shows the owner the full warning and a required acknowledgement before turning checks off', () => {
    panel({ read: read({ checksEnabled: true, canManage: true }) });
    const note = screen.getByRole('note');
    expect(within(note).getByText(SUPPLIER_COMPLIANCE_WARNING.title)).toBeInTheDocument();
    for (const paragraph of SUPPLIER_COMPLIANCE_WARNING.paragraphs) {
      expect(within(note).getByText(paragraph)).toBeInTheDocument();
    }
    // Named by both its field label and the exact sentence the owner agrees to.
    const acknowledgement = screen.getByRole('checkbox', {
      name: new RegExp(
        SUPPLIER_COMPLIANCE_WARNING.acknowledgement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      ),
    });
    expect(acknowledgement).toBeRequired();
    expect(acknowledgement).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Turn supplier checks off' })).toBeInTheDocument();
    // The form carries the version it was rendered from and the warning version agreed to.
    const form = screen.getByRole('button', { name: 'Turn supplier checks off' }).closest('form')!;
    const data = new FormData(form);
    expect(data.get('checksEnabled')).toBe('false');
    expect(data.get('expectedVersion')).toBe('0');
    expect(data.get('warningVersion')).toBe(SUPPLIER_COMPLIANCE_WARNING.version);
  });

  it('keeps the turn-off form collapsed so the register stays above the fold', () => {
    panel({ read: read({ checksEnabled: true, canManage: true }) });
    const details = screen.getByText('Turn supplier checks off…').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByRole('note')).toBeInTheDocument();
  });

  it('reopens the form when the server sends the owner back to the acknowledgement', () => {
    panel({
      read: read({ checksEnabled: true, canManage: true }),
      notice: {
        message: 'Tick the acknowledgement before turning supplier checks off.',
        kind: 'error',
        outcome: 'rejected',
        field: 'acknowledged',
      },
    });
    expect(screen.getByText('Turn supplier checks off…').closest('details')).toHaveAttribute(
      'open'
    );
  });

  it('offers no change while the stored setting cannot be read (enforced)', () => {
    const failClosed = read({ checksEnabled: true, canManage: true });
    panel({ read: { ...failClosed!, policy: { ...failClosed!.policy, source: 'FAIL_CLOSED' } } });
    expect(screen.getByText(/could not be read, so the checks are enforced/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Turn supplier checks off…')).toBeNull();
  });

  it('never claims the switch makes unlicensed supply lawful', () => {
    const text = [
      SUPPLIER_COMPLIANCE_WARNING.title,
      ...SUPPLIER_COMPLIANCE_WARNING.paragraphs,
      SUPPLIER_COMPLIANCE_WARNING.acknowledgement,
    ].join(' ');
    expect(text).toMatch(/does not remove any legal obligation/);
    expect(text).toMatch(/remain responsible/);
    expect(text).not.toMatch(/lawful|legal to buy|exempt/i);
  });

  it('lets the owner turn the checks back on and shows who turned them off, with history', () => {
    panel({
      read: read({ checksEnabled: false, canManage: true, version: 1 }),
      history: [
        {
          id: 'audit_1',
          oldValue: true,
          newValue: false,
          policyVersion: 1,
          acknowledgement: `${SUPPLIER_COMPLIANCE_WARNING.version}: ${SUPPLIER_COMPLIANCE_WARNING.acknowledgement}`,
          actorUserId: 'owner',
          actorName: 'Saba Owner',
          changedAt: new Date('2026-11-04T08:00:00.000Z'),
        },
      ],
    });
    expect(screen.getByText('Checks disabled')).toBeInTheDocument();
    expect(
      screen.getByText(/Supplier licence and trade-authorization checks are off/)
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Saba Owner/).length).toBeGreaterThan(0);
    expect(screen.getByText(/warning acknowledged/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Turn supplier checks back on' });
    const data = new FormData(button.closest('form')!);
    expect(data.get('checksEnabled')).toBe('true');
    expect(data.get('expectedVersion')).toBe('1');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says OFF includes controlled-medicine suppliers and leaves the controlled-drug safeguards in place', () => {
    panel({ read: read({ checksEnabled: false, canManage: false }) });
    expect(
      screen.getByText(/This includes suppliers of controlled medicines\./)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/pharmacist witness PIN at goods-in, the controlled[\s\S]*register/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/remains responsible for[\s\S]*legal sourcing obligations/)
    ).toBeInTheDocument();
    // The owner's warning says the same before the switch is turned off.
    const warning = SUPPLIER_COMPLIANCE_WARNING.paragraphs.join(' ');
    expect(warning).toMatch(/controlled medicines included/);
    expect(warning).toMatch(/pharmacist witness PIN at goods-in, the controlled register/);
    expect(warning).not.toMatch(/Controlled medicines are not affected/);
  });

  it('tells staff the checks are off without giving them a control', () => {
    panel({ read: read({ checksEnabled: false, canManage: false }) });
    expect(screen.getByText('Checks disabled')).toBeInTheDocument();
    expect(
      screen.getByText('Only the pharmacy owner can change this setting.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows staff nothing extra while the checks are on', () => {
    panel({ read: read({ checksEnabled: true, canManage: false }) });
    expect(screen.queryByText('Supplier compliance checks')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says the stored setting governs, and that the server fails closed, when it cannot be shown', () => {
    panel({ read: null });
    expect(
      screen.getByText(
        /could not be shown here[\s\S]*if the server cannot read it the supplier checks stay\s+on/
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('DEV-753 supplier status is never verified on the policy’s account', () => {
  const unchecked = supplier({
    eligibility: { orderable: true, reason: null },
    compliance: { checked: false, policyVersion: 2, licenceStatus: 'EXPIRED' },
  });

  it('badges an unchecked supplier "Not checked", not "Orderable"', () => {
    render(<LicenceBadge supplier={unchecked} />);
    expect(screen.getByText('Not checked')).toBeInTheDocument();
    expect(screen.queryByText(/orderable|licensed|verified|authorized/i)).toBeNull();
  });

  it('keeps an unchecked supplier selectable and labelled as not checked', () => {
    expect(supplierOptions([unchecked])).toEqual([
      { value: 'sup', disabled: false, label: 'Karachi Distributors — not checked' },
    ]);
  });

  it('still blocks and names the reason while the checks are on', () => {
    expect(supplierOptions([supplier({})])).toEqual([
      { value: 'sup', disabled: true, label: 'Karachi Distributors — not authorized' },
    ]);
  });

  it('describes an unchecked supplier by the evidence on file, not as verified', () => {
    render(
      <SupplierPolicyStanding checked={false} licenceStatus="EXPIRED" orderable reason={null} />
    );
    expect(screen.getByText(/This supplier has not been checked\./)).toBeInTheDocument();
    expect(screen.getByText(/Licence on file has expired\./)).toBeInTheDocument();
    expect(screen.queryByText(/can be ordered from and received from right now/)).toBeNull();
  });

  it('lists writes that went ahead without supplier checks as evidence', () => {
    render(
      <SupplierComplianceSkipList
        skips={[
          {
            id: 'skip_1',
            operation: 'GOODS_RECEIPT_POST',
            supplierId: 'sup',
            purchaseOrderId: null,
            goodsReceiptId: 'gr_1',
            reference: 'GRN-7',
            policyVersion: 2,
            supplierAuthorized: false,
            licenceStatus: 'NONE',
            actorUserId: 'u1',
            actorName: 'Ali Receiver',
            recordedAt: new Date('2026-11-04T09:00:00.000Z'),
          },
        ]}
      />
    );
    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('Goods receipt posted GRN-7');
    expect(item).toHaveTextContent('policy version 2');
    expect(item).toHaveTextContent('not authorized, no licence on file');
  });
});
