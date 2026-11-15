import type { RxOcrAdapterName, RxOcrExtraction, RxOcrField } from './rx-ocr';

/**
 * DEV-63: turn a read Rx photo into a DRAFT cart for pharmacist review.
 *
 * Each read line is matched to catalogue medicines by salt (active ingredients)
 * and strength, so a prescription written as one brand can be filled with any
 * stocked medicine of the same salt and strength. The draft is a proposal: it
 * writes nothing, it is never a sale, and every line stays unconfirmed. The
 * pharmacist confirms lines into the prescription capture form, and a sale of a
 * prescription medicine is still released only by the pharmacist's RX-03 sign.
 */

export type RxDraftCatalogueMedicine = Readonly<{
  id: string;
  productName: string;
  brandName: string | null;
  strengths: readonly Readonly<{
    ingredientId: string;
    ingredientName: string;
    value: string | number;
    unit: string;
  }>[];
  presentations: readonly Readonly<{ id: string; presentation: string }>[];
}>;

export type RxDraftMatchKind = 'SALT_AND_STRENGTH' | 'SALT_ONLY';

export type RxDraftCandidate = Readonly<{
  medicineId: string;
  label: string;
  /** Salt label, e.g. "Amoxicillin 250 mg". */
  salt: string;
  matchKind: RxDraftMatchKind;
  /** True when the catalogue name itself matches what was read. */
  nameMatch: boolean;
  presentations: readonly Readonly<{ id: string; label: string }>[];
}>;

export type RxDraftCartLine = Readonly<{
  lineNumber: number;
  drugName: RxOcrField;
  strength: RxOcrField;
  dose: RxOcrField;
  /** Below the configured confidence threshold: the pharmacist must read the photo. */
  lowConfidence: boolean;
  candidates: readonly RxDraftCandidate[];
  /** A suggestion only when one exact salt-and-strength match exists. Never confirmed. */
  suggestedMedicineId: string | null;
  suggestedPresentationId: string | null;
  confirmed: false;
}>;

export type RxDraftCart = Readonly<{
  status: 'DRAFT';
  requiresPharmacistConfirmation: true;
  adapter: RxOcrAdapterName;
  adapterVersion: string;
  lines: readonly RxDraftCartLine[];
  unmatchedLineNumbers: readonly number[];
}>;

export type RxDraftCartOptions = {
  /** Field confidence below which a line is flagged. A configured value, not a fact. */
  minConfidence: number;
  /** Candidates kept per line. */
  maxCandidates?: number;
};

const words = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

const UNIT_SCALE: Record<string, { family: string; factor: number }> = {
  g: { family: 'mass', factor: 1_000_000 },
  mg: { family: 'mass', factor: 1_000 },
  mcg: { family: 'mass', factor: 1 },
  ug: { family: 'mass', factor: 1 },
  µg: { family: 'mass', factor: 1 },
  ml: { family: 'volume', factor: 1 },
  iu: { family: 'iu', factor: 1 },
  '%': { family: 'percent', factor: 1 },
};

/** Normalized "family:amount" key, so 0.5 g and 500 mg compare equal. */
function strengthKey(value: number, unit: string): string | null {
  const scale = UNIT_SCALE[unit.trim().toLowerCase().split('/')[0] ?? ''];
  if (!scale || !Number.isFinite(value) || value <= 0) return null;
  return `${scale.family}:${Math.round(value * scale.factor * 1000) / 1000}`;
}

/** "500/125 mg", "250mg", "0.5 g" → sorted strength keys; [] when unreadable. */
export function parseReadStrength(read: string | null): string[] {
  if (!read) return [];
  const match = /^\s*(\d+(?:\.\d+)?(?:\s*[/+]\s*\d+(?:\.\d+)?)*)\s*(mcg|µg|ug|mg|g|ml|iu|%)/i.exec(
    read
  );
  if (!match) return [];
  const keys = match[1]!.split(/[/+]/).map((amount) => strengthKey(Number(amount), match[2]!));
  return keys.every((key): key is string => key !== null) ? keys.sort() : [];
}

function saltSet(medicine: RxDraftCatalogueMedicine): string {
  return [...new Set(medicine.strengths.map((s) => s.ingredientId))].sort().join('|');
}

function strengthKeys(medicine: RxDraftCatalogueMedicine): string[] {
  return medicine.strengths
    .map((s) => strengthKey(Number(s.value), s.unit))
    .filter((key): key is string => key !== null)
    .sort();
}

function saltLabel(medicine: RxDraftCatalogueMedicine): string {
  return medicine.strengths
    .map((s) => `${s.ingredientName} ${Number(s.value)} ${s.unit}`)
    .join(' + ');
}

function nameMatches(read: string[], names: readonly (string | null)[]): boolean {
  const first = read[0];
  if (!first || first.length < 3) return false;
  return names.some((name) => {
    const tokens = words(name ?? '');
    return tokens.includes(first) || (tokens[0]?.startsWith(first) ?? false);
  });
}

/**
 * The salt read for a line: the ingredients of a catalogue medicine whose name
 * matches, or a single ingredient whose own name was written (a generic Rx).
 */
function readSalts(read: string[], catalogue: readonly RxDraftCatalogueMedicine[]): Set<string> {
  const salts = new Set<string>();
  for (const medicine of catalogue) {
    if (medicine.strengths.length && nameMatches(read, [medicine.productName, medicine.brandName]))
      salts.add(saltSet(medicine));
    if (
      medicine.strengths.length === 1 &&
      nameMatches(read, [medicine.strengths[0]!.ingredientName])
    )
      salts.add(saltSet(medicine));
  }
  return salts;
}

export function buildRxDraftCart(
  extraction: RxOcrExtraction,
  catalogue: readonly RxDraftCatalogueMedicine[],
  options: RxDraftCartOptions
): RxDraftCart {
  if (!(options.minConfidence >= 0 && options.minConfidence <= 1))
    throw new RangeError('minConfidence must be between 0 and 1.');
  const maxCandidates = options.maxCandidates ?? 5;
  const lines = extraction.lines.map((line, index): RxDraftCartLine => {
    const read = words(line.drugName.value ?? '');
    const salts = readSalts(read, catalogue);
    const wanted = parseReadStrength(line.strength.value).join('|');
    const rank = { SALT_AND_STRENGTH: 0, SALT_ONLY: 1 } as const;
    const candidates = catalogue
      .filter((medicine) => medicine.strengths.length && salts.has(saltSet(medicine)))
      .map((medicine): RxDraftCandidate => ({
        medicineId: medicine.id,
        label: medicine.productName,
        salt: saltLabel(medicine),
        matchKind:
          wanted && strengthKeys(medicine).join('|') === wanted ? 'SALT_AND_STRENGTH' : 'SALT_ONLY',
        nameMatch: nameMatches(read, [medicine.productName, medicine.brandName]),
        presentations: medicine.presentations.map((p) => ({ id: p.id, label: p.presentation })),
      }))
      .sort(
        (a, b) =>
          rank[a.matchKind] - rank[b.matchKind] ||
          Number(b.nameMatch) - Number(a.nameMatch) ||
          a.label.localeCompare(b.label) ||
          a.medicineId.localeCompare(b.medicineId)
      )
      .slice(0, maxCandidates);
    const exact = candidates.filter((c) => c.matchKind === 'SALT_AND_STRENGTH');
    const suggested = exact.length === 1 ? exact[0]! : null;
    return {
      lineNumber: index + 1,
      drugName: line.drugName,
      strength: line.strength,
      dose: line.dose,
      lowConfidence: [line.drugName, line.strength].some(
        (field) => field.confidence < options.minConfidence
      ),
      candidates,
      suggestedMedicineId: suggested?.medicineId ?? null,
      suggestedPresentationId:
        suggested?.presentations.length === 1 ? suggested.presentations[0]!.id : null,
      confirmed: false,
    };
  });
  return {
    status: 'DRAFT',
    requiresPharmacistConfirmation: true,
    adapter: extraction.adapter,
    adapterVersion: extraction.adapterVersion,
    lines,
    unmatchedLineNumbers: lines.filter((l) => !l.candidates.length).map((l) => l.lineNumber),
  };
}
