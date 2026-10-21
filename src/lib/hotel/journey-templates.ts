/**
 * UPS-04 (04 §5.17, 05 §1.3/§1.4) — the guest journey template model.
 *
 * Four things live here and nowhere else:
 *
 * - the **placeholder catalogue**, per moment. A template may only name a fact
 *   the moment actually has, so an unknown `{{placeholder}}` is an error at
 *   draft time rather than a literal `{{room_numbr}}` in a guest's WhatsApp;
 * - **rendering**, which is total: it either produces the finished message or
 *   names exactly what is wrong with it;
 * - the **approval transitions**, because UPS-04's acceptance is "template
 *   approval before use" and an approved wording is superseded by a new version
 *   rather than edited; and
 * - `canSend`, a **pure hook**. It answers "may this message go out now?" from
 *   consent, quiet hours and approval, and it sends nothing. H4 owns sending and
 *   calls this; nothing in this lane does.
 *
 * The consent model is the platform's, read only: the pharmacy MKT-01 pattern of
 * append-only, versioned consent events where the highest version for a
 * (purpose, channel) pair is the current one and a revoked event is not consent
 * (`src/lib/pharmacy/patient-prescriptions.ts` `hasActiveConsent`). This lane
 * defines no consent table and writes no consent row; it reads the shape.
 */
import { z } from 'zod';

import {
  HotelJourneyChannel,
  HotelJourneyLanguage,
  HotelJourneyMoment,
  HotelJourneyTemplateStatus,
} from '@/generated/prisma/enums';

/** The eight moments of §5.17, in the order a stay runs. */
export const HOTEL_JOURNEY_MOMENTS = Object.values(HotelJourneyMoment);
export const HOTEL_JOURNEY_CHANNELS = Object.values(HotelJourneyChannel);
export const HOTEL_JOURNEY_LANGUAGES = Object.values(HotelJourneyLanguage);
export const HOTEL_JOURNEY_TEMPLATE_STATUSES = Object.values(HotelJourneyTemplateStatus);

export type HotelJourneyMomentValue = (typeof HOTEL_JOURNEY_MOMENTS)[number];
export type HotelJourneyChannelValue = (typeof HOTEL_JOURNEY_CHANNELS)[number];
export type HotelJourneyLanguageValue = (typeof HOTEL_JOURNEY_LANGUAGES)[number];
export type HotelJourneyTemplateStatusValue = (typeof HOTEL_JOURNEY_TEMPLATE_STATUSES)[number];

/** Operator-facing names. UX rule 1: no surface prints a bare enum value. */
export const HOTEL_JOURNEY_MOMENT_LABELS: Record<HotelJourneyMomentValue, string> = {
  BOOKING_CONFIRMED: 'Booking confirmed',
  PRE_ARRIVAL_UPSELL: 'Pre-arrival offer',
  SELF_CHECKIN: 'Self check-in',
  WELCOME: 'Welcome',
  IN_STAY: 'During the stay',
  EXPRESS_CHECKOUT: 'Express checkout',
  INVOICE: 'Invoice',
  REVIEW_REQUEST: 'Review request',
};

export const HOTEL_JOURNEY_CHANNEL_LABELS: Record<HotelJourneyChannelValue, string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'E-mail',
  SMS: 'SMS',
};

export const HOTEL_JOURNEY_LANGUAGE_LABELS: Record<HotelJourneyLanguageValue, string> = {
  EN: 'English',
  UR: 'Urdu',
};

export const HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS: Record<HotelJourneyTemplateStatusValue, string> =
  {
    DRAFT: 'Draft',
    APPROVED: 'Approved',
    RETIRED: 'Retired',
  };

/**
 * Whether a moment is a fact about the guest's own booking or an offer.
 *
 * This is the only thing consent and quiet hours branch on, and it is data
 * rather than a code path: a booking confirmation is the answer to something the
 * guest just did and must not be held until morning, while an upsell is
 * marketing and must be. MODE-01's "no code path branches on it" rule is about
 * property modes, but the same discipline is worth keeping here.
 */
export const HOTEL_JOURNEY_MOMENT_KINDS: Record<
  HotelJourneyMomentValue,
  'TRANSACTIONAL' | 'PROMOTIONAL'
> = {
  BOOKING_CONFIRMED: 'TRANSACTIONAL',
  PRE_ARRIVAL_UPSELL: 'PROMOTIONAL',
  SELF_CHECKIN: 'TRANSACTIONAL',
  WELCOME: 'TRANSACTIONAL',
  IN_STAY: 'PROMOTIONAL',
  EXPRESS_CHECKOUT: 'TRANSACTIONAL',
  INVOICE: 'TRANSACTIONAL',
  REVIEW_REQUEST: 'PROMOTIONAL',
};

/**
 * The consent purpose a moment is sent under. A transactional message rides the
 * guest's service consent; an offer or a review request rides marketing consent.
 * Both are the platform's purposes, not new ones.
 */
export const HOTEL_JOURNEY_CONSENT_PURPOSES = ['SERVICE', 'MARKETING'] as const;
export type HotelJourneyConsentPurpose = (typeof HOTEL_JOURNEY_CONSENT_PURPOSES)[number];

export function journeyConsentPurpose(moment: HotelJourneyMomentValue): HotelJourneyConsentPurpose {
  return HOTEL_JOURNEY_MOMENT_KINDS[moment] === 'PROMOTIONAL' ? 'MARKETING' : 'SERVICE';
}

/** Facts every message may name, whichever moment it belongs to. */
const COMMON_PLACEHOLDERS = [
  'guest_name',
  'property_name',
  'property_phone',
  'reservation_code',
] as const;

/**
 * What each moment may name, on top of the common four. A placeholder outside
 * this list is a typo or a fact the sender will not hold at that moment; either
 * way the draft is refused rather than sent with a hole in it.
 */
export const HOTEL_JOURNEY_PLACEHOLDERS: Record<HotelJourneyMomentValue, readonly string[]> =
  Object.freeze({
    BOOKING_CONFIRMED: [
      ...COMMON_PLACEHOLDERS,
      'check_in_date',
      'check_in_time',
      'check_out_date',
      'check_out_time',
      'nights',
      'room_type',
      'total_amount',
      'balance_due',
    ],
    PRE_ARRIVAL_UPSELL: [
      ...COMMON_PLACEHOLDERS,
      'check_in_date',
      'offer_name',
      'offer_description',
      'offer_price',
      'offer_link',
      'offer_expires_at',
    ],
    SELF_CHECKIN: [
      ...COMMON_PLACEHOLDERS,
      'check_in_date',
      'check_in_time',
      'checkin_link',
      'checkin_expires_at',
    ],
    WELCOME: [
      ...COMMON_PLACEHOLDERS,
      'room_number',
      'check_out_date',
      'check_out_time',
      'wifi_network',
      'wifi_password',
    ],
    IN_STAY: [...COMMON_PLACEHOLDERS, 'room_number', 'stay_page_link'],
    EXPRESS_CHECKOUT: [
      ...COMMON_PLACEHOLDERS,
      'room_number',
      'check_out_date',
      'check_out_time',
      'balance_due',
      'checkout_link',
    ],
    INVOICE: [
      ...COMMON_PLACEHOLDERS,
      'invoice_number',
      'invoice_total',
      'invoice_link',
      'check_out_date',
    ],
    REVIEW_REQUEST: [...COMMON_PLACEHOLDERS, 'check_out_date', 'review_link'],
  });

/** A `{{placeholder}}` reference, tolerating inner spaces. */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]*)\s*\}\}/g;
/** An opening brace pair that no complete reference consumed — a broken tag. */
const OPENING_BRACES_PATTERN = /\{\{/g;

export type HotelJourneyTemplateErrorCode =
  | 'UNKNOWN_PLACEHOLDER'
  | 'MALFORMED_PLACEHOLDER'
  | 'MISSING_PLACEHOLDER_VALUE'
  | 'SUBJECT_NOT_ALLOWED'
  | 'SUBJECT_REQUIRED'
  | 'BODY_REQUIRED'
  | 'INVALID_TRANSITION'
  | 'CONCURRENT_MODIFICATION'
  | 'APPROVER_REQUIRED'
  | 'READING_INCOMPLETE';

/**
 * A refusal an operator surface can show as-is. `message` is written for the
 * person editing the template, not for a log line.
 */
export class HotelJourneyTemplateError extends Error {
  constructor(
    readonly code: HotelJourneyTemplateErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HotelJourneyTemplateError';
  }
}

/** The template facts rendering and approval need. Deliberately not the row. */
export type HotelJourneyTemplateShape = {
  moment: HotelJourneyMomentValue;
  channel: HotelJourneyChannelValue;
  language: HotelJourneyLanguageValue;
  subject: string | null;
  body: string;
};

/**
 * Every placeholder a piece of copy names, in order of first appearance, with a
 * broken `{{` refused rather than passed through to a guest.
 */
export function journeyPlaceholdersUsed(text: string): string[] {
  const found: string[] = [];
  let complete = 0;
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    complete += 1;
    const name = match[1] ?? '';
    if (!name)
      throw new HotelJourneyTemplateError(
        'MALFORMED_PLACEHOLDER',
        'A placeholder is empty. Write the name inside the braces, for example {{guest_name}}.'
      );
    if (!found.includes(name)) found.push(name);
  }
  const opened = text.match(OPENING_BRACES_PATTERN)?.length ?? 0;
  if (opened > complete)
    throw new HotelJourneyTemplateError(
      'MALFORMED_PLACEHOLDER',
      'A placeholder is not closed. Every placeholder looks like {{guest_name}}.'
    );
  return found;
}

/**
 * The copy is well formed for its moment and channel: no unknown placeholder, no
 * broken tag, a subject exactly where the channel has one.
 *
 * Called on every draft save, so a template cannot reach approval — and
 * therefore cannot reach a guest — carrying a name the sender will not have.
 */
export function validateJourneyTemplate(template: HotelJourneyTemplateShape): void {
  if (!template.body.trim())
    throw new HotelJourneyTemplateError('BODY_REQUIRED', 'Write the message before saving it.');
  if (template.channel === 'EMAIL') {
    if (!template.subject?.trim())
      throw new HotelJourneyTemplateError(
        'SUBJECT_REQUIRED',
        'An e-mail needs a subject line before it can be saved.'
      );
  } else if (template.subject !== null && template.subject !== undefined) {
    throw new HotelJourneyTemplateError(
      'SUBJECT_NOT_ALLOWED',
      `A ${HOTEL_JOURNEY_CHANNEL_LABELS[template.channel]} message has no subject line.`
    );
  }

  const allowed = HOTEL_JOURNEY_PLACEHOLDERS[template.moment];
  const used = [
    ...journeyPlaceholdersUsed(template.subject ?? ''),
    ...journeyPlaceholdersUsed(template.body),
  ];
  const unknown = used.find((name) => !allowed.includes(name));
  if (unknown !== undefined)
    throw new HotelJourneyTemplateError(
      'UNKNOWN_PLACEHOLDER',
      `{{${unknown}}} is not available at "${HOTEL_JOURNEY_MOMENT_LABELS[template.moment]}". Available: ${allowed
        .map((name) => `{{${name}}}`)
        .join(', ')}.`
    );
}

export type HotelJourneyRenderContext = Readonly<Record<string, string | number>>;

export type HotelJourneyRendered = {
  subject: string | null;
  body: string;
  placeholders: string[];
};

/**
 * UPS-04 rendering. Validates first, then substitutes; a placeholder the context
 * has no value for is an error, so a message never goes out saying "your room is
 * ready in room ." An empty string is a value — a property with no phone number
 * on file says so by passing `''`, not by omitting the key.
 */
export function renderJourneyTemplate(
  template: HotelJourneyTemplateShape,
  context: HotelJourneyRenderContext
): HotelJourneyRendered {
  validateJourneyTemplate(template);
  const placeholders = [
    ...journeyPlaceholdersUsed(template.subject ?? ''),
    ...journeyPlaceholdersUsed(template.body),
  ].filter((name, index, all) => all.indexOf(name) === index);

  const missing = placeholders.find((name) => !Object.hasOwn(context, name));
  if (missing !== undefined)
    throw new HotelJourneyTemplateError(
      'MISSING_PLACEHOLDER_VALUE',
      `This message needs a value for {{${missing}}} and none was supplied.`
    );

  const substitute = (text: string): string =>
    text.replace(PLACEHOLDER_PATTERN, (_match, name: string) => String(context[name]));

  return {
    subject: template.subject === null ? null : substitute(template.subject),
    body: substitute(template.body),
    placeholders,
  };
}

/**
 * The approval machine. DRAFT is the only editable state; APPROVED is reached
 * once and left only by retirement; RETIRED is terminal.
 *
 * There is deliberately no APPROVED → DRAFT edge. Re-opening an approved
 * template would change words a property already stands behind without anyone
 * approving the change; the way to change them is a new version.
 */
const JOURNEY_TRANSITIONS: Record<
  HotelJourneyTemplateStatusValue,
  readonly HotelJourneyTemplateStatusValue[]
> = {
  DRAFT: ['APPROVED', 'RETIRED'],
  APPROVED: ['RETIRED'],
  RETIRED: [],
};

export function journeyTransitionsFrom(
  status: HotelJourneyTemplateStatusValue
): readonly HotelJourneyTemplateStatusValue[] {
  return JOURNEY_TRANSITIONS[status];
}

export function assertJourneyTransition(
  from: HotelJourneyTemplateStatusValue,
  to: HotelJourneyTemplateStatusValue
): void {
  if (!JOURNEY_TRANSITIONS[from].includes(to))
    throw new HotelJourneyTemplateError(
      'INVALID_TRANSITION',
      from === 'APPROVED' && to === 'DRAFT'
        ? 'An approved template cannot be reopened. Draft a new version instead.'
        : `A ${HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS[from].toLowerCase()} template cannot become ${HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS[to].toLowerCase()}.`
    );
}

export type HotelJourneyApproval = {
  status: HotelJourneyTemplateStatusValue;
  approvedByUserId: string | null;
  approvedAt: Date | null;
};

/**
 * What a caller last read of one version, as its client sends it back with a
 * write: the version's `updatedAt` and, where the write stands behind the words
 * (an approval), rewrites them (a draft edit) or retires a draft, the exact
 * wording it showed.
 *
 * A read on the server is no substitute. Every write runs under the property
 * lock, so a row read there is always the current one and can never tell that
 * a colleague changed it after the caller's screen was drawn — that is only
 * visible against what the caller itself read.
 */
export type HotelJourneyTemplateReading = {
  updatedAt: Date;
  /** Compared when present; `null` is a reading of "no subject line". */
  subject?: string | null;
  /** Compared when present. */
  body?: string;
};

const CHANGED_WHILE_WORKING =
  'This message changed while you were working. Reload the current version before trying again.';

/**
 * Refuse a write whose caller read another version than the stored one. The
 * wording is compared whenever the caller sent it, because two writes can share
 * a timestamp: `updatedAt` alone does not prove the words are the ones read.
 */
export function assertJourneyTemplateAsRead(
  template: Pick<HotelJourneyTemplateShape, 'subject' | 'body'> & { updatedAt: Date },
  reading: HotelJourneyTemplateReading
): void {
  const asRead =
    template.updatedAt.getTime() === reading.updatedAt.getTime() &&
    (reading.subject === undefined || template.subject === reading.subject) &&
    (reading.body === undefined || template.body === reading.body);
  if (!asRead)
    throw new HotelJourneyTemplateError('CONCURRENT_MODIFICATION', CHANGED_WHILE_WORKING);
}

/**
 * A draft is rewritten in place under one version number, and two writes can
 * share a millisecond, so the time alone never shows which of a draft's words a
 * caller read. A write bound to a draft (an edit, a retirement) must name the
 * wording too; an approved or retired version's words never change, so its time
 * and the transition rules suffice. Checked here at run time, after
 * {@link assertJourneyTemplateAsRead}, rather than left to the input contract:
 * `journeyTemplateDraftInput`'s refinement only holds while every `.extend()`
 * that joins the property selection onto it keeps it.
 */
export function assertJourneyDraftWordingNamed(
  template: { status: HotelJourneyTemplateStatusValue },
  reading: HotelJourneyTemplateReading
): void {
  if (template.status === 'DRAFT' && (reading.subject === undefined || reading.body === undefined))
    throw new HotelJourneyTemplateError(
      'READING_INCOMPLETE',
      'Name the draft you read by its time and its wording together.'
    );
}

/**
 * The state a conditional write is scoped to: the row as just read, with the
 * caller's reading laid over it, so the database itself — not only
 * {@link assertJourneyTemplateAsRead} — refuses a version that moved on since
 * the caller read it. The wording is compared as well as the lifecycle
 * version: draft edits keep their version number, and two writes can share a
 * timestamp, so neither version nor updatedAt alone proves that we are writing
 * over the copy that was read. Callers add their organization/property
 * predicates to this snapshot.
 */
export function journeyTemplateExpectedState(
  template: HotelJourneyTemplateShape & {
    id: string;
    version: number;
    status: HotelJourneyTemplateStatusValue;
    updatedAt: Date;
  },
  reading?: HotelJourneyTemplateReading
) {
  return {
    id: template.id,
    moment: template.moment,
    channel: template.channel,
    language: template.language,
    version: template.version,
    status: template.status,
    updatedAt: reading?.updatedAt ?? template.updatedAt,
    subject: reading?.subject !== undefined ? reading.subject : template.subject,
    body: reading?.body ?? template.body,
  };
}

/** A conditional write must win exactly once; a lost race is never success. */
export function assertJourneyTemplateWrite(count: number): void {
  if (count !== 1)
    throw new HotelJourneyTemplateError('CONCURRENT_MODIFICATION', CHANGED_WHILE_WORKING);
}

/**
 * The write an approval produces. The approver and the moment of approval are
 * recorded together — the database CHECK refuses one without the other, and this
 * is where that pair is built so no caller has to remember.
 */
export function approveJourneyTemplate(
  template: { status: HotelJourneyTemplateStatusValue } & HotelJourneyTemplateShape,
  approval: { approvedByUserId: string; approvedAt: Date }
): HotelJourneyApproval {
  assertJourneyTransition(template.status, 'APPROVED');
  if (!approval.approvedByUserId.trim())
    throw new HotelJourneyTemplateError(
      'APPROVER_REQUIRED',
      'An approval must record who approved it.'
    );
  // Approving is the last moment the words can still be refused, and the copy
  // may have been drafted before a placeholder catalogue changed.
  validateJourneyTemplate(template);
  return {
    status: 'APPROVED',
    approvedByUserId: approval.approvedByUserId,
    approvedAt: approval.approvedAt,
  };
}

/** Retiring keeps the approval facts: who approved a retired wording is history. */
export function retireJourneyTemplate(template: {
  status: HotelJourneyTemplateStatusValue;
  approvedByUserId: string | null;
  approvedAt: Date | null;
}): HotelJourneyApproval {
  assertJourneyTransition(template.status, 'RETIRED');
  return {
    status: 'RETIRED',
    approvedByUserId: template.approvedByUserId,
    approvedAt: template.approvedAt,
  };
}

/**
 * A consent event in the platform's shape (pharmacy MKT-01, read only):
 * append-only and versioned, highest version wins, a revoked event is not
 * consent.
 */
export type HotelJourneyConsentEvent = {
  purpose: HotelJourneyConsentPurpose;
  channel: HotelJourneyChannelValue;
  version: number;
  granted: boolean;
  revokedAt?: Date | null;
};

/** The current consent for one purpose and channel, or null if none was recorded. */
export function currentJourneyConsent(
  events: readonly HotelJourneyConsentEvent[],
  purpose: HotelJourneyConsentPurpose,
  channel: HotelJourneyChannelValue
): HotelJourneyConsentEvent | null {
  return (
    events
      .filter((event) => event.purpose === purpose && event.channel === channel)
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

/** Quiet hours as minutes of the property's local day; `null` when not observed. */
export type HotelJourneyQuietHours = { startMinute: number; endMinute: number } | null;

export type HotelJourneySettings = {
  quietHours: HotelJourneyQuietHours;
};

/**
 * PTA/consumer practice and the pack's own campaign default: nothing
 * promotional between 21:00 and 08:00 property-local, unless a property says
 * otherwise in `journey_settings`.
 */
export const DEFAULT_HOTEL_QUIET_HOURS: HotelJourneyQuietHours = {
  startMinute: 21 * 60,
  endMinute: 8 * 60,
};

const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function minutesFromHhmm(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = HHMM.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Read quiet hours out of the property's `journey_settings` JSONB. Unreadable or
 * absent settings fall back to the default rather than to "no quiet hours": a
 * malformed policy must not become permission to message a guest at 03:00.
 *
 * `{"quietHours": {"observed": false}}` is how a property switches them off, and
 * it has to say so explicitly.
 */
export function parseJourneySettings(value: unknown): HotelJourneySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { quietHours: DEFAULT_HOTEL_QUIET_HOURS };
  const quiet = (value as { quietHours?: unknown }).quietHours;
  if (!quiet || typeof quiet !== 'object' || Array.isArray(quiet))
    return { quietHours: DEFAULT_HOTEL_QUIET_HOURS };
  const candidate = quiet as { observed?: unknown; start?: unknown; end?: unknown };
  if (candidate.observed === false) return { quietHours: null };
  const startMinute = minutesFromHhmm(candidate.start);
  const endMinute = minutesFromHhmm(candidate.end);
  if (startMinute === null || endMinute === null || startMinute === endMinute)
    return { quietHours: DEFAULT_HOTEL_QUIET_HOURS };
  return { quietHours: { startMinute, endMinute } };
}

/** The property-local minute of day for an instant, DST-correct. */
export function propertyMinuteOfDay(instant: Date, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant);
  } catch (error) {
    throw new Error(
      `Invalid property timezone "${timezone}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  // hourCycle 'h23' renders midnight as 00; guard the historical '24' quirk.
  const hour = lookup('hour') % 24;
  const minute = lookup('minute');
  if (Number.isNaN(hour) || Number.isNaN(minute))
    throw new Error(`Could not resolve property-local time in timezone "${timezone}".`);
  return hour * 60 + minute;
}

/** Quiet hours normally wrap midnight, so the window is a ring, not a range. */
export function withinQuietHours(minuteOfDay: number, quietHours: HotelJourneyQuietHours): boolean {
  if (!quietHours) return false;
  const { startMinute, endMinute } = quietHours;
  return startMinute > endMinute
    ? minuteOfDay >= startMinute || minuteOfDay < endMinute
    : minuteOfDay >= startMinute && minuteOfDay < endMinute;
}

export type HotelJourneySendRefusal =
  'TEMPLATE_NOT_APPROVED' | 'NO_CONSENT' | 'CONSENT_WITHDRAWN' | 'QUIET_HOURS';

export type HotelJourneySendDecision =
  { ok: true } | { ok: false; reason: HotelJourneySendRefusal; message: string };

export type HotelJourneyCanSendInput = {
  template: {
    moment: HotelJourneyMomentValue;
    channel: HotelJourneyChannelValue;
    status: HotelJourneyTemplateStatusValue;
  };
  /** The guest's consent events; empty is "nothing recorded", which is a refusal. */
  consentEvents: readonly HotelJourneyConsentEvent[];
  /** The property's `journey_settings` JSONB, or already-parsed settings. */
  journeySettings: unknown;
  /** The property's IANA timezone — quiet hours are its local clock, not UTC. */
  timezone: string;
  now: Date;
};

const REFUSAL_MESSAGES: Record<HotelJourneySendRefusal, string> = {
  TEMPLATE_NOT_APPROVED: 'This template is not approved, so it cannot be sent to a guest.',
  NO_CONSENT: 'No consent is recorded for this guest on this channel.',
  CONSENT_WITHDRAWN: 'This guest has withdrawn consent for this channel.',
  QUIET_HOURS: 'It is quiet hours at this property; this message waits until they end.',
};

/**
 * UPS-04's send gate, as a pure function. H4 calls it immediately before it
 * sends; this lane calls it only from tests and the preview.
 *
 * Order matters and is the order an operator would explain it in: an unapproved
 * template is refused whoever the guest is; then consent, which is the guest's
 * own decision; then quiet hours, which only defer and only defer an offer. A
 * booking confirmation is the answer to something the guest just did, so holding
 * it until 08:00 would be a worse failure than sending it at 02:00.
 */
export function canSendJourneyMessage(input: HotelJourneyCanSendInput): HotelJourneySendDecision {
  const refuse = (reason: HotelJourneySendRefusal): HotelJourneySendDecision => ({
    ok: false,
    reason,
    message: REFUSAL_MESSAGES[reason],
  });

  if (input.template.status !== 'APPROVED') return refuse('TEMPLATE_NOT_APPROVED');

  const purpose = journeyConsentPurpose(input.template.moment);
  const consent = currentJourneyConsent(input.consentEvents, purpose, input.template.channel);
  if (!consent) return refuse('NO_CONSENT');
  if (!consent.granted || consent.revokedAt) return refuse('CONSENT_WITHDRAWN');

  if (HOTEL_JOURNEY_MOMENT_KINDS[input.template.moment] === 'PROMOTIONAL') {
    const { quietHours } = parseJourneySettings(input.journeySettings);
    if (withinQuietHours(propertyMinuteOfDay(input.now, input.timezone), quietHours))
      return refuse('QUIET_HOURS');
  }

  return { ok: true };
}

/**
 * The EN and UR drafts a new property starts with — plain, professional copy,
 * every one of them a DRAFT so nothing reaches a guest until the property has
 * read it and approved it.
 *
 * WhatsApp carries all eight moments because the journey is WhatsApp-native
 * (§5.17); e-mail carries the two moments that are documents a guest keeps. SMS
 * is left for the property to add, because its cost and length are the
 * property's decision, not a default.
 */
const EN: Record<HotelJourneyMomentValue, string> = {
  BOOKING_CONFIRMED:
    'Dear {{guest_name}}, your booking at {{property_name}} is confirmed. Reference {{reservation_code}}. Arrival {{check_in_date}} from {{check_in_time}}, departure {{check_out_date}} by {{check_out_time}}, {{nights}} night(s) in a {{room_type}}. Total {{total_amount}}. For any change, call us on {{property_phone}}.',
  PRE_ARRIVAL_UPSELL:
    'Dear {{guest_name}}, your stay at {{property_name}} begins on {{check_in_date}}. {{offer_name}} is available for your booking {{reservation_code}}: {{offer_description}} for {{offer_price}}. To accept, open {{offer_link}} before {{offer_expires_at}}. If you would rather not, no action is needed.',
  SELF_CHECKIN:
    'Dear {{guest_name}}, you can complete check-in for booking {{reservation_code}} before you arrive at {{property_name}}. Open {{checkin_link}} and enter your details; the link works until {{checkin_expires_at}}. Reception opens for arrivals on {{check_in_date}} from {{check_in_time}}.',
  WELCOME:
    'Dear {{guest_name}}, welcome to {{property_name}}. You are in room {{room_number}}. Wi-Fi network {{wifi_network}}, password {{wifi_password}}. Departure is {{check_out_date}} by {{check_out_time}}. Reception is on {{property_phone}} at any hour.',
  IN_STAY:
    'Dear {{guest_name}}, we hope room {{room_number}} at {{property_name}} is comfortable. If anything needs attention, reply to this message or open {{stay_page_link}} to send a request to the front desk.',
  EXPRESS_CHECKOUT:
    'Dear {{guest_name}}, departure from room {{room_number}} at {{property_name}} is {{check_out_date}} by {{check_out_time}}. Your balance is {{balance_due}}. To settle and leave without stopping at reception, open {{checkout_link}}.',
  INVOICE:
    'Dear {{guest_name}}, thank you for staying at {{property_name}}. Invoice {{invoice_number}} for your departure on {{check_out_date}} totals {{invoice_total}}. A copy is at {{invoice_link}}. For any question, call {{property_phone}}.',
  REVIEW_REQUEST:
    'Dear {{guest_name}}, thank you for staying at {{property_name}} until {{check_out_date}}. If you have a moment, we would value your review at {{review_link}}. If anything fell short, please tell us first on {{property_phone}}.',
};

const UR: Record<HotelJourneyMomentValue, string> = {
  BOOKING_CONFIRMED:
    'محترم {{guest_name}}، {{property_name}} میں آپ کی بکنگ کی تصدیق ہو گئی ہے۔ حوالہ نمبر {{reservation_code}}۔ آمد {{check_in_date}} کو {{check_in_time}} سے، روانگی {{check_out_date}} کو {{check_out_time}} تک، {{nights}} رات، کمرہ {{room_type}}۔ کل رقم {{total_amount}}۔ کسی تبدیلی کے لیے {{property_phone}} پر رابطہ کیجیے۔',
  PRE_ARRIVAL_UPSELL:
    'محترم {{guest_name}}، {{property_name}} میں آپ کا قیام {{check_in_date}} سے شروع ہو رہا ہے۔ آپ کی بکنگ {{reservation_code}} کے لیے {{offer_name}} دستیاب ہے: {{offer_description}}، قیمت {{offer_price}}۔ منظوری کے لیے {{offer_expires_at}} سے پہلے {{offer_link}} کھولیے۔ اگر دلچسپی نہ ہو تو کچھ کرنے کی ضرورت نہیں۔',
  SELF_CHECKIN:
    'محترم {{guest_name}}، آپ {{property_name}} پہنچنے سے پہلے بکنگ {{reservation_code}} کے لیے چیک اِن مکمل کر سکتے ہیں۔ {{checkin_link}} کھول کر اپنی تفصیلات درج کیجیے؛ یہ لنک {{checkin_expires_at}} تک کارآمد ہے۔ {{check_in_date}} کو استقبالیہ {{check_in_time}} سے مہمانوں کے لیے کھلا ہے۔',
  WELCOME:
    'محترم {{guest_name}}، {{property_name}} میں خوش آمدید۔ آپ کا کمرہ {{room_number}} ہے۔ وائی فائی نیٹ ورک {{wifi_network}}، پاس ورڈ {{wifi_password}}۔ روانگی {{check_out_date}} کو {{check_out_time}} تک ہے۔ استقبالیہ ہر وقت {{property_phone}} پر دستیاب ہے۔',
  IN_STAY:
    'محترم {{guest_name}}، امید ہے {{property_name}} میں کمرہ {{room_number}} آرام دہ ہے۔ کسی بھی ضرورت کے لیے اس پیغام کا جواب دیجیے یا {{stay_page_link}} کھول کر استقبالیہ کو درخواست بھیجیے۔',
  EXPRESS_CHECKOUT:
    'محترم {{guest_name}}، {{property_name}} میں کمرہ {{room_number}} سے روانگی {{check_out_date}} کو {{check_out_time}} تک ہے۔ آپ کے ذمے واجب الادا رقم {{balance_due}} ہے۔ استقبالیہ پر رکے بغیر ادائیگی اور روانگی کے لیے {{checkout_link}} کھولیے۔',
  INVOICE:
    'محترم {{guest_name}}، {{property_name}} میں قیام کا شکریہ۔ {{check_out_date}} کی روانگی کا انوائس {{invoice_number}} ہے، کل رقم {{invoice_total}}۔ نقل {{invoice_link}} پر موجود ہے۔ کسی سوال کے لیے {{property_phone}} پر رابطہ کیجیے۔',
  REVIEW_REQUEST:
    'محترم {{guest_name}}، {{check_out_date}} تک {{property_name}} میں قیام کا شکریہ۔ اگر وقت ہو تو {{review_link}} پر اپنی رائے ضرور دیجیے۔ اگر کوئی کمی رہ گئی ہو تو پہلے ہمیں {{property_phone}} پر بتائیے۔',
};

const EMAIL_SUBJECTS: Partial<
  Record<HotelJourneyMomentValue, Record<HotelJourneyLanguageValue, string>>
> = {
  BOOKING_CONFIRMED: {
    EN: 'Your booking at {{property_name}} is confirmed — {{reservation_code}}',
    UR: '{{property_name}} میں آپ کی بکنگ کی تصدیق — {{reservation_code}}',
  },
  INVOICE: {
    EN: 'Invoice {{invoice_number}} from {{property_name}}',
    UR: '{{property_name}} کی جانب سے انوائس {{invoice_number}}',
  },
};

/** The moments a new property gets an e-mail draft for: the ones a guest keeps. */
const SEEDED_EMAIL_MOMENTS: readonly HotelJourneyMomentValue[] = ['BOOKING_CONFIRMED', 'INVOICE'];

export type HotelJourneyTemplateSeed = {
  moment: HotelJourneyMomentValue;
  channel: HotelJourneyChannelValue;
  language: HotelJourneyLanguageValue;
  subject: string | null;
  body: string;
  version: number;
  status: 'DRAFT';
};

/**
 * The drafts seeded when a property is created. Every one is a DRAFT: UPS-04
 * requires approval before use, and seeding APPROVED copy would be exactly the
 * "seed data fakes readiness" move the onboarding checklist exists to refuse.
 */
export function defaultJourneyTemplateSeeds(): HotelJourneyTemplateSeed[] {
  const seeds: HotelJourneyTemplateSeed[] = [];
  for (const moment of HOTEL_JOURNEY_MOMENTS) {
    for (const language of HOTEL_JOURNEY_LANGUAGES) {
      seeds.push({
        moment,
        channel: 'WHATSAPP',
        language,
        subject: null,
        body: (language === 'UR' ? UR : EN)[moment],
        version: 1,
        status: 'DRAFT',
      });
      if (!SEEDED_EMAIL_MOMENTS.includes(moment)) continue;
      seeds.push({
        moment,
        channel: 'EMAIL',
        language,
        subject: EMAIL_SUBJECTS[moment]![language],
        body: (language === 'UR' ? UR : EN)[moment],
        version: 1,
        status: 'DRAFT',
      });
    }
  }
  return seeds;
}

/**
 * The input contracts the `hotelProperty.journeyTemplates` procedures validate
 * against, so the page, the router and the tests agree on what a template may
 * be told. Kept beside the rules they feed rather than in the router, for the
 * same reason `property.ts` keeps its own.
 */
export const journeyTemplateKeyInput = z.object({
  moment: z.enum(HotelJourneyMoment),
  channel: z.enum(HotelJourneyChannel),
  language: z.enum(HotelJourneyLanguage),
});

/** The `updatedAt` of the version the caller last read. */
const expectedUpdatedAt = z.coerce.date();

/**
 * The wording the caller last read, compared exactly: never trimmed, because
 * it is not copy to store but proof of what was on screen.
 */
const expectedSubject = z.string().max(200).nullable();
const expectedBody = z.string().min(1).max(4000);

export const journeyTemplateDraftInput = journeyTemplateKeyInput
  .extend({
    /** Absent on WhatsApp and SMS; `validateJourneyTemplate` refuses it there. */
    subject: z.string().trim().min(1).max(200).nullable().optional(),
    body: z.string().trim().min(1).max(4000),
    /**
     * The draft this save rewrites, as its editor read it. A message that has a
     * draft is only rewritten by a save naming the version it was read at, and
     * a save naming one is refused once there is no draft left to rewrite —
     * the one it was editing has been approved or retired since. A new draft,
     * or the replacement of approved wording, names none.
     */
    expectedUpdatedAt: expectedUpdatedAt.optional(),
    expectedSubject: expectedSubject.optional(),
    expectedBody: expectedBody.optional(),
  })
  .refine(
    (input) =>
      (input.expectedUpdatedAt === undefined) === (input.expectedSubject === undefined) &&
      (input.expectedUpdatedAt === undefined) === (input.expectedBody === undefined),
    {
      path: ['expectedUpdatedAt'],
      message: 'Name the version this edit was made from by its time and its wording together.',
    }
  );

export const journeyTemplateIdInput = z.object({ id: z.string().trim().min(1).max(191) });

/**
 * Retiring names the version the caller read; a version changed since is a
 * conflict. Retiring a draft names its wording as well, because a colleague's
 * save can share the time the draft was read at; an approved version's words
 * never change, so its time is enough.
 */
export const journeyTemplateRetireInput = journeyTemplateIdInput.extend({
  expectedUpdatedAt,
  expectedSubject: expectedSubject.optional(),
  expectedBody: expectedBody.optional(),
});

/**
 * Approving names the version and the exact wording the approver read, so
 * words changed since — even within the same millisecond — are never approved
 * under their name, and the approved version this approval retires, so a
 * colleague's approval made since is not retired unseen.
 */
export const journeyTemplateApproveInput = journeyTemplateRetireInput.extend({
  expectedSubject,
  expectedBody,
  /** The approved version of this message the approver saw, or `null` when there was none. */
  expectedApprovedId: z.string().trim().min(1).max(191).nullable(),
});

/**
 * A preview context. Values arrive as strings from a form; numbers are accepted
 * because a caller holding a night count should not have to stringify it.
 */
export const journeyTemplatePreviewInput = journeyTemplateIdInput.extend({
  context: z.record(z.string().min(1).max(64), z.union([z.string().max(200), z.number()])),
});

export type HotelJourneyTemplateDraftInput = z.infer<typeof journeyTemplateDraftInput>;
