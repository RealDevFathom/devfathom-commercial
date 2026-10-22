import { readExpiryDate, readMoneyMinor, readQuantity } from '../source-values';
import type { ColumnMapping, PresetTargetField } from './synonyms';

export type ParsedPresetRow = Partial<Record<PresetTargetField, string | bigint | Date>>;

/** Apply canonical value readers without defaulting invalid incumbent data. */
export function parseMappedRow(
  row: Readonly<Record<string, string>>,
  mapping: ColumnMapping
): ParsedPresetRow {
  const parsed: ParsedPresetRow = {};
  for (const [source, target] of Object.entries(mapping)) {
    const raw = row[source]?.trim();
    if (!raw) continue;
    if (target === 'expiry') {
      const value = readExpiryDate(raw);
      if (value) parsed[target] = value;
    } else if (target === 'opening_qty' || target === 'pack_size' || target === 'reorder_level') {
      const value = readQuantity(raw);
      if (value !== null) parsed[target] = value;
    } else if (
      target === 'retail_price' ||
      target === 'trade_price' ||
      target === 'credit_limit' ||
      target === 'balance_owed'
    ) {
      const value = readMoneyMinor(raw);
      if (value !== null) parsed[target] = value;
    } else parsed[target] = raw;
  }
  return parsed;
}

export type TallyBatch = {
  batchName: string | null;
  expiry: Date | null;
  quantity: string | null;
  godown: string | null;
};
export type TallyStockItem = {
  name: string;
  baseUnit: string | null;
  openingBalance: string | null;
  batches: readonly TallyBatch[];
};

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(value: string): string {
  return value
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_all, entity: string) => {
      if (entity[0] === '#')
        return String.fromCodePoint(
          Number.parseInt(
            entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1),
            entity[1]?.toLowerCase() === 'x' ? 16 : 10
          )
        );
      return entities[entity.toLowerCase()] ?? _all;
    })
    .trim();
}
function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml);
  return match ? decodeXml(match[1]!.replace(/<[^>]+>/g, '')) : null;
}

/** Parse Tally's documented STOCKITEM/BATCHALLOCATIONS subset; no side effects. */
export function parseTallyXml(xml: string): readonly TallyStockItem[] {
  const items: TallyStockItem[] = [];
  for (const match of xml.matchAll(/<STOCKITEM(?:\s[^>]*)?>([\s\S]*?)<\/STOCKITEM>/gi)) {
    const body = match[1]!;
    const openingBalance = tag(body, 'OPENINGBALANCE');
    const batches: TallyBatch[] = [];
    for (const batchMatch of body.matchAll(
      /<BATCHALLOCATIONS\.LIST(?:\s[^>]*)?>([\s\S]*?)<\/BATCHALLOCATIONS\.LIST>/gi
    )) {
      const batch = batchMatch[1]!;
      batches.push({
        batchName: tag(batch, 'BATCHNAME'),
        expiry: readExpiryDate(tag(batch, 'EXPIRYPERIOD') ?? undefined),
        quantity: tag(batch, 'ACTUALQTY') ?? tag(batch, 'OPENINGBALANCE'),
        godown: tag(batch, 'GODOWNNAME'),
      });
    }
    const name = tag(body, 'NAME') ?? /\bNAME="([^"]+)"/i.exec(match[0])?.[1];
    if (name)
      items.push({
        name: decodeXml(name),
        baseUnit: tag(body, 'BASEUNITS'),
        openingBalance,
        batches,
      });
  }
  return items;
}
