import { describe, expect, it } from 'vitest';

import {
  daysUntil,
  describeRenewalDue,
  planRenewalReminders,
  punjabRenewalFee,
  renderRenewalDigest,
  renewalChecklist,
  renewalStage,
  renewalTemplateParameters,
  type RenewalSubject,
} from './licence-renewal';

const AT = new Date('2026-09-04T08:00:00.000Z');
const DAY_MS = 86_400_000;
const inDays = (days: number) => new Date(AT.getTime() + days * DAY_MS);

function subject(overrides: Partial<RenewalSubject> = {}): RenewalSubject {
  return {
    kind: 'BRANCH_LICENCE',
    subjectId: 'branch_1',
    branchId: 'branch_1',
    label: 'Main drug sale licence',
    reference: 'DSL-1',
    expiresAt: inDays(30),
    provinceCode: 'PK-PB',
    licenceCategory: 'PHARMACY',
    ...overrides,
  };
}

describe('#720 renewal stages', () => {
  it('reaches the 90, 60, 30 and 7-day stages and nothing beyond 90 days', () => {
    expect(renewalStage(91)).toBeNull();
    expect(renewalStage(90)).toBe(90);
    expect(renewalStage(61)).toBe(90);
    expect(renewalStage(60)).toBe(60);
    expect(renewalStage(31)).toBe(60);
    expect(renewalStage(30)).toBe(30);
    expect(renewalStage(8)).toBe(30);
    expect(renewalStage(7)).toBe(7);
    expect(renewalStage(1)).toBe(7);
    expect(renewalStage(0)).toBeNull();
    expect(renewalStage(-3)).toBeNull();
  });

  it('counts part days as a whole day left', () => {
    expect(daysUntil(new Date(AT.getTime() + 29.2 * DAY_MS), AT)).toBe(30);
    expect(daysUntil(AT, AT)).toBe(0);
  });
});

describe('#720 planRenewalReminders', () => {
  it('plans a 30-day reminder for a licence that expires in 30 days', () => {
    const [reminder] = planRenewalReminders([subject()], AT);
    expect(reminder).toMatchObject({
      daysLeft: 30,
      stage: 30,
      expired: false,
      dedupeKey: 'renewal:BRANCH_LICENCE:branch_1:2026-10-04:30',
    });
    expect(reminder!.checklist.fee).toBe('Rs 3,000 (pharmacy)');
  });

  it('skips a licence outside the window and an unreadable date', () => {
    expect(
      planRenewalReminders(
        [subject({ expiresAt: inDays(120) }), subject({ expiresAt: new Date('nope') })],
        AT
      )
    ).toEqual([]);
  });

  it('keeps a lapsed licence listed as expired, most urgent first', () => {
    const reminders = planRenewalReminders(
      [
        subject({ subjectId: 'a', label: 'A', expiresAt: inDays(60) }),
        subject({ subjectId: 'b', label: 'B', expiresAt: inDays(-2) }),
        subject({ subjectId: 'c', label: 'C', expiresAt: inDays(5) }),
      ],
      AT
    );
    expect(reminders.map((reminder) => [reminder.label, reminder.stage, reminder.expired])).toEqual(
      [
        ['B', null, true],
        ['C', 7, false],
        ['A', 60, false],
      ]
    );
    expect(reminders[0]!.dedupeKey).toMatch(/:expired$/);
  });

  it('gives a renewed licence a new dedupe key, so its own reminders start fresh', () => {
    const [old] = planRenewalReminders([subject({ expiresAt: inDays(30) })], AT);
    const [renewed] = planRenewalReminders(
      [subject({ expiresAt: inDays(30 + 730) })],
      new Date(AT.getTime() + 730 * DAY_MS)
    );
    expect(renewed!.dedupeKey).not.toBe(old!.dedupeKey);
  });
});

describe('#720 renewal checklist', () => {
  it('quotes the Punjab fee by licence category', () => {
    expect(punjabRenewalFee('PHARMACY')).toBe('Rs 3,000 (pharmacy)');
    expect(punjabRenewalFee('Medical Store')).toBe('Rs 2,000 (medical store)');
    expect(punjabRenewalFee('MEDICAL_STORE')).toBe('Rs 2,000 (medical store)');
    expect(punjabRenewalFee('PROVISIONAL')).toBe(
      'Rs 3,000 for a pharmacy, Rs 2,000 for a medical store'
    );
  });

  it('lists the Punjab documents, including the inspection, for a branch licence', () => {
    const checklist = renewalChecklist(subject({ provinceCode: 'PB' }));
    expect(checklist.province).toBe('Punjab');
    expect(checklist.provisional).toBe(true);
    expect(checklist.source).toContain('Procedure-Rules-for-Drug-Sale-License.pdf');
    expect(checklist.documents.some((line) => /inspection/i.test(line))).toBe(true);
    expect(checklist.documents.some((line) => /fee challan/i.test(line))).toBe(true);
  });

  it('asserts no fee where the province schedule is unconfirmed', () => {
    const checklist = renewalChecklist(subject({ provinceCode: 'PK-SD' }));
    expect(checklist.province).toBe('Sindh');
    expect(checklist.fee).toBeNull();
  });

  it('has a registration checklist and a supplier checklist without fees', () => {
    expect(
      renewalChecklist(subject({ kind: 'QUALIFIED_PERSON_REGISTRATION', licenceCategory: null }))
        .fee
    ).toBeNull();
    const supplier = renewalChecklist(
      subject({ kind: 'SUPPLIER_LICENCE', provinceCode: null, licenceCategory: null })
    );
    expect(supplier.province).toBeNull();
    expect(supplier.fee).toBeNull();
    expect(supplier.documents.join(' ')).toMatch(/Suppliers/);
  });
});

describe('#720 digest and template rendering', () => {
  it('renders a digest line for each due licence and nothing when none is due', () => {
    expect(renderRenewalDigest([])).toEqual([]);
    expect(renderRenewalDigest(planRenewalReminders([subject()], AT))).toEqual([
      'Licence renewals due: 1',
      '- Main drug sale licence DSL-1 expires in 30 days (2026-10-04) · renewal fee Rs 3,000 (pharmacy)',
    ]);
  });

  it('describes due and lapsed dates', () => {
    expect(describeRenewalDue({ daysLeft: 1, expiresAt: inDays(1) })).toBe(
      'expires in 1 day (2026-09-05)'
    );
    expect(describeRenewalDue({ daysLeft: -2, expiresAt: inDays(-2) })).toBe(
      'expired on 2026-09-02'
    );
  });

  it('keeps template parameters single-line and bounded', () => {
    const [reminder] = planRenewalReminders(
      [subject({ label: 'Main\nbranch   licence', reference: `${'X'.repeat(80)}` })],
      AT
    );
    const parameters = renewalTemplateParameters(reminder!);
    expect(parameters).toEqual([
      'Main branch licence',
      'X'.repeat(40),
      '2026-10-04',
      '30',
      'Rs 3,000 (pharmacy)',
    ]);
    expect(parameters.every((value) => !/[\r\n]/.test(value))).toBe(true);
  });
});
