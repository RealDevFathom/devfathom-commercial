/**
 * Opening-stock import helpers: the single entry-point URL, the branch and
 * stock location the importer starts on, and plain-language explanations for
 * the rows the preview cannot import yet.
 */

export const OPENING_IMPORT_ROUTE = '/pharmacy/inventory/import';
export const IMPORTED_STOCK_ROUTE = '/pharmacy/inventory/imports';
export const MEDICINE_CATALOGUE_ROUTE = '/pharmacy/medicines';
export const MEDICINE_REVIEW_ROUTE = '/pharmacy/medicines/staged';

/** The one link every inventory surface uses to start an opening-stock import. */
export function openingImportHref(branchId?: string | null): string {
  return branchId
    ? `${OPENING_IMPORT_ROUTE}?${new URLSearchParams({ branch: branchId })}`
    : OPENING_IMPORT_ROUTE;
}

type TargetOptions = {
  branches: ReadonlyArray<{ id: string }>;
  locations: ReadonlyArray<{ id: string; branchId: string; kind?: string | null }>;
};

/** Holding areas that never receive a fresh opening count by default. */
const HOLDING_KINDS = new Set(['QUARANTINE', 'TRANSIT', 'RETURNS']);
/** Ordinary shelves first, then other storage, before any holding area. */
const RECEIVING_PREFERENCE = ['STORE', 'RACK_BIN'];

/**
 * Starts the importer on the working branch (when it is one of the caller's
 * branches, else the first branch) and that branch's first receiving location.
 */
export function defaultImportTarget(
  options: TargetOptions,
  preferredBranchId?: string | null
): { branchId: string; stockLocationId: string } {
  const branch =
    options.branches.find((item) => item.id === preferredBranchId) ?? options.branches[0];
  if (!branch) return { branchId: '', stockLocationId: '' };
  const own = options.locations.filter((location) => location.branchId === branch.id);
  const rank = (kind?: string | null) => {
    const preferred = RECEIVING_PREFERENCE.indexOf(kind ?? '');
    if (preferred >= 0) return preferred;
    return kind && HOLDING_KINDS.has(kind)
      ? RECEIVING_PREFERENCE.length + 1
      : RECEIVING_PREFERENCE.length;
  };
  const location = [...own].sort((a, b) => rank(a.kind) - rank(b.kind))[0];
  return { branchId: branch.id, stockLocationId: location?.id ?? '' };
}

export type ImportRowLine = {
  medicineName: string | null;
  packReference: string;
  unitsPerPack: number | null;
  errors: readonly string[];
};

export type ImportRowProblem = {
  /** What is wrong, in a few words. */
  title: string;
  /** What to do about it. */
  detail: string;
  /** Present when the fix happens in the medicine catalogue. */
  medicine?: { pickHref: string; reviewHref: string };
};

const MEDICINE_MATCH_ERROR = 'Match exactly one published medicine pack';

const KNOWN_PROBLEMS: Array<[prefix: string, title: string, detail: string]> = [
  [
    'Source reference must be nonempty',
    'Row reference missing or repeated',
    'Give every row its own reference (up to 160 characters) in the Source reference column, then preview again.',
  ],
  [
    'Supply the printed manufacturing batch',
    'Batch number missing',
    'Copy the batch number printed on the pack into the batch column (up to 160 characters).',
  ],
  [
    'Supply a future expiry',
    'Expiry date missing, unreadable or already passed',
    'Write the expiry as YYYY-MM or YYYY-MM-DD. Expired stock cannot be loaded as opening stock.',
  ],
  [
    'MRP and cost must be',
    'Price or cost is not a plain amount',
    'Use plain numbers such as 125 or 125.50, with no currency sign or commas.',
  ],
  [
    'Exported and physical counts must be',
    'Quantity is not a whole number',
    'Enter the old-system quantity and your shelf count as whole single units (tablets, capsules, bottles). Write 0 when there are none.',
  ],
  [
    'Explain the difference between',
    'Shelf count differs from the old system with no reason',
    'Add a short reason in the variance column, for example "2 strips damaged".',
  ],
  [
    'This medicine requires a cold-chain',
    'This medicine must be kept cold',
    'Choose a fridge (cold-chain) stock location above, or move this row to a separate file for the fridge.',
  ],
  [
    'Duplicate medicine/batch/pack row',
    'Same medicine, batch and pack appears twice',
    'Combine these rows into one row with the total count.',
  ],
  [
    'Rows for the same medicine and batch must agree',
    'One batch has two different expiry dates',
    'Check the printed expiry and use the same date on every row of this batch.',
  ],
  [
    'Existing batch is blocked or its expiry conflicts',
    'This batch is already on record with a different expiry, or it is blocked',
    'Check the expiry printed on the pack. A recalled or quarantined batch cannot be loaded.',
  ],
  [
    'This branch already holds a lot',
    'Already in stock at this branch',
    'This medicine, batch and pack is already held here. Correct it with a physical count on the Inventory page instead.',
  ],
  [
    'This source reference was already used',
    'Row reference already used in an earlier import',
    'Give this row a different reference, for example by adding the branch code in front.',
  ],
];

const query = (route: string, term: string) =>
  term ? `${route}?${new URLSearchParams({ query: term })}` : route;

function medicineProblem(line: ImportRowLine): ImportRowProblem {
  const term = (line.medicineName ?? line.packReference).trim();
  const medicine = {
    pickHref: query(MEDICINE_CATALOGUE_ROUTE, term),
    reviewHref: query(MEDICINE_REVIEW_ROUTE, term),
  };
  if (!line.medicineName)
    return {
      title: line.packReference
        ? `No medicine in your catalogue has pack code ${line.packReference}`
        : 'No pack code on this row',
      detail:
        'Pick the matching medicine and add this barcode or pack ID to its pack, or request the medicine for review. A requested medicine is checked in catalogue review and only becomes available after it is published.',
      medicine,
    };
  if (line.unitsPerPack === null)
    return {
      title: `Pack size unknown for ${line.medicineName}`,
      detail:
        'The medicine was found, but its pack does not say how many single units it holds, so the count cannot be converted. Set the units per pack on this medicine in the catalogue, then preview again.',
      medicine,
    };
  return {
    title: `${line.medicineName} is not published for sale yet`,
    detail: 'Finish reviewing and publishing this medicine in the catalogue, then preview again.',
    medicine,
  };
}

/** One plain-language problem per error on the row, in the order they were found. */
export function explainImportRow(line: ImportRowLine): ImportRowProblem[] {
  return line.errors.map((error) => {
    if (error.startsWith(MEDICINE_MATCH_ERROR)) return medicineProblem(line);
    const known = KNOWN_PROBLEMS.find(([prefix]) => error.startsWith(prefix));
    return known
      ? { title: known[1], detail: known[2] }
      : { title: 'This row needs a fix', detail: error };
  });
}
