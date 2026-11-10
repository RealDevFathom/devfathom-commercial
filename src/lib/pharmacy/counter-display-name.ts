type CounterMedicineIdentity = { brandName?: string | null; displayName: string };

/** Catalog blanks fall back to the generic without reserving an empty row. */
export function counterMedicineDisplayName(medicine: CounterMedicineIdentity): string {
  return medicine.brandName?.trim() || medicine.displayName;
}

export function counterMedicineGenericName(medicine: CounterMedicineIdentity): string | null {
  const brand = medicine.brandName?.trim();
  const generic = medicine.displayName.trim();
  return brand && generic && brand.toLocaleLowerCase() !== generic.toLocaleLowerCase()
    ? generic
    : null;
}
