import { describe, expect, it } from 'vitest';

import {
  approveJourneyTemplate,
  assertJourneyDraftWordingNamed,
  assertJourneyTemplateAsRead,
  assertJourneyTransition,
  canSendJourneyMessage,
  currentJourneyConsent,
  defaultJourneyTemplateSeeds,
  HOTEL_JOURNEY_MOMENTS,
  journeyPlaceholdersUsed,
  journeyTemplateApproveInput,
  journeyTemplateDraftInput,
  journeyTemplateExpectedState,
  journeyTemplateRetireInput,
  parseJourneySettings,
  propertyMinuteOfDay,
  renderJourneyTemplate,
  retireJourneyTemplate,
  validateJourneyTemplate,
  withinQuietHours,
  type HotelJourneyCanSendInput,
  type HotelJourneyConsentEvent,
  type HotelJourneyTemplateShape,
} from './journey-templates';

const template: HotelJourneyTemplateShape = {
  moment: 'WELCOME',
  channel: 'WHATSAPP',
  language: 'EN',
  subject: null,
  body: 'Hello {{ guest_name }}, room {{room_number}} at {{property_name}}. {{guest_name}}',
};

describe('journey rendering and draft validation', () => {
  it('renders repeated placeholders, numbers and intentional empty values', () => {
    expect(
      renderJourneyTemplate(template, { guest_name: 'Sara', room_number: 0, property_name: '' })
    ).toEqual({
      subject: null,
      body: 'Hello Sara, room 0 at . Sara',
      placeholders: ['guest_name', 'room_number', 'property_name'],
    });
  });

  it('renders Urdu subject and body without changing the source copy', () => {
    const source = Object.freeze({
      ...template,
      channel: 'EMAIL' as const,
      language: 'UR' as const,
      subject: '{{property_name}} میں خوش آمدید',
      body: 'محترم {{guest_name}}، کمرہ {{room_number}}۔',
    });
    expect(
      renderJourneyTemplate(source, { property_name: 'ہوٹل', guest_name: 'سارہ', room_number: 12 })
    ).toEqual({
      subject: 'ہوٹل میں خوش آمدید',
      body: 'محترم سارہ، کمرہ 12۔',
      placeholders: ['property_name', 'guest_name', 'room_number'],
    });
    expect(source.body).toBe('محترم {{guest_name}}، کمرہ {{room_number}}۔');
  });

  it.each(['body', 'subject'] as const)('refuses an unknown %s placeholder', (field) => {
    expect(() =>
      validateJourneyTemplate({
        ...template,
        channel: 'EMAIL',
        subject: 'Welcome',
        [field]: '{{room_numbr}}',
      })
    ).toThrow(expect.objectContaining({ code: 'UNKNOWN_PLACEHOLDER' }));
  });

  it('refuses a known placeholder from another moment', () => {
    expect(() => validateJourneyTemplate({ ...template, body: '{{invoice_link}}' })).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_PLACEHOLDER' })
    );
  });

  it.each(['{{}}', '{{guest_name', '{{guest-name}}', '{{{{guest_name}}'])(
    'refuses malformed placeholder %s',
    (body) => {
      expect(() => journeyPlaceholdersUsed(body)).toThrow(
        expect.objectContaining({ code: 'MALFORMED_PLACEHOLDER' })
      );
    }
  );

  it('requires own context values, including when a prototype has the name', () => {
    const context = Object.create({ guest_name: 'Inherited' }) as Record<string, string>;
    expect(() => renderJourneyTemplate({ ...template, body: '{{guest_name}}' }, context)).toThrow(
      expect.objectContaining({ code: 'MISSING_PLACEHOLDER_VALUE' })
    );
  });

  it('refuses empty copy and subject on SMS', () => {
    expect(() => validateJourneyTemplate({ ...template, body: '   ' })).toThrow(
      expect.objectContaining({ code: 'BODY_REQUIRED' })
    );
    expect(() =>
      validateJourneyTemplate({ ...template, channel: 'SMS', subject: 'Hello' })
    ).toThrow(expect.objectContaining({ code: 'SUBJECT_NOT_ALLOWED' }));
  });

  it('accepts a supported new draft payload and refuses invalid keys or blank body', () => {
    const payload = {
      moment: 'REVIEW_REQUEST',
      channel: 'SMS',
      language: 'UR',
      subject: null,
      body: '  {{review_link}}  ',
    };
    expect(journeyTemplateDraftInput.parse(payload)).toEqual({
      ...payload,
      body: '{{review_link}}',
    });
    expect(journeyTemplateDraftInput.safeParse({ ...payload, language: 'AR' }).success).toBe(false);
    expect(journeyTemplateDraftInput.safeParse({ ...payload, body: ' ' }).success).toBe(false);
  });

  it('supplies valid, independently editable English and Urdu seed drafts for every moment', () => {
    const seeds = defaultJourneyTemplateSeeds();
    for (const moment of HOTEL_JOURNEY_MOMENTS) {
      for (const language of ['EN', 'UR']) {
        expect(seeds).toContainEqual(
          expect.objectContaining({
            moment,
            language,
            channel: 'WHATSAPP',
            status: 'DRAFT',
            version: 1,
          })
        );
      }
    }
    for (const seed of seeds) expect(() => validateJourneyTemplate(seed)).not.toThrow();
    seeds[0].body = 'Changed locally';
    expect(defaultJourneyTemplateSeeds()[0].body).not.toBe('Changed locally');
  });
});

describe('journey approval hooks', () => {
  it.each([
    ['DRAFT', 'APPROVED', true],
    ['DRAFT', 'RETIRED', true],
    ['APPROVED', 'RETIRED', true],
    ['DRAFT', 'DRAFT', false],
    ['APPROVED', 'DRAFT', false],
    ['APPROVED', 'APPROVED', false],
    ['RETIRED', 'DRAFT', false],
    ['RETIRED', 'APPROVED', false],
    ['RETIRED', 'RETIRED', false],
  ] as const)('checks %s to %s', (from, to, allowed) => {
    const transition = () => assertJourneyTransition(from, to);
    if (allowed) expect(transition).not.toThrow();
    else expect(transition).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });

  it('records approver and time without mutating the draft', () => {
    const draft = Object.freeze({ ...template, status: 'DRAFT' as const });
    const approval = { approvedByUserId: 'admin', approvedAt: new Date('2026-09-13T08:00:00Z') };
    expect(approveJourneyTemplate(draft, approval)).toEqual({ ...approval, status: 'APPROVED' });
    expect(draft.status).toBe('DRAFT');
  });

  it('requires attribution and revalidates copy before approval', () => {
    const approval = { approvedByUserId: 'admin', approvedAt: new Date('2026-09-13T08:00:00Z') };
    expect(() =>
      approveJourneyTemplate(
        { ...template, status: 'DRAFT' },
        { ...approval, approvedByUserId: ' ' }
      )
    ).toThrow(expect.objectContaining({ code: 'APPROVER_REQUIRED' }));
    expect(() =>
      approveJourneyTemplate({ ...template, status: 'DRAFT', body: '{{typo}}' }, approval)
    ).toThrow(expect.objectContaining({ code: 'UNKNOWN_PLACEHOLDER' }));
  });

  it('preserves approval history on retirement', () => {
    const approved = Object.freeze({
      status: 'APPROVED' as const,
      approvedByUserId: 'admin',
      approvedAt: new Date('2026-09-13T08:00:00Z'),
    });
    expect(retireJourneyTemplate(approved)).toEqual({ ...approved, status: 'RETIRED' });
    expect(approved.status).toBe('APPROVED');
  });
});

describe('writes against the version the caller read', () => {
  const readAt = new Date('2026-09-13T08:00:00.000Z');
  const stored = Object.freeze({
    ...template,
    channel: 'EMAIL' as const,
    subject: 'Welcome to {{property_name}}',
    id: 'v2',
    version: 2,
    status: 'DRAFT' as const,
    updatedAt: readAt,
  });
  const changed = expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' });

  it('admits the version exactly as read, by time alone or with its wording', () => {
    expect(() =>
      assertJourneyTemplateAsRead(stored, { updatedAt: new Date(readAt) })
    ).not.toThrow();
    expect(() =>
      assertJourneyTemplateAsRead(stored, {
        updatedAt: new Date(readAt),
        subject: stored.subject,
        body: stored.body,
      })
    ).not.toThrow();
    const whatsapp = { ...stored, channel: 'WHATSAPP' as const, subject: null };
    expect(() =>
      assertJourneyTemplateAsRead(whatsapp, { updatedAt: readAt, subject: null, body: stored.body })
    ).not.toThrow();
  });

  it('refuses a version saved since, by its time or — when two writes share one — by its words', () => {
    expect(() =>
      assertJourneyTemplateAsRead(stored, { updatedAt: new Date(readAt.getTime() - 1) })
    ).toThrow(changed);
    expect(() =>
      assertJourneyTemplateAsRead(stored, { updatedAt: readAt, body: `${stored.body} ` })
    ).toThrow(changed);
    expect(() =>
      assertJourneyTemplateAsRead(stored, {
        updatedAt: readAt,
        subject: 'Another subject',
        body: stored.body,
      })
    ).toThrow(changed);
    expect(() =>
      assertJourneyTemplateAsRead(stored, { updatedAt: readAt, subject: null, body: stored.body })
    ).toThrow(changed);
  });

  it('scopes a conditional write to the caller’s reading laid over the row just read', () => {
    expect(journeyTemplateExpectedState(stored)).toEqual({
      id: 'v2',
      moment: 'WELCOME',
      channel: 'EMAIL',
      language: 'EN',
      version: 2,
      status: 'DRAFT',
      updatedAt: readAt,
      subject: stored.subject,
      body: stored.body,
    });
    const seenAt = new Date(readAt.getTime() - 1000);
    expect(
      journeyTemplateExpectedState(stored, { updatedAt: seenAt, subject: null, body: 'Read' })
    ).toMatchObject({ updatedAt: seenAt, subject: null, body: 'Read', status: 'DRAFT' });
    // A time-only reading leaves the stored wording in the predicate.
    expect(journeyTemplateExpectedState(stored, { updatedAt: seenAt })).toMatchObject({
      updatedAt: seenAt,
      subject: stored.subject,
      body: stored.body,
    });
  });

  it('makes approval and retirement name the version read, and keeps the wording untrimmed', () => {
    const approval = {
      id: 'v2',
      expectedUpdatedAt: readAt.toISOString(),
      expectedSubject: null,
      expectedBody: '  Words as shown  ',
      expectedApprovedId: null,
    };
    expect(journeyTemplateApproveInput.parse(approval)).toEqual({
      ...approval,
      expectedUpdatedAt: readAt,
    });
    for (const missing of [
      'expectedUpdatedAt',
      'expectedSubject',
      'expectedBody',
      'expectedApprovedId',
    ] as const) {
      const partial: Record<string, unknown> = { ...approval };
      delete partial[missing];
      expect(journeyTemplateApproveInput.safeParse(partial).success).toBe(false);
    }
    expect(journeyTemplateRetireInput.safeParse({ id: 'v2' }).success).toBe(false);
    expect(
      journeyTemplateRetireInput.parse({ id: 'v2', expectedUpdatedAt: readAt.toISOString() })
    ).toEqual({ id: 'v2', expectedUpdatedAt: readAt });
  });

  it('lets a retirement name a draft’s wording, untrimmed, alongside its time', () => {
    const retirement = {
      id: 'v2',
      expectedUpdatedAt: readAt.toISOString(),
      expectedSubject: null,
      expectedBody: '  Words as shown  ',
    };
    expect(journeyTemplateRetireInput.parse(retirement)).toEqual({
      ...retirement,
      expectedUpdatedAt: readAt,
    });
    expect(journeyTemplateRetireInput.safeParse({ ...retirement, expectedBody: '' }).success).toBe(
      false
    );
  });

  it('asks a write bound to a draft for its wording, and any other version for its time alone', () => {
    const incomplete = expect.objectContaining({ code: 'READING_INCOMPLETE' });
    for (const reading of [
      { updatedAt: readAt },
      { updatedAt: readAt, body: stored.body },
      { updatedAt: readAt, subject: stored.subject },
    ]) {
      expect(() => assertJourneyDraftWordingNamed(stored, reading)).toThrow(incomplete);
    }
    // `null` is a reading of "no subject line", not a missing one.
    expect(() =>
      assertJourneyDraftWordingNamed(stored, {
        updatedAt: readAt,
        subject: null,
        body: stored.body,
      })
    ).not.toThrow();
    for (const status of ['APPROVED', 'RETIRED'] as const) {
      expect(() =>
        assertJourneyDraftWordingNamed({ ...stored, status }, { updatedAt: readAt })
      ).not.toThrow();
    }
  });

  it('lets a draft save name the version it edits only as a whole: time and wording together', () => {
    const payload = {
      moment: 'WELCOME',
      channel: 'WHATSAPP',
      language: 'EN',
      subject: null,
      body: 'Hello {{guest_name}}',
    };
    const read = { expectedUpdatedAt: readAt, expectedSubject: null, expectedBody: 'Hi ' };
    expect(journeyTemplateDraftInput.parse({ ...payload, ...read })).toEqual({
      ...payload,
      ...read,
    });
    for (const partial of [
      { expectedUpdatedAt: readAt },
      { expectedUpdatedAt: readAt, expectedBody: 'Hi' },
      { expectedSubject: null, expectedBody: 'Hi' },
      { expectedBody: 'Hi' },
    ]) {
      const result = journeyTemplateDraftInput.safeParse({ ...payload, ...partial });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ path: ['expectedUpdatedAt'] }),
      ]);
    }
  });
});

// These exercise explicit promotional settings only. SERVICE compatibility,
// transactional exemptions and the default window remain contract review gates.
describe('existing consent and explicit quiet-hours hooks', () => {
  const consent: HotelJourneyConsentEvent = {
    purpose: 'MARKETING',
    channel: 'SMS',
    version: 1,
    granted: true,
  };
  const input: HotelJourneyCanSendInput = {
    template: { moment: 'REVIEW_REQUEST', channel: 'SMS', status: 'APPROVED' },
    consentEvents: [consent],
    journeySettings: { quietHours: { start: '22:00', end: '07:00' } },
    timezone: 'Asia/Karachi',
    now: new Date('2026-09-13T09:00:00Z'),
  };

  it('chooses the latest matching event without sorting the caller array', () => {
    const events = Object.freeze([
      consent,
      { ...consent, channel: 'EMAIL' as const, version: 99 },
      { ...consent, version: 2, granted: false },
    ]);
    expect(currentJourneyConsent(events, 'MARKETING', 'SMS')).toBe(events[2]);
    expect(events[0]).toBe(consent);
    expect(currentJourneyConsent(events, 'MARKETING', 'WHATSAPP')).toBeNull();
  });

  it.each(['DRAFT', 'RETIRED'] as const)('refuses %s before consent or time checks', (status) => {
    expect(
      canSendJourneyMessage({
        ...input,
        template: { ...input.template, status },
        consentEvents: [],
        timezone: 'Invalid',
      })
    ).toMatchObject({ ok: false, reason: 'TEMPLATE_NOT_APPROVED' });
  });

  it('refuses missing and withdrawn consent on the selected channel', () => {
    expect(
      canSendJourneyMessage({ ...input, consentEvents: [{ ...consent, channel: 'EMAIL' }] })
    ).toMatchObject({ ok: false, reason: 'NO_CONSENT' });
    expect(
      canSendJourneyMessage({
        ...input,
        consentEvents: [consent, { ...consent, version: 2, granted: false }],
      })
    ).toMatchObject({ ok: false, reason: 'CONSENT_WITHDRAWN' });
    expect(
      canSendJourneyMessage({ ...input, consentEvents: [{ ...consent, revokedAt: input.now }] })
    ).toMatchObject({ ok: false, reason: 'CONSENT_WITHDRAWN' });
  });

  it('defers a consented promotional message using property-local quiet hours', () => {
    expect(
      canSendJourneyMessage({ ...input, now: new Date('2026-09-13T17:00:00Z') })
    ).toMatchObject({ ok: false, reason: 'QUIET_HOURS' });
    expect(canSendJourneyMessage(input)).toEqual({ ok: true });
  });

  it('handles explicit windows with inclusive starts and exclusive ends', () => {
    const window = parseJourneySettings(input.journeySettings).quietHours;
    expect(window).toEqual({ startMinute: 1320, endMinute: 420 });
    expect([1319, 1320, 0, 419, 420].map((minute) => withinQuietHours(minute, window))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(
      [599, 600, 719, 720].map((minute) =>
        withinQuietHours(minute, { startMinute: 600, endMinute: 720 })
      )
    ).toEqual([false, true, true, false]);
    expect(
      withinQuietHours(0, parseJourneySettings({ quietHours: { observed: false } }).quietHours)
    ).toBe(false);
  });

  it('resolves local time across daylight-saving seasons', () => {
    expect(propertyMinuteOfDay(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(420);
    expect(propertyMinuteOfDay(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(480);
  });
});
