/** DEV-1002: how many rows that could not be created the creation panel lists by name. */
export const NOT_CREATED_LISTED = 10;

export type NotCreatedRow = {
  rowId: string;
  rowNumber: number;
  productName: string;
  reason: string;
};

/** The first rows of a "not created" review page, for the creation panel. */
export function notCreatedList(result: {
  total: number;
  rows: readonly {
    id: string;
    rowNumber: number;
    productName: string | null;
    notCreatedReason: string | null;
  }[];
}): { total: number; rows: NotCreatedRow[] } {
  return {
    total: result.total,
    rows: result.rows.slice(0, NOT_CREATED_LISTED).flatMap((row) =>
      row.notCreatedReason
        ? [
            {
              rowId: row.id,
              rowNumber: row.rowNumber,
              productName: row.productName ?? '',
              reason: row.notCreatedReason,
            },
          ]
        : []
    ),
  };
}
