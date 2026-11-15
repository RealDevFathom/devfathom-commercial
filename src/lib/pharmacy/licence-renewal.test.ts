import { describe, expect, it } from 'vitest';

import {
  licenceRenewalReminders,
  renderRenewalReminderLine,
  renderRenewalWhatsApp,
  renewalChecklist,
  type RenewalSubject,
} from './licence-renewal';

const at = new Date('2026-11-15T09:00:00.000Z');
const days = (n: number) => new Date(at.getTime() + n * 24 * 60 * 60 * 1000);

const branchLicence = (validTo: Date, category = 'PHARMACY'): RenewalSubject => ({
  kind: 'BRANCH_LICENCE',
  holder: 'Main branch',
  reference: 'DSL-123',
  validTo,
  provinceCode: 'PK-PB',
  licenceCategory: category,
});

describe('#720 licence renewal reminders', () => {
  it('places each subject in its 90/60/30/7-day window and drops later ones', () => {
    const reminders = licenceRenewalReminders(
      [
        branchLicence(days(120)),
        branchLicence(days(90)),
        branchLicence(days(45)),
        branchLicence(days(30)),
        branchLicence(days(5)),
        branchLicence(days(-1)),
      ],
      at
    );
    expect(reminders.map((reminder) => [reminder.daysLeft, reminder.stage])).toEqual([
      [-1, 0],
      [5, 7],
      [30, 30],
      [45, 60],
      [90, 90],
    ]);
  });

  it('gives Punjab drug sale licences the inspection and the category fee', () => {
    expect(renewalChecklist(branchLicence(days(30), 'PHARMACY'))).toMatchObject({
      province: 'Punjab',
      fee: 'Rs 3,000 (pharmacy)',
      inspection: true,
    });
    expect(renewalChecklist(branchLicence(days(30), 'MEDICAL_STORE')).fee).toBe(
      'Rs 2,000 (medical store)'
    );
    expect(renewalChecklist({ ...branchLicence(days(30)), provinceCode: 'PK-SD' }).fee).toBeNull();
  });

  it('renders an in-app line for a licence expiring in 30 days', () => {
    const [reminder] = licenceRenewalReminders([branchLicence(days(30))], at);
    expect(renderRenewalReminderLine(reminder!)).toBe(
      'Renewal: Drug sale licence (Main branch, DSL-123) expires in 30 days. Fee: Rs 3,000 (pharmacy).'
    );
  });

  it('keeps the WhatsApp text to the licence kind and days left', () => {
    const reminders = licenceRenewalReminders(
      [
        branchLicence(days(30)),
        {
          kind: 'SUPPLIER_LICENCE',
          holder: 'Panadol Distributors',
          reference: 'SUP-9',
          validTo: days(7),
        },
      ],
      at
    );
    const body = renderRenewalWhatsApp(reminders);
    expect(body).toContain('Supplier licence expires in 7 days.');
    expect(body).toContain('Drug sale licence expires in 30 days.');
    expect(body).not.toMatch(/panadol|SUP-9|DSL-123|Main branch/i);
    expect(renderRenewalWhatsApp([])).toBeNull();
  });
});
