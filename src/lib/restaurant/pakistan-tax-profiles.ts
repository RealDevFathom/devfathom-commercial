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
    sourceContentHash: null,
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
    sourceContentHash: '663d4df2e5cf72c7351011507cbe052dce4903bd1ce0df7041a33ce50733b0c0',
    tenderNotice:
      'The 8% relief is configured for card payments only. Wallet, QR, and OTHER tenders remain at 15%.',
    eligibilityControls: [
      {
        id: 'sindhNoInputTaxCreditOrAdjustment',
        label:
          'The accountant confirmed no input tax credit or adjustment will be claimed for the 8% card rate.',
      },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.15', ruleCode: 'SD_ORDINARY_CASH' },
      { paymentCategory: 'CARD', rate: '0.08', ruleCode: 'SD_QUALIFYING_CARD' },
      { paymentCategory: 'OTHER', rate: '0.15', ruleCode: 'SD_ORDINARY_OTHER' },
    ],
  },
  {
    id: 'PK-SD-RESTAURANT-LISTED',
    jurisdiction: 'Sindh',
    name: 'Sindh restaurant — SRB-approved listed branch',
    effectiveFrom: '2024-07-01',
    enabled: false,
    disabledReason:
      'Unavailable until current official SRB listed-branch evidence is pinned and reverified.',
    authorityCode: 'SRB',
    sourceTitle: 'SRB approved restaurant branch list',
    sourceUrl: 'https://www.srb.gos.pk/srb/restaurant-list/',
    sourceContentHash: null,
    eligibilityControls: [
      { id: 'srbListedBranch', label: 'This exact branch has current SRB approval/list evidence.' },
    ],
    rules: [],
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
    sourceContentHash: '612cc846fbccb0e6e389ca4322df19997fc2d27a3262096f0e7a64c7066fc7b3',
    tenderNotice:
      'The 6% relief is configured for card payments only. Wallet, QR, and OTHER tenders remain at 10%.',
    eligibilityControls: [
      {
        id: 'kpNoInputTaxCreditOrAdjustment',
        label:
          'The accountant confirmed no input tax credit or adjustment will be claimed for the 6% card rate.',
      },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.10', ruleCode: 'KP_ORDINARY_CASH' },
      { paymentCategory: 'CARD', rate: '0.06', ruleCode: 'KP_ORDINARY_CARD' },
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
    sourceContentHash: '612cc846fbccb0e6e389ca4322df19997fc2d27a3262096f0e7a64c7066fc7b3',
    tenderNotice:
      'The 6% relief is configured for card payments only. Wallet, QR, and OTHER tenders remain at 15%.',
    eligibilityControls: [
      { id: 'corporateEntity', label: 'The accountant confirmed this restaurant is corporate.' },
      {
        id: 'kpNoInputTaxCreditOrAdjustment',
        label:
          'The accountant confirmed no input tax credit or adjustment will be claimed for the 6% card rate.',
      },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.15', ruleCode: 'KP_CORPORATE_CASH' },
      { paymentCategory: 'CARD', rate: '0.06', ruleCode: 'KP_CORPORATE_CARD' },
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
    sourceContentHash: '29eb7e9daa58045290f2b79e1a9786e78ba1d8479037fed83d9e4a163258c4df',
    tenderNotice:
      'The 5% relief is configured for card payments only. Wallet, QR, and OTHER tenders remain at 15%.',
    eligibilityControls: [
      {
        id: 'ictNoInputTaxCreditOrAdjustment',
        label:
          'The accountant confirmed no input tax credit or adjustment will be claimed for the 5% card rate.',
      },
      {
        id: 'ictNoRefund',
        label: 'The accountant confirmed no refund will be claimed for the 5% card rate.',
      },
    ],
    rules: [
      { paymentCategory: 'CASH', rate: '0.15', ruleCode: 'ICT_RESTAURANT_CASH' },
      { paymentCategory: 'CARD', rate: '0.05', ruleCode: 'ICT_RESTAURANT_CARD' },
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
    sourceContentHash: '29eb7e9daa58045290f2b79e1a9786e78ba1d8479037fed83d9e4a163258c4df',
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
    enabled: false,
    disabledReason: 'Unavailable until a current official BRA instrument is pinned and reviewed.',
    authorityCode: 'BRA',
    sourceTitle: 'Balochistan Revenue Authority frequently asked questions',
    sourceUrl: 'https://bra.gob.pk/FAQs.aspx',
    sourceContentHash: null,
    eligibilityControls: [
      { id: 'noInputAdjustment', label: 'The accountant confirmed no input adjustment applies.' },
    ],
    rules: [],
  },
  {
    id: 'PK-BA-RESTAURANT-BRA-POS',
    jurisdiction: 'Balochistan',
    name: 'Balochistan restaurant — qualifying BRA-linked POS',
    effectiveFrom: '2026-07-01',
    enabled: false,
    disabledReason: 'Unavailable until a current official BRA instrument is pinned and reviewed.',
    authorityCode: 'BRA',
    sourceTitle: 'iBRA portal',
    sourceUrl: 'https://bra.gob.pk/ibra/',
    sourceContentHash: null,
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
    rules: [],
  },
] as const;

export type PakistanTaxProfileId = (typeof PAKISTAN_TAX_PROFILE_CATALOG)[number]['id'];

export function findPakistanTaxProfile(id: string) {
  return PAKISTAN_TAX_PROFILE_CATALOG.find((profile) => profile.id === id);
}
