export const PAKISTAN_TAX_PROFILE_CATALOG = [
  {
    id: 'PK-PB-RESTAURANT',
    jurisdiction: 'Punjab',
    name: 'Punjab restaurant',
    effectiveFrom: null,
    enabled: false,
    disabledReason: 'A current official PRA rate instrument and accountant approval are required.',
    authorityCode: 'PRA',
    sourceTitle: 'Punjab Sales Tax on Services Act 2012 and Restaurant Services Rules',
    sourceUrl: 'https://reg.pra.punjab.gov.pk/PTMS/SalesTaxAct2012.aspx',
    eligibilityControls: [],
    rules: [],
  },
  {
    id: 'PK-SD-RESTAURANT',
    jurisdiction: 'Sindh',
    name: 'Sindh restaurant — ordinary',
    effectiveFrom: '2024-07-01',
    enabled: true,
    authorityCode: 'SRB',
    sourceTitle: 'SRB Circular 04/2024',
    sourceUrl: 'https://www.srb.gos.pk/srb/wp-content/uploads/2024/06/30-06-2024.pdf',
    eligibilityControls: [],
    rules: [
      { paymentCategory: 'CASH', rate: '0.15', ruleCode: 'SD_ORDINARY_CASH' },
      { paymentCategory: 'CARD', rate: '0.08', ruleCode: 'SD_QUALIFYING_DIGITAL' },
      { paymentCategory: 'OTHER', rate: '0.15', ruleCode: 'SD_ORDINARY_OTHER' },
    ],
  },
  {
    id: 'PK-SD-RESTAURANT-LISTED',
    jurisdiction: 'Sindh',
    name: 'Sindh restaurant — SRB-approved listed branch',
    effectiveFrom: '2024-07-01',
    enabled: true,
    authorityCode: 'SRB',
    sourceTitle: 'SRB approved restaurant branch list',
    sourceUrl: 'https://www.srb.gos.pk/srb/restaurant-list/',
    eligibilityControls: [
      { id: 'srbListedBranch', label: 'This exact branch has current SRB approval/list evidence.' },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.15', ruleCode: 'SD_LISTED_CASH' },
      { paymentCategory: 'CARD', rate: '0.15', ruleCode: 'SD_LISTED_DIGITAL' },
      { paymentCategory: 'OTHER', rate: '0.15', ruleCode: 'SD_LISTED_OTHER' },
    ],
  },
  {
    id: 'PK-KP-RESTAURANT-ORDINARY',
    jurisdiction: 'Khyber Pakhtunkhwa',
    name: 'KP restaurant — ordinary',
    effectiveFrom: '2025-07-01',
    enabled: true,
    authorityCode: 'KPRA',
    sourceTitle: 'Khyber Pakhtunkhwa Finance Act 2025',
    sourceUrl: 'https://kpra.gov.pk/wp-content/uploads/2025/07/kp-finance-act-2025.pdf',
    eligibilityControls: [],
    rules: [
      { paymentCategory: 'CASH', rate: '0.10', ruleCode: 'KP_ORDINARY_CASH' },
      { paymentCategory: 'CARD', rate: '0.06', ruleCode: 'KP_ORDINARY_DIGITAL' },
      { paymentCategory: 'OTHER', rate: '0.10', ruleCode: 'KP_ORDINARY_OTHER' },
    ],
  },
  {
    id: 'PK-KP-RESTAURANT-CORPORATE',
    jurisdiction: 'Khyber Pakhtunkhwa',
    name: 'KP restaurant — corporate',
    effectiveFrom: '2025-07-01',
    enabled: true,
    authorityCode: 'KPRA',
    sourceTitle: 'Khyber Pakhtunkhwa Finance Act 2025',
    sourceUrl: 'https://kpra.gov.pk/wp-content/uploads/2025/07/kp-finance-act-2025.pdf',
    eligibilityControls: [
      { id: 'corporateEntity', label: 'The accountant confirmed this restaurant is corporate.' },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.15', ruleCode: 'KP_CORPORATE_CASH' },
      { paymentCategory: 'CARD', rate: '0.06', ruleCode: 'KP_CORPORATE_DIGITAL' },
      { paymentCategory: 'OTHER', rate: '0.15', ruleCode: 'KP_CORPORATE_OTHER' },
    ],
  },
  {
    id: 'PK-ICT-RESTAURANT',
    jurisdiction: 'Islamabad Capital Territory',
    name: 'ICT restaurant',
    effectiveFrom: '2025-07-01',
    enabled: true,
    authorityCode: 'FBR',
    sourceTitle: 'ICT (Tax on Services) Ordinance 2001, consolidated through 2025-06-30',
    sourceUrl: 'https://download1.fbr.gov.pk/Docs/2025711172945966ICTOUpdatedupto30.06.2025.pdf',
    eligibilityControls: [],
    rules: [
      { paymentCategory: 'CASH', rate: '0.15', ruleCode: 'ICT_RESTAURANT_CASH' },
      { paymentCategory: 'CARD', rate: '0.05', ruleCode: 'ICT_RESTAURANT_DIGITAL' },
      { paymentCategory: 'OTHER', rate: '0.15', ruleCode: 'ICT_RESTAURANT_OTHER' },
    ],
  },
  {
    id: 'PK-ICT-CATERER',
    jurisdiction: 'Islamabad Capital Territory',
    name: 'ICT caterer',
    effectiveFrom: '2025-07-01',
    enabled: true,
    authorityCode: 'FBR',
    sourceTitle: 'ICT (Tax on Services) Ordinance 2001, consolidated through 2025-06-30',
    sourceUrl: 'https://download1.fbr.gov.pk/Docs/2025711172945966ICTOUpdatedupto30.06.2025.pdf',
    eligibilityControls: [
      {
        id: 'catererService',
        label: 'The accountant confirmed the configured service is catering.',
      },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.15', ruleCode: 'ICT_CATERER_CASH' },
      { paymentCategory: 'CARD', rate: '0.15', ruleCode: 'ICT_CATERER_CARD' },
      { paymentCategory: 'OTHER', rate: '0.15', ruleCode: 'ICT_CATERER_OTHER' },
    ],
  },
  {
    id: 'PK-BA-RESTAURANT-STANDARD',
    jurisdiction: 'Balochistan',
    name: 'Balochistan restaurant — standard',
    effectiveFrom: '2026-07-01',
    enabled: true,
    authorityCode: 'BRA',
    sourceTitle:
      'BRA current consolidation amended through Finance Act 2026 (WHA-526 verification)',
    sourceUrl: 'https://bra.gob.pk/FAQs.aspx',
    eligibilityControls: [
      { id: 'noInputAdjustment', label: 'The accountant confirmed no input adjustment applies.' },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.08', ruleCode: 'BA_STANDARD_CASH' },
      { paymentCategory: 'CARD', rate: '0.08', ruleCode: 'BA_STANDARD_CARD' },
      { paymentCategory: 'OTHER', rate: '0.08', ruleCode: 'BA_STANDARD_OTHER' },
    ],
  },
  {
    id: 'PK-BA-RESTAURANT-BRA-POS',
    jurisdiction: 'Balochistan',
    name: 'Balochistan restaurant — qualifying BRA-linked POS',
    effectiveFrom: '2026-07-01',
    enabled: true,
    authorityCode: 'BRA',
    sourceTitle:
      'BRA current consolidation amended through Finance Act 2026 (WHA-526 verification)',
    sourceUrl: 'https://bra.gob.pk/ibra/',
    eligibilityControls: [
      { id: 'braLinkedPos', label: 'BRA accepted this branch’s linked POS equipment.' },
      {
        id: 'allElectronic',
        label: 'All invoices and receipts are issued electronically through it.',
      },
      { id: 'noInputAdjustment', label: 'No input adjustment will be taken.' },
      {
        id: 'notExcludedPremises',
        label: 'The restaurant is not in a hotel, motel, guest house, or club.',
      },
      { id: 'notFranchise', label: 'The operator is neither a franchiser nor franchisee.' },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.04', ruleCode: 'BA_BRA_POS_CASH' },
      { paymentCategory: 'CARD', rate: '0.04', ruleCode: 'BA_BRA_POS_CARD' },
      { paymentCategory: 'OTHER', rate: '0.04', ruleCode: 'BA_BRA_POS_OTHER' },
    ],
  },
] as const;

export type PakistanTaxProfileId = (typeof PAKISTAN_TAX_PROFILE_CATALOG)[number]['id'];

export function findPakistanTaxProfile(id: string) {
  return PAKISTAN_TAX_PROFILE_CATALOG.find((profile) => profile.id === id);
}
