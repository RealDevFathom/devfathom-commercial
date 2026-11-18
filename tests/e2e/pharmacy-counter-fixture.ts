/**
 * PH-POS counter E2E fixture — the seeded workspace the browser spec drives.
 *
 * Ids are fixed so the seed is idempotent and the spec can assert against
 * specific rows rather than against "whatever came back first".
 */
export const PHARMACY_E2E = {
  organizationId: 'org_pharmacy_counter_e2e',
  packageId: 'package_pharmacy_counter_e2e',
  roleId: 'role_pharmacy_counter_e2e_admin',
  adminId: 'user_pharmacy_counter_e2e_admin',
  /** DEV-621/DEV-501: the administrator's own staff PIN, re-entered for every return and refund. */
  adminStaffProfileId: 'staff_pharmacy_counter_e2e_admin',
  adminPinCredentialId: 'credential_pharmacy_counter_e2e_admin_pin',
  adminPin: '2468',
  cashierRoleId: 'role_pharmacy_counter_e2e_cashier',
  cashierId: 'user_pharmacy_counter_e2e_cashier',
  cashierEmail: 'cashier.counter@pharmacy-counter-e2e.devfathom.invalid',
  cashierCounterPermissionId: 'perm_pharmacy_counter_e2e_cashier_counter',
  cashierOrdersPermissionId: 'perm_pharmacy_counter_e2e_cashier_orders',
  cashierAssignmentId: 'pba_pharmacy_counter_e2e_cashier',
  /** DEV-497: the Pharmacist whose landing the spec proves (dispense + catalogue review). */
  pharmacistRoleId: 'role_pharmacy_counter_e2e_pharmacist',
  pharmacistId: 'user_pharmacy_counter_e2e_pharmacist',
  pharmacistEmail: 'pharmacist.counter@pharmacy-counter-e2e.devfathom.invalid',
  pharmacistAssignmentId: 'pba_pharmacy_counter_e2e_pharmacist',
  /**
   * DEV-751: the procedures (SOP) team the browser lane drives on desktop and phone.
   * The manager sets procedures up and checks them; the pharmacist does the work.
   * Two people, so the manager's role grant to the pharmacist is never a self-grant.
   */
  sop: {
    managerRoleId: 'role_pharmacy_counter_e2e_sop_manager',
    managerId: 'user_pharmacy_counter_e2e_sop_manager',
    managerEmail: 'sop.manager@pharmacy-counter-e2e.devfathom.invalid',
    managerAssignmentId: 'pba_pharmacy_counter_e2e_sop_manager',
    managerCapabilities: ['sop:manage', 'sop:complete', 'sop:verify'],
    pharmacistRoleId: 'role_pharmacy_counter_e2e_sop_pharmacist',
    pharmacistId: 'user_pharmacy_counter_e2e_sop_pharmacist',
    pharmacistEmail: 'sop.pharmacist@pharmacy-counter-e2e.devfathom.invalid',
    pharmacistAssignmentId: 'pba_pharmacy_counter_e2e_sop_pharmacist',
    /** The qualified-person procedure role needs the exact dispense grant. */
    pharmacistCapabilities: ['pharmacy:dispense', 'sop:complete'],
  },
  branchId: 'branch_pharmacy_counter_e2e',
  branchName: 'Gulberg Counter E2E',
  branchCode: 'PCE-1',
  stockLocationId: 'stock_location_pharmacy_counter_e2e',
  stockLocationCode: 'STORE-1',
  quarantineLocationId: 'stock_location_pharmacy_counter_e2e_quarantine',
  patientId: 'patient_pharmacy_counter_e2e',
  patientName: 'Ayesha Karim E2E',
  prescriberId: 'prescriber_pharmacy_counter_e2e',
  prescriptionId: 'prescription_pharmacy_counter_e2e',
  ingredientId: 'ingredient_pharmacy_counter_e2e_paracetamol',

  /**
   * The three bills the spec completes, drawn from the 10-bill counter corpus:
   * a plain OTC strip sale, a loose-unit sale that exercises the pack/strip/unit
   * toggle, and a prescription-only line that must stay blocked until a signed
   * prescription is attached.
   */
  medicines: {
    /** OTC tablet. BOX(10 strips) → STRIP(10 tablets) → UNIT. */
    otc: {
      id: 'medicine_pharmacy_counter_e2e_otc',
      name: 'Fathomol E2E',
      brandName: 'Fathomol',
      strength: '500 mg',
      presentationId: 'presentation_pharmacy_counter_e2e_otc',
      presentation: 'Tablet',
      packLevelIds: {
        box: 'pack_level_pharmacy_counter_e2e_otc_box',
        strip: 'pack_level_pharmacy_counter_e2e_otc_strip',
        unit: 'pack_level_pharmacy_counter_e2e_otc_unit',
      },
      batchId: 'batch_pharmacy_counter_e2e_otc',
      batchNumber: 'FTH-2201',
      /** Scanned by the spec to prove barcode resolution (MED-03). */
      barcode: '8964000111222',
      alias: 'bukhar goli',
      unitsPerPack: 100,
      printedMrpMinor: 25_000,
      onHandUnits: 500,
    },
    /** Syrup with no strip level: BOTTLE(60 ml) → UNIT. */
    syrup: {
      id: 'medicine_pharmacy_counter_e2e_syrup',
      name: 'Fathomcof E2E',
      strength: '100 mg',
      presentationId: 'presentation_pharmacy_counter_e2e_syrup',
      presentation: 'Syrup',
      packLevelIds: {
        bottle: 'pack_level_pharmacy_counter_e2e_syrup_bottle',
        unit: 'pack_level_pharmacy_counter_e2e_syrup_unit',
      },
      batchId: 'batch_pharmacy_counter_e2e_syrup',
      batchNumber: 'FCF-3301',
      unitsPerPack: 60,
      printedMrpMinor: 18_000,
      onHandUnits: 300,
    },
    /** Prescription-only tablet: the POS-09 safety-block subject. */
    rx: {
      id: 'medicine_pharmacy_counter_e2e_rx',
      name: 'Fathomcillin E2E',
      strength: '250 mg',
      presentationId: 'presentation_pharmacy_counter_e2e_rx',
      presentation: 'Capsule',
      packLevelIds: {
        box: 'pack_level_pharmacy_counter_e2e_rx_box',
        strip: 'pack_level_pharmacy_counter_e2e_rx_strip',
        unit: 'pack_level_pharmacy_counter_e2e_rx_unit',
      },
      batchId: 'batch_pharmacy_counter_e2e_rx',
      batchNumber: 'FCL-4401',
      prescriptionLineId: 'prescription_line_pharmacy_counter_e2e_rx',
      unitsPerPack: 80,
      printedMrpMinor: 40_000,
      onHandUnits: 240,
    },
  },
} as const;

/**
 * Expected money, derived the same way MED-08 derives it, so the spec asserts a
 * figure rather than echoing whatever the page rendered.
 *
 * Fathomol: 250.00 per box of 100 → 2.50 per tablet → 25.00 per strip of 10.
 * Fathomcof: 180.00 per 60 ml bottle → 3.00 per ml.
 */
export const PHARMACY_E2E_EXPECTED = {
  otcStripPrice: '25.00',
  otcTwoStripTotal: '50.00',
  syrupUnitPrice: '3.00',
  syrupTenUnitTotal: '30.00',
} as const;
