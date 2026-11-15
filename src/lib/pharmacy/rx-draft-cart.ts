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
const UNIT = String.raw`(mcg|µg|ug|mg|g|ml|iu|%)`;
const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
/** An optional per-volume denominator: "/ml", "/5 ml", "/ 5ml". */
const PER_VOLUME = new RegExp(String.raw`\s*/\s*${NUMBER}?\s*ml\s*$`, 'i');

/**
 * Normalized "family:amount[/ml]" key, so 0.5 g equals 500 mg and 250 mg/5 ml
 * equals 50 mg/ml. A concentration keeps its denominator; an unknown unit or
 * denominator yields null, which never counts as a strength match.
 */
function strengthKey(value: number, unit: string, perMl: number | null): string | null {
  const scale = UNIT_SCALE[unit.trim().toLowerCase()];
  if (!scale || !Number.isFinite(value) || value <= 0) return null;
  if (perMl !== null && !(Number.isFinite(perMl) && perMl > 0)) return null;
  const amount = (value * scale.factor) / (perMl ?? 1);
  return `${scale.family}:${Math.round(amount * 1000) / 1000}${perMl === null ? '' : '/ml'}`;
}

function splitDenominator(text: string): { rest: string; perMl: number | null } {
  const match = PER_VOLUME.exec(text);
  if (!match) return { rest: text, perMl: null };
  return { rest: text.slice(0, match.index), perMl: match[1] ? Number(match[1]) : 1 };
}

/** A catalogue unit such as "mg", "mg/ml" or "mg/5 ml". */
function catalogueStrengthKey(value: string | number, unit: string): string | null {
  const { rest, perMl } = splitDenominator(unit);
  if (rest.includes('/')) return null;
  return strengthKey(Number(value), rest, perMl);
}

/**
 * Read strengths IN WRITTEN ORDER: "500/125 mg", "500 mg + 125 mg", "250mg",
 * "0.5 g", "250 mg/5 ml". [] when any part is unreadable.
 */
export function parseReadStrength(read: string | null): string[] {
  if (!read) return [];
  const { rest, perMl } = splitDenominator(read.trim());
  const parts = rest.split(/\s*[/+]\s*/);
  const parsed = parts.map((part) => new RegExp(`^${NUMBER}\\s*${UNIT}?$`, 'i').exec(part.trim()));
  if (!parsed.length || parsed.some((match) => !match)) return [];
  const fallbackUnit = parsed[parsed.length - 1]![2];
  if (!fallbackUnit) return [];
  const keys = parsed.map((match) =>
    strengthKey(Number(match![1]), match![2] ?? fallbackUnit, perMl)
  );
  return keys.every((key): key is string => key !== null) ? keys : [];
}

function saltSet(medicine: RxDraftCatalogueMedicine): string {
  return [...new Set(medicine.strengths.map((s) => s.ingredientId))].sort().join('|');
}

/** "ingredient=strength" per ingredient, so combinations keep which amount is whose. */
function profileKey(pairs: readonly (readonly [string, string | null])[]): string | null {
  if (pairs.some(([, key]) => key === null)) return null;
  return pairs
    .map(([ingredient, key]) => `${ingredient}=${key}`)
    .sort()
    .join('|');
}

function medicineProfile(medicine: RxDraftCatalogueMedicine): string | null {
  return profileKey(
    medicine.strengths.map((s) => [s.ingredientId, catalogueStrengthKey(s.value, s.unit)] as const)
  );
}

function sortedKeys(medicine: RxDraftCatalogueMedicine): string | null {
  const keys = medicine.strengths.map((s) => catalogueStrengthKey(s.value, s.unit));
  return keys.every((key) => key !== null) ? keys.sort().join('|') : null;
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

type ReadSalt = {
  /** Sorted ingredient ids of every salt the read name can mean. */
  salts: Set<string>;
  /** Per-ingredient strength profiles that count as an exact match. */
  exactProfiles: Set<string>;
};

/**
 * What a line names. A generic Rx lists ingredients ("Amoxicillin + Clavulanic
 * acid"): every part must be a whole catalogue ingredient name, or nothing is
 * matched, so a combination is never resolved to one of its parts. A brand Rx
 * resolves through catalogue medicines of that name, whose own per-ingredient
 * strengths say which written amount belongs to which ingredient.
 */
function readSalt(
  drugName: string | null,
  strengths: string[],
  catalogue: readonly RxDraftCatalogueMedicine[]
): ReadSalt {
  const result: ReadSalt = { salts: new Set(), exactProfiles: new Set() };
  if (!drugName) return result;
  const ingredients = new Map<string, string>();
  for (const medicine of catalogue)
    for (const s of medicine.strengths)
      ingredients.set(words(s.ingredientName).join(' '), s.ingredientId);
  const parts = drugName
    .split(/\s*(?:\+|\/|,|&|\band\b|\bwith\b)\s*/i)
    .map((part) => words(part).join(' '))
    .filter(Boolean);
  const named = parts.map((part) => ingredients.get(part));

  if (parts.length && named.every((id): id is string => id !== undefined)) {
    const salt = [...new Set(named)].sort().join('|');
    result.salts.add(salt);
    if (new Set(named).size === named.length && strengths.length === named.length) {
      const profile = profileKey(named.map((id, i) => [id, strengths[i]!] as const));
      if (profile) result.exactProfiles.add(profile);
    }
    return result;
  }
  if (parts.length !== 1) return result;

  const read = words(drugName);
  const wanted = [...strengths].sort().join('|');
  const brandProfiles = new Map<string, Set<string>>();
  for (const medicine of catalogue) {
    if (
      !medicine.strengths.length ||
      !nameMatches(read, [medicine.productName, medicine.brandName])
    )
      continue;
    const salt = saltSet(medicine);
    result.salts.add(salt);
    const profile = medicineProfile(medicine);
    if (wanted && profile && sortedKeys(medicine) === wanted) {
      brandProfiles.set(salt, (brandProfiles.get(salt) ?? new Set()).add(profile));
    }
  }
  for (const salt of result.salts) {
    const ids = salt.split('|');
    if (ids.length === 1 && strengths.length === 1) {
      // One ingredient, one amount: the association cannot be ambiguous.
      const profile = profileKey([[ids[0]!, strengths[0]!]]);
      if (profile) result.exactProfiles.add(profile);
    } else {
      // Two same-name products whose amounts pair differently are ambiguous: no exact match.
      const profiles = brandProfiles.get(salt);
      if (profiles?.size === 1) result.exactProfiles.add([...profiles][0]!);
    }
  }
  return result;
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
    const { salts, exactProfiles } = readSalt(
      line.drugName.value,
      parseReadStrength(line.strength.value),
      catalogue
    );
    const rank = { SALT_AND_STRENGTH: 0, SALT_ONLY: 1 } as const;
    const candidates = catalogue
      .filter((medicine) => medicine.strengths.length && salts.has(saltSet(medicine)))
      .map((medicine): RxDraftCandidate => ({
        medicineId: medicine.id,
        label: medicine.productName,
        salt: saltLabel(medicine),
        matchKind: exactProfiles.has(medicineProfile(medicine) ?? '')
          ? 'SALT_AND_STRENGTH'
          : 'SALT_ONLY',
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
