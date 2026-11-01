// Client-safe: the rail imports these without pulling in the ABAC engine.

/**
 * What a signed-in pharmacy member may open beyond the counter. Each flag is
 * resolved through the same capability checks the server procedures enforce,
 * so pages and the rail never offer a surface the server would refuse.
 *
 * - `commandCentre`: the owner dashboard — Owner/Admin (session ADMIN), anyone
 *   holding `reports:operational`, and managers (`pharmacy:manage`).
 * - `dayClose`: session ADMIN or `pharmacy:close` (mirrors `requireCloseAccess`).
 * - `reports`: `reports:operational` (the `pharmacyReports` capability gate).
 * - `inventoryControl`: `pharmacy:inventory` (create location, write-off, …).
 * - `inventoryImport`: session ADMIN (the owner-import router is admin-only).
 * - `dispense`: `pharmacy:dispense` (pharmacist queue, substitution, Rx fill).
 * - `prescriptions`: `pharmacy:prescriptions` (the prescription workspace; a
 *   dispense grant covers it, and tenant administrators hold it by policy).
 * - `purchasing`: `pharmacy:procurement` (suppliers, requisitions, orders,
 *   goods-in and returns; tenant administrators without a role keep it).
 * - `administration`: Team and Settings in the rail — session ADMIN or
 *   `pharmacy:manage`. Counter and clinical staff are not offered them; Settings
 *   stays reachable from the account menu for their own profile.
 */
export type PharmacyStaffAccess = {
  commandCentre: boolean;
  dayClose: boolean;
  reports: boolean;
  inventoryControl: boolean;
  inventoryImport: boolean;
  dispense: boolean;
  prescriptions: boolean;
  purchasing: boolean;
  administration: boolean;
};

export const NO_PHARMACY_STAFF_ACCESS: PharmacyStaffAccess = {
  commandCentre: false,
  dayClose: false,
  reports: false,
  inventoryControl: false,
  inventoryImport: false,
  dispense: false,
  prescriptions: false,
  purchasing: false,
  administration: false,
};
