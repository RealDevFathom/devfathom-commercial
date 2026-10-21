import { describe, expect, it } from 'vitest';

import { campaignInTab } from '@/lib/growth/view';
import { renderTemplate, templateIssues } from '@/lib/growth/template-text';

import {
  formatPkr,
  karachiInputValue,
  karachiLocalToIso,
  minorFromRupees,
  rupeesInput,
} from './format';

const valid =
  'Salaam {{name}}! {{discount}} off at {{business}}. Code {{code}}. Reply STOP to opt out.';

describe('growth display helpers', () => {
  it('formats paisa as PKR and parses rupees back', () => {
    expect(formatPkr(180_000)).toBe('PKR 1,800.00');
    expect(formatPkr(0)).toBe('PKR 0.00');
    expect(rupeesInput(1_500_000)).toBe('15000');
    expect(minorFromRupees('2000.50')).toBe(200_050);
    expect(minorFromRupees('15')).toBe(1_500);
    expect(minorFromRupees('1.2')).toBe(120);
    expect(minorFromRupees('1.234')).toBeNull();
  });

  it('treats datetime-local values as Asia/Karachi', () => {
    expect(karachiInputValue(new Date('2026-10-21T06:00:00.000Z'))).toBe('2026-10-21T11:00');
    expect(karachiLocalToIso('2026-10-21T11:00')).toBe('2026-10-21T06:00:00.000Z');
    expect(karachiLocalToIso('tomorrow')).toBeNull();
  });

  it('refuses unknown template variables and a missing STOP line', () => {
    expect(templateIssues('Salaam {{nope}} STOP')).toMatch(/\{\{nope\}\}/);
    expect(templateIssues('Salaam {{name}}')).toMatch(/STOP/);
    expect(templateIssues(valid)).toBeNull();
    expect(
      renderTemplate(valid, { name: 'Ayesha', discount: '10%', business: 'Sehat', code: 'SEHA-1' })
    ).toContain('Ayesha');
  });

  it('puts approved campaigns on the scheduled tab and cancelled ones on all', () => {
    expect(campaignInTab('approved', 'scheduled')).toBe(true);
    expect(campaignInTab('proposed', 'scheduled')).toBe(false);
    expect(campaignInTab('cancelled', 'sent')).toBe(false);
    expect(campaignInTab('cancelled', 'all')).toBe(true);
    expect(campaignInTab('exhausted', 'sent')).toBe(true);
  });
});
