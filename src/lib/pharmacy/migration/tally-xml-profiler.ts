/**
 * #721 — the Tally XML import preset for the PH-MIG profiler.
 *
 * Tally's master export ("All Masters", Export → XML) is the best-documented
 * incumbent format this lane meets: an `ENVELOPE` of `TALLYMESSAGE` elements, each
 * carrying one master — `UNIT`, `GROUP`, `STOCKITEM` (with `BATCHALLOCATIONS.LIST`
 * and `EXPIRYPERIOD`) or `LEDGER`.
 *
 * TWO STAGES, ONE PROFILING PASS. `flattenTallyXml` turns the XML into a plain
 * `SourceTable` with fixed headers; `tallyXmlProfiler` is an ordinary
 * `SourceProfiler` over that table. The exception rules therefore stay the single
 * shared pass in `profiler.ts` — Tally cannot disagree with Abuzar or Excel about
 * what "missing MRP" means — and the result feeds the existing workbench, batch,
 * exception and parallel-run flow unchanged.
 *
 * NOTHING IS GUESSED. A value the flattener cannot translate exactly (a rate
 * quoted per a different unit, a compound-unit quantity, an unknown date form) is
 * passed through as the raw Tally text, so the shared pass reports it as an
 * unreadable value instead of this module inventing a conversion. Every flattened
 * row also keeps the Tally source text in its unmapped evidence columns.
 *
 * SAFE BY CONSTRUCTION. The XML reader below is deliberately minimal: no DTD, no
 * custom entities, no external references. A document declaring a DOCTYPE or
 * ENTITY is refused outright, which closes XXE and entity-expansion attacks
 * without depending on a third-party parser's defaults.
 *
 * ── Assumptions, TO CONFIRM against customer files ─────────────────────────
 *  1. Ledger amounts follow Tally's XML sign convention: debit negative, credit
 *     positive. A supplier (Sundry Creditors) credit balance is what the pharmacy
 *     owes; a customer (Sundry Debtors) debit balance is what it is owed. Both
 *     are stored as a POSITIVE amount owed in the party's natural direction, and
 *     the raw signed Tally figure is kept in `Tally Opening Balance`.
 *  2. `OPENINGRATE` is the cost per base unit; `MRPRATE` is the retail price per
 *     base unit. Neither is converted between units.
 *  3. A simple, whole-number base unit (e.g. `Nos`, `Strip`) is one canonical
 *     unit, so the pack label is `1 <unit>`. Any other unit is passed through raw
 *     and raises UNIT_AMBIGUOUS.
 *  4. A `BATCHNAME` of "Primary Batch" is Tally's placeholder for an item that
 *     does not track batches, and is reported as a missing batch.
 */
import { MIGRATION_TARGET_KEYS } from './mapping-targets';
import type { ColumnMap, ProfiledRow, SourceField, SourceProfiler } from './profiler';
import { readMoneyMinor, type SourceTable } from './source-values';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal, hardened XML reader
// ─────────────────────────────────────────────────────────────────────────────

export type TallyXmlErrorReason =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'TOO_DEEP'
  | 'DTD_FORBIDDEN'
  | 'MALFORMED'
  | 'UNKNOWN_ENTITY'
  | 'NOT_TALLY'
  | 'UNDECODABLE';

export class TallyXmlError extends Error {
  constructor(
    readonly reason: TallyXmlErrorReason,
    detail?: string
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'TallyXmlError';
  }
}

export type XmlElement = {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
};

/** Generous for any single-pharmacy master export; refuses pathological input. */
const MAX_XML_CHARS = 64 * 1024 * 1024;
const MAX_DEPTH = 128;

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&([^;\s&]{1,16});/g, (_match, body: string) => {
    if (body.startsWith('#')) {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new TallyXmlError('UNKNOWN_ENTITY', `&${body};`);
      }
      return String.fromCodePoint(codePoint);
    }
    const value = PREDEFINED_ENTITIES[body];
    if (value === undefined) throw new TallyXmlError('UNKNOWN_ENTITY', `&${body};`);
    return value;
  });
}

const NAME_PATTERN = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;
const ATTRIBUTE_PATTERN = /^([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/;

/**
 * Parse an XML document into an element tree. Throws `TallyXmlError` on anything
 * it does not fully understand rather than returning a partial tree.
 */
export function parseXml(text: string): XmlElement {
  if (text.length > MAX_XML_CHARS) throw new TallyXmlError('TOO_LARGE');
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.trim().length === 0) throw new TallyXmlError('EMPTY');

  const root: XmlElement = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let index = 0;

  while (index < source.length) {
    const open = source.indexOf('<', index);
    const textEnd = open === -1 ? source.length : open;
    if (textEnd > index) {
      const chunk = source.slice(index, textEnd);
      const current = stack[stack.length - 1]!;
      if (current === root) {
        if (chunk.trim().length > 0) throw new TallyXmlError('MALFORMED', 'text outside root');
      } else {
        current.text += decodeEntities(chunk);
      }
    }
    if (open === -1) break;

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end === -1) throw new TallyXmlError('MALFORMED', 'unterminated comment');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      if (end === -1) throw new TallyXmlError('MALFORMED', 'unterminated CDATA');
      const current = stack[stack.length - 1]!;
      if (current === root) throw new TallyXmlError('MALFORMED', 'CDATA outside root');
      current.text += source.slice(open + 9, end);
      index = end + 3;
      continue;
    }
    if (source.startsWith('<!', open)) {
      // DOCTYPE, ENTITY, ELEMENT … — the vectors for XXE and entity expansion.
      throw new TallyXmlError('DTD_FORBIDDEN');
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      if (end === -1) throw new TallyXmlError('MALFORMED', 'unterminated declaration');
      index = end + 2;
      continue;
    }

    const close = findTagEnd(source, open + 1);
    if (close === -1) throw new TallyXmlError('MALFORMED', 'unterminated tag');
    const inner = source.slice(open + 1, close);
    index = close + 1;

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const current = stack.pop();
      if (!current || current === root || current.name !== name) {
        throw new TallyXmlError('MALFORMED', `unexpected </${name}>`);
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = NAME_PATTERN.exec(body);
    if (!nameMatch) throw new TallyXmlError('MALFORMED', 'invalid tag name');
    const element: XmlElement = {
      name: nameMatch[0],
      attributes: parseAttributes(body.slice(nameMatch[0].length)),
      children: [],
      text: '',
    };

    const parent = stack[stack.length - 1]!;
    if (parent === root && root.children.length > 0) {
      throw new TallyXmlError('MALFORMED', 'more than one root element');
    }
    parent.children.push(element);
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_DEPTH + 1) throw new TallyXmlError('TOO_DEEP');
    }
  }

  if (stack.length !== 1) throw new TallyXmlError('MALFORMED', 'unclosed element');
  const [documentElement] = root.children;
  if (!documentElement) throw new TallyXmlError('EMPTY');
  return documentElement;
}

/** Index of the `>` closing a tag, skipping any `>` inside a quoted attribute. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let rest = raw.trim();
  while (rest.length > 0) {
    const match = ATTRIBUTE_PATTERN.exec(rest);
    if (!match) throw new TallyXmlError('MALFORMED', 'invalid attribute');
    attributes[match[1]!] = decodeEntities(match[3] ?? match[4] ?? '');
    rest = rest.slice(match[0].length).trim();
  }
  return attributes;
}

/**
 * Decode the bytes of a Tally export to text. Tally commonly writes UTF-16LE with
 * a byte-order mark; newer releases write UTF-8. A stream that is neither is
 * refused rather than decoded lossily, because a silently mangled item name
 * would misidentify a medicine.
 */
export function decodeTallyXmlBytes(bytes: Uint8Array): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    }
    // UTF-16LE without a BOM: "<" followed by a NUL byte.
    if (bytes[0] === 0x3c && bytes[1] === 0x00) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TallyXmlError) throw error;
    throw new TallyXmlError('UNDECODABLE');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tally masters → SourceTable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tally marks reserved names with control characters (`&#4; Primary`). They are
 * never part of the name a pharmacist sees.
 */
function clean(raw: string | undefined): string {
  let printable = '';
  for (const character of raw ?? '') {
    const code = character.charCodeAt(0);
    // Keep TAB, LF and CR (whitespace, collapsed below); drop other C0 controls.
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) printable += character;
  }
  return printable.replace(/\s+/g, ' ').trim();
}

function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((candidate) => candidate.name === name);
}

function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((candidate) => candidate.name === name);
}

function childText(element: XmlElement, name: string): string {
  return clean(child(element, name)?.text);
}

/** A master's name: the `NAME` attribute, else the first `NAME` beneath it. */
function masterName(element: XmlElement): string {
  const attribute = clean(element.attributes['NAME']);
  if (attribute) return attribute;
  const queue = [...element.children];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (next.name === 'NAME') {
      const value = clean(next.text);
      if (value) return value;
    }
    // Only descend into name containers, never into allocations or details.
    if (next.name === 'NAME.LIST' || next.name === 'LANGUAGENAME.LIST') {
      queue.push(...next.children);
    }
  }
  return '';
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const MONTHS: Readonly<Record<string, string>> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/**
 * Tally writes dates as `YYYYMMDD` in data fields and `1-Mar-2027` in display
 * fields such as `EXPIRYPERIOD`. Both become ISO `YYYY-MM-DD`, preserving the
 * exact day Tally recorded. Any other form is returned raw so the shared pass
 * reports it as unreadable.
 */
export function normalizeTallyDate(raw: string): string {
  const value = clean(raw);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const display = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2}|\d{4})$/.exec(value);
  if (display) {
    const month = MONTHS[display[2]!.slice(0, 3).toLowerCase()];
    if (!month) return value;
    const year = display[3]!.length === 2 ? `20${display[3]}` : display[3]!;
    return `${year}-${month}-${display[1]!.padStart(2, '0')}`;
  }
  return value;
}

/**
 * `" 100 Nos"` → `"100"` when the unit is the item's base unit. A quantity in
 * any other unit (or a compound `"2 Box 5 Nos"`) is returned raw.
 */
function stripQuantityUnit(raw: string, baseUnit: string): string {
  const value = clean(raw);
  const match = /^(-?[\d,]+(?:\.\d+)?)\s*(.*)$/.exec(value);
  if (!match) return value;
  const unit = match[2]!.trim();
  return unit === '' || sameName(unit, baseUnit) ? match[1]! : value;
}

/** `"12.50/Nos"` → `"12.50"` when quoted per the base unit; otherwise raw. */
function stripRateUnit(raw: string, baseUnit: string): string {
  const value = clean(raw);
  const match = /^(-?[\d,]+(?:\.\d+)?)\s*(?:\/\s*(.+))?$/.exec(value);
  if (!match) return value;
  const unit = (match[2] ?? '').trim();
  return unit === '' || sameName(unit, baseUnit) ? match[1]! : value;
}

function absoluteMoney(raw: string): string {
  return clean(raw).replace(/^-/, '');
}

function formatMinor(minor: bigint): string {
  const negative = minor < BigInt(0);
  const magnitude = negative ? -minor : minor;
  const whole = magnitude / BigInt(100);
  const fraction = (magnitude % BigInt(100)).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * The fixed header row of a flattened Tally table. Mapped headers feed the
 * shared profiling pass; the rest are evidence that reaches `rawPayload`.
 */
export const TALLY_HEADERS = [
  'Source Key',
  'Record Type',
  'Stock Item',
  'Stock Group',
  'Base Unit',
  'Pack',
  'Godown',
  'Batch',
  'Tally Batch Name',
  'Mfg Date',
  'Expiry',
  'MRP',
  'Rate',
  'Quantity',
  'Opening Value',
  'Supplier',
  'Customer',
  'Ledger Group',
  'Opening Balance',
  'Tally Opening Balance',
] as const;

type TallyHeader = (typeof TALLY_HEADERS)[number];

/** Tally header → logical field. Fixed, because the flattener writes the headers. */
export const TALLY_COLUMN_MAP: Readonly<Partial<Record<TallyHeader, SourceField>>> = {
  'Source Key': 'sourceKey',
  'Stock Item': 'product',
  Pack: 'pack',
  Batch: 'batch',
  Expiry: 'expiry',
  MRP: 'mrp',
  Rate: 'cost',
  Quantity: 'quantity',
  Supplier: 'supplier',
  Customer: 'customer',
  'Opening Balance': 'balance',
};

/**
 * The fields the issue requires a Tally import to map: stock items, units,
 * batches with expiry, prices, opening quantities, suppliers, customers and
 * opening balances. `unmappedTallyRequiredFields` must be empty for every
 * accepted Tally table.
 */
export const TALLY_REQUIRED_FIELDS: readonly SourceField[] = [
  'sourceKey',
  'product',
  'pack',
  'batch',
  'expiry',
  'mrp',
  'cost',
  'quantity',
  'supplier',
  'customer',
  'balance',
];

export function unmappedTallyRequiredFields(columnMap: ColumnMap): SourceField[] {
  return TALLY_REQUIRED_FIELDS.filter((field) => columnMap[field] === undefined);
}

/** A record the flattener deliberately did not turn into a row, with why. */
export type TallySkippedRecord = {
  master: string;
  name: string;
  reason: 'NOT_A_PARTY_LEDGER' | 'NOT_IMPORTED_MASTER' | 'UNNAMED' | 'UNSUPPORTED_MASTER';
};

/** A discrepancy inside the Tally file itself, surfaced for the operator. */
export type TallyWarning = {
  sourceKey: string;
  detail: string;
};

export type FlattenedTally = {
  table: SourceTable;
  skipped: TallySkippedRecord[];
  warnings: TallyWarning[];
  counts: { units: number; groups: number; stockItems: number; batches: number; ledgers: number };
};

/**
 * Tally's placeholder allocation when an item does not maintain batches. It is
 * not a manufacturer batch number, so it is never mapped as one: the row raises
 * MISSING_BATCH and the placeholder survives as evidence in `Tally Batch Name`.
 */
export const TALLY_PLACEHOLDER_BATCH = 'primary batch';

const SUPPLIER_GROUP = 'sundry creditors';
const CUSTOMER_GROUP = 'sundry debtors';

/** Masters this preset reads, or recognises as irrelevant to a pharmacy opening. */
const KNOWN_MASTERS = new Set([
  'UNIT',
  'GROUP',
  'STOCKITEM',
  'LEDGER',
  'STOCKGROUP',
  'STOCKCATEGORY',
  'GODOWN',
  'CURRENCY',
  'VOUCHERTYPE',
  'COSTCENTRE',
  'COSTCATEGORY',
  'COMPANY',
]);

type UnitInfo = { simple: boolean; decimals: number | null };

/**
 * Flatten a Tally XML export into the fixed-header `SourceTable` that
 * `tallyXmlProfiler` reads.
 *
 * @throws {TallyXmlError} for malformed XML, a forbidden DTD, or a document that
 * is not a Tally `ENVELOPE`.
 */
export function flattenTallyXml(xml: string): FlattenedTally {
  const envelope = parseXml(xml);
  if (envelope.name !== 'ENVELOPE') {
    throw new TallyXmlError('NOT_TALLY', `root element is <${envelope.name}>`);
  }

  const masters: XmlElement[] = [];
  collectMasters(envelope, masters);

  const units = new Map<string, UnitInfo>();
  const groupParents = new Map<string, string>();
  for (const master of masters) {
    if (master.name === 'UNIT') {
      const name = masterName(master);
      if (!name) continue;
      const simpleText = childText(master, 'ISSIMPLEUNIT').toLowerCase();
      const decimalsText = childText(master, 'DECIMALPLACES');
      units.set(name.toLowerCase(), {
        // Tally omits ISSIMPLEUNIT for a simple unit in some exports; a compound
        // unit always declares ISSIMPLEUNIT=No and its BASEUNITS/ADDITIONALUNITS.
        simple:
          simpleText === 'yes' || (simpleText === '' && !childText(master, 'ADDITIONALUNITS')),
        decimals: /^\d+$/.test(decimalsText) ? Number(decimalsText) : null,
      });
    } else if (master.name === 'GROUP') {
      const name = masterName(master);
      if (name) groupParents.set(name.toLowerCase(), childText(master, 'PARENT').toLowerCase());
    }
  }

  const isUnder = (group: string, target: string): boolean => {
    let current = group.toLowerCase();
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === target) return true;
      seen.add(current);
      current = groupParents.get(current) ?? '';
    }
    return false;
  };

  const rows: string[][] = [];
  const skipped: TallySkippedRecord[] = [];
  const warnings: TallyWarning[] = [];
  const usedKeys = new Map<string, number>();
  const counts = {
    units: units.size,
    groups: groupParents.size,
    stockItems: 0,
    batches: 0,
    ledgers: 0,
  };

  const uniqueKey = (key: string): string => {
    const seen = usedKeys.get(key) ?? 0;
    usedKeys.set(key, seen + 1);
    return seen === 0 ? key : `${key}#${seen + 1}`;
  };

  const push = (cells: Partial<Record<TallyHeader, string>>) => {
    rows.push(TALLY_HEADERS.map((header) => cells[header] ?? ''));
  };

  for (const master of masters) {
    if (master.name === 'STOCKITEM') {
      const name = masterName(master);
      if (!name) {
        skipped.push({ master: 'STOCKITEM', name: '', reason: 'UNNAMED' });
        continue;
      }
      counts.stockItems += 1;

      const baseUnit = childText(master, 'BASEUNITS');
      const unit = units.get(baseUnit.toLowerCase());
      const pack =
        baseUnit && unit?.simple && (unit.decimals === null || unit.decimals === 0)
          ? `1 ${baseUnit}`
          : baseUnit;
      const mrp = stripRateUnit(latestMrp(master), baseUnit);
      const common: Partial<Record<TallyHeader, string>> = {
        'Record Type': 'STOCKITEM',
        'Stock Item': name,
        'Stock Group': childText(master, 'PARENT'),
        'Base Unit': baseUnit,
        Pack: pack,
        MRP: mrp,
      };

      const allocations = childrenNamed(master, 'BATCHALLOCATIONS.LIST');
      if (allocations.length === 0) {
        push({
          ...common,
          'Source Key': uniqueKey(`STOCKITEM:${name}`),
          Rate: stripRateUnit(childText(master, 'OPENINGRATE'), baseUnit),
          Quantity: stripQuantityUnit(childText(master, 'OPENINGBALANCE'), baseUnit),
          'Opening Value': absoluteMoney(childText(master, 'OPENINGVALUE')),
        });
        continue;
      }

      let batchQuantityTotal = BigInt(0);
      let batchQuantitiesExact = true;
      for (const allocation of allocations) {
        counts.batches += 1;
        const tallyBatch = childText(allocation, 'BATCHNAME');
        const batch = tallyBatch.toLowerCase() === TALLY_PLACEHOLDER_BATCH ? '' : tallyBatch;
        const godown = childText(allocation, 'GODOWNNAME');
        const expiryElement = child(allocation, 'EXPIRYPERIOD');
        const expiryRaw = clean(expiryElement?.text) || clean(expiryElement?.attributes['P']);
        const quantity = stripQuantityUnit(childText(allocation, 'OPENINGBALANCE'), baseUnit);
        if (/^-?\d+$/.test(quantity)) batchQuantityTotal += BigInt(quantity);
        else batchQuantitiesExact = false;

        push({
          ...common,
          'Source Key': uniqueKey(
            `STOCKITEM:${name}|BATCH:${batch || '-'}${godown ? `|GODOWN:${godown}` : ''}`
          ),
          Godown: godown,
          Batch: batch,
          'Tally Batch Name': tallyBatch,
          'Mfg Date': normalizeTallyDate(childText(allocation, 'MFDON')),
          Expiry: expiryRaw ? normalizeTallyDate(expiryRaw) : '',
          Rate: stripRateUnit(
            childText(allocation, 'OPENINGRATE') || childText(master, 'OPENINGRATE'),
            baseUnit
          ),
          Quantity: quantity,
          'Opening Value': absoluteMoney(childText(allocation, 'OPENINGVALUE')),
        });
      }

      const itemQuantity = stripQuantityUnit(childText(master, 'OPENINGBALANCE'), baseUnit);
      if (
        batchQuantitiesExact &&
        /^-?\d+$/.test(itemQuantity) &&
        BigInt(itemQuantity) !== batchQuantityTotal
      ) {
        const batchTotal = batchQuantityTotal.toString();
        warnings.push({
          sourceKey: `STOCKITEM:${name}`,
          detail: `Item opening ${itemQuantity} ${baseUnit} differs from batch total ${batchTotal}.`,
        });
      }
      continue;
    }

    if (master.name === 'LEDGER') {
      const name = masterName(master);
      if (!name) {
        skipped.push({ master: 'LEDGER', name: '', reason: 'UNNAMED' });
        continue;
      }
      const parent = childText(master, 'PARENT');
      const isSupplier = isUnder(parent, SUPPLIER_GROUP);
      const isCustomer = !isSupplier && isUnder(parent, CUSTOMER_GROUP);
      if (!isSupplier && !isCustomer) {
        skipped.push({ master: 'LEDGER', name, reason: 'NOT_A_PARTY_LEDGER' });
        continue;
      }
      counts.ledgers += 1;

      const rawBalance = childText(master, 'OPENINGBALANCE');
      push({
        'Source Key': uniqueKey(`LEDGER:${name}`),
        'Record Type': 'LEDGER',
        Supplier: isSupplier ? name : '',
        Customer: isCustomer ? name : '',
        'Ledger Group': parent,
        'Opening Balance': partyBalance(rawBalance, isSupplier, name, warnings),
        'Tally Opening Balance': rawBalance,
      });
      continue;
    }

    if (master.name !== 'UNIT' && master.name !== 'GROUP') {
      skipped.push({
        master: master.name,
        name: masterName(master),
        reason: KNOWN_MASTERS.has(master.name) ? 'NOT_IMPORTED_MASTER' : 'UNSUPPORTED_MASTER',
      });
    }
  }

  return { table: { headers: [...TALLY_HEADERS], rows }, skipped, warnings, counts };
}

/** Every master element, whether wrapped in TALLYMESSAGE or not. */
function collectMasters(element: XmlElement, into: XmlElement[]): void {
  for (const node of element.children) {
    if (node.name === 'TALLYMESSAGE') {
      into.push(...node.children);
    } else if (node.name === 'HEADER') {
      continue;
    } else {
      collectMasters(node, into);
    }
  }
}

/** The MRP effective from the latest `FROMDATE`, preferring the "Any" state. */
function latestMrp(item: XmlElement): string {
  let best: { from: string; rate: string } | null = null;
  for (const details of childrenNamed(item, 'MRPDETAILS.LIST')) {
    const from = childText(details, 'FROMDATE');
    const rates = childrenNamed(details, 'MRPRATEDETAILS.LIST').filter(
      (rate) => childText(rate, 'MRPRATE') !== ''
    );
    const chosen =
      rates.find((rate) => sameName(childText(rate, 'STATENAME'), 'Any')) ?? rates[0];
    if (!chosen) continue;
    if (!best || from > best.from) best = { from, rate: childText(chosen, 'MRPRATE') };
  }
  return best?.rate ?? '';
}

/**
 * Translate Tally's signed ledger figure into the positive amount owed in the
 * party's natural direction (see assumption 1). An unreadable figure is passed
 * through raw and warned about, never zeroed.
 */
function partyBalance(
  raw: string,
  isSupplier: boolean,
  name: string,
  warnings: TallyWarning[]
): string {
  if (raw === '') return '';
  const suffix = /^(.*?)\s*(Dr|Cr)\.?$/i.exec(raw);
  let minor: bigint | null;
  if (suffix) {
    const magnitude = readMoneyMinor(suffix[1]!.replace(/^-/, ''));
    minor =
      magnitude === null ? null : suffix[2]!.toLowerCase() === 'dr' ? -magnitude : magnitude;
  } else {
    minor = readMoneyMinor(raw);
  }
  if (minor === null) {
    warnings.push({
      sourceKey: `LEDGER:${name}`,
      detail: `Opening balance "${raw}" is not an exact money amount.`,
    });
    return raw;
  }
  // Credit-positive Tally figure: a supplier's credit is owed BY us (positive),
  // a customer's debit (negative) is owed TO us — flip it to positive.
  return formatMinor(isSupplier ? minor : -minor);
}

// ─────────────────────────────────────────────────────────────────────────────
// The profiler
// ─────────────────────────────────────────────────────────────────────────────

export const tallyXmlProfiler: SourceProfiler = {
  kind: 'TALLY_XML',
  // Bump on any change to the flattener's translation rules or column map.
  version: 'tally-xml/1',

  resolveColumns(table: SourceTable): ColumnMap | null {
    const columnMap: ColumnMap = {};
    for (const [header, field] of Object.entries(TALLY_COLUMN_MAP)) {
      const index = table.headers.indexOf(header);
      if (index === -1) return null;
      if (field) columnMap[field] = index;
    }
    return unmappedTallyRequiredFields(columnMap).length === 0 ? columnMap : null;
  },

  // One stock item appears once per batch per godown in a Tally export.
  duplicateDiscriminator(row: ProfiledRow): string {
    if (row.targetModelKey !== MIGRATION_TARGET_KEYS.PRODUCT) return '';
    const batch = (row.batchNumber ?? '').toLowerCase();
    const godown = (row.rawPayload['Godown'] ?? '').toLowerCase();
    return `${batch}|${godown}`;
  },
};
