import { describe, expect, it } from 'vitest';

import { createMemoryStore } from './whatsapp/memory-store';
import {
  assertCampaignProducts,
  DEFAULT_TEMPLATES,
  DrugCategoryInPromo,
  ensureDefaultTemplates,
  MissingStop,
  MissingTemplateVariable,
  renderTemplate,
  saveTemplateBody,
  TEMPLATE_KEYS,
  TEMPLATE_PURPOSE,
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
  it('marks refill_reminder and order_ready as utility and every other default as marketing', () => {
    expect(TEMPLATE_PURPOSE.refill_reminder).toBe('utility');
    expect(TEMPLATE_PURPOSE.order_ready).toBe('utility');
    for (const key of TEMPLATE_KEYS) {
      if (key === 'refill_reminder' || key === 'order_ready') continue;
      expect(TEMPLATE_PURPOSE[key]).toBe('marketing');
    }
  });

  it('refuses a drug category on a promo and allows it on a refill reminder', () => {
    expect(() =>
      assertCampaignProducts({
        templateKey: 'birthday_offer',
        productCategories: ['FRONT_SHOP', 'PHARMACEUTICAL'],
      })
    ).toThrow(DrugCategoryInPromo);
    expect(() =>
      assertCampaignProducts({
        templateKey: 'slow_day',
        productCategories: ['Front Shop'],
      })
    ).not.toThrow();
    expect(() =>
      assertCampaignProducts({
        templateKey: 'refill_reminder',
        productCategories: ['PHARMACEUTICAL', 'BIOLOGICAL'],
      })
    ).not.toThrow();
    expect(() =>
      assertCampaignProducts({ templateKey: 'not_a_template', productCategories: [] })
    ).toThrow(UnknownTemplateVariable);
  });

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

  it('seeds the default templates once, including order_ready in English and Urdu', async () => {
    const store = createMemoryStore();
    await ensureDefaultTemplates(store, 'org_1');
    await ensureDefaultTemplates(store, 'org_1');
    const rows = await store.templates('org_1');
    expect(rows.map((row) => `${row.key}:${row.language}`).sort()).toEqual([
      'birthday_offer:ur-en',
      'generic:ur-en',
      'holiday:ur-en',
      'order_ready:en',
      'order_ready:ur',
      'referral:ur-en',
      'refill_reminder:ur-en',
      'review_request:ur-en',
      'slow_day:ur-en',
      'winback:ur-en',
    ]);
  });
});
