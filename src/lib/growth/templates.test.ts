import { describe, expect, it } from 'vitest';

import { createMemoryStore } from './whatsapp/memory-store';
import {
  DEFAULT_TEMPLATES,
  ensureDefaultTemplates,
  MissingStop,
  MissingTemplateVariable,
  renderTemplate,
  saveTemplateBody,
  UnknownTemplateVariable,
} from './templates';

const vars = {
  name: 'Ayesha',
  business: 'Sehat Pharmacy',
  discount: '10%',
  code: 'SEHA-AAAAAA',
  expires: 'Friday',
  product: 'Metformin',
  reviewUrl: 'https://example.test/review',
  referralCode: 'AYE-1234',
};

describe('message templates', () => {
  it('refuses a body without STOP', () => {
    expect(() => renderTemplate('Salaam {{name}}', { name: 'Ayesha' })).toThrow(MissingStop);
  });

  it('refuses to leave a missing variable in the message', () => {
    expect(() =>
      renderTemplate(DEFAULT_TEMPLATES.birthday_offer, {
        name: vars.name,
        business: vars.business,
        discount: vars.discount,
        expires: vars.expires,
      })
    ).toThrow(MissingTemplateVariable);
    try {
      renderTemplate(DEFAULT_TEMPLATES.birthday_offer, {
        name: vars.name,
        business: vars.business,
        discount: vars.discount,
        expires: vars.expires,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MissingTemplateVariable);
      expect((error as Error).message).not.toContain('{{code}}');
    }
  });

  it('rejects an unknown placeholder before save', async () => {
    const store = createMemoryStore();
    await expect(
      saveTemplateBody(store, {
        organizationId: 'org_1',
        key: 'generic',
        language: 'ur-en',
        body: 'Salaam {{nickname}}. Reply STOP to opt out.',
      })
    ).rejects.toBeInstanceOf(UnknownTemplateVariable);
    expect(await store.templates('org_1')).toHaveLength(0);
  });

  it('renders every seeded template when its variables are present', () => {
    for (const body of Object.values(DEFAULT_TEMPLATES)) {
      expect(renderTemplate(body, vars)).toContain('STOP');
      expect(renderTemplate(body, vars)).not.toContain('{{');
    }
  });

  it('seeds the eight default templates once', async () => {
    const store = createMemoryStore();
    await ensureDefaultTemplates(store, 'org_1');
    await ensureDefaultTemplates(store, 'org_1');
    const rows = await store.templates('org_1');
    expect(rows.map((row) => row.key).sort()).toEqual([
      'birthday_offer',
      'generic',
      'holiday',
      'referral',
      'refill_reminder',
      'review_request',
      'slow_day',
      'winback',
    ]);
  });
});
