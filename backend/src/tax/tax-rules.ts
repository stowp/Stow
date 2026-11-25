/**
 * Per-jurisdiction tax rules used by `TaxOptimizationService`.
 *
 * These are simplified, published headline rules (individual filer, savings
 * interest only) intended for planning suggestions — not tax advice. Each
 * rule set records the figures the service relies on so suggestions can
 * cite them, and so new jurisdictions are added here without touching the
 * service logic.
 */

export const TAX_JURISDICTIONS = ['US', 'UK', 'CA', 'DE', 'NG'] as const;

export type TaxJurisdiction = (typeof TAX_JURISDICTIONS)[number];

/** A marginal income-tax band: income up to `upTo` is taxed at `rate`. */
export interface TaxBracket {
  upTo: number;
  rate: number;
}

export interface TaxAdvantagedAccountRule {
  /** e.g. "Traditional IRA", "Stocks & Shares / Cash ISA". */
  name: string;
  /** Maximum contribution per tax year. */
  annualAllowance: number;
  /** Is interest earned inside the account taxed when earned? */
  interestTaxFree: boolean;
  /** Extra tax rate charged on withdrawal (e.g. income tax on a traditional IRA). */
  withdrawalTaxedAsIncome: boolean;
  /** Early-withdrawal penalty rate, and the age below which it applies. */
  earlyWithdrawalPenalty?: { rate: number; belowAge: number };
  /**
   * Days after the tax year ends during which contributions still count for
   * that year (US IRA: until the filing deadline, ~April 15).
   */
  contributionGraceDays: number;
}

export interface InterestDocumentRule {
  form: string;
  title: string;
  /** Interest at or above which the document must be issued/filed. */
  reportingThreshold: number;
  /** Fields the document must contain. */
  requiredFields: string[];
  notes: string[];
}

export interface JurisdictionRules {
  code: TaxJurisdiction;
  name: string;
  currency: string;
  /** Tax year start as month (1-12) and day; it ends the day before next year's start. */
  taxYearStart: { month: number; day: number };
  /**
   * How savings interest is taxed:
   * - `marginal`: added to income and taxed at the marginal rate
   * - `flat`: a flat final rate regardless of income
   */
  interestTaxation: 'marginal' | 'flat';
  brackets?: TaxBracket[];
  flatRate?: number;
  /** Marginal rate assumed when the user's income is not provided. */
  defaultMarginalRate: number;
  /**
   * Tax-free interest allowance per tax year. A function of the marginal rate
   * where the allowance depends on the band (UK Personal Savings Allowance).
   */
  interestAllowance: (marginalRate: number) => number;
  taxAdvantagedAccount?: TaxAdvantagedAccountRule;
  document: InterestDocumentRule;
}

export const JURISDICTION_RULES: Record<TaxJurisdiction, JurisdictionRules> = {
  US: {
    code: 'US',
    name: 'United States',
    currency: 'USD',
    taxYearStart: { month: 1, day: 1 },
    interestTaxation: 'marginal',
    // Federal, single filer.
    brackets: [
      { upTo: 11_600, rate: 0.1 },
      { upTo: 47_150, rate: 0.12 },
      { upTo: 100_525, rate: 0.22 },
      { upTo: 191_950, rate: 0.24 },
      { upTo: 243_725, rate: 0.32 },
      { upTo: 609_350, rate: 0.35 },
      { upTo: Infinity, rate: 0.37 },
    ],
    defaultMarginalRate: 0.22,
    interestAllowance: () => 0,
    taxAdvantagedAccount: {
      name: 'Traditional IRA',
      annualAllowance: 7_000,
      interestTaxFree: true,
      withdrawalTaxedAsIncome: true,
      earlyWithdrawalPenalty: { rate: 0.1, belowAge: 59.5 },
      contributionGraceDays: 105, // Jan 1 → Apr 15
    },
    document: {
      form: '1099-INT',
      title: 'Interest Income (Form 1099-INT summary)',
      reportingThreshold: 10,
      requiredFields: [
        'payerName',
        'recipientName',
        'recipientTaxId',
        'taxYear',
        'interestIncome',
        'federalTaxWithheld',
      ],
      notes: [
        'Box 1 reports taxable interest. Interest of $10 or more must be reported by the payer.',
        'All taxable interest must be reported on your return even if no form is issued.',
      ],
    },
  },
  UK: {
    code: 'UK',
    name: 'United Kingdom',
    currency: 'GBP',
    taxYearStart: { month: 4, day: 6 },
    interestTaxation: 'marginal',
    brackets: [
      { upTo: 12_570, rate: 0 },
      { upTo: 50_270, rate: 0.2 },
      { upTo: 125_140, rate: 0.4 },
      { upTo: Infinity, rate: 0.45 },
    ],
    defaultMarginalRate: 0.2,
    // Personal Savings Allowance: £1,000 basic, £500 higher, £0 additional.
    interestAllowance: (rate) =>
      rate >= 0.45 ? 0 : rate >= 0.4 ? 500 : 1_000,
    taxAdvantagedAccount: {
      name: 'ISA',
      annualAllowance: 20_000,
      interestTaxFree: true,
      withdrawalTaxedAsIncome: false,
      contributionGraceDays: 0,
    },
    document: {
      form: 'SA100',
      title: 'Self Assessment: UK interest (SA100 savings summary)',
      reportingThreshold: 0,
      requiredFields: [
        'taxpayerName',
        'utr',
        'taxYear',
        'untaxedInterest',
        'personalSavingsAllowanceUsed',
        'taxableInterest',
      ],
      notes: [
        'Interest within the Personal Savings Allowance is tax-free but may still need reporting via Self Assessment.',
        'ISA interest is tax-free and is not reported.',
      ],
    },
  },
  CA: {
    code: 'CA',
    name: 'Canada',
    currency: 'CAD',
    taxYearStart: { month: 1, day: 1 },
    interestTaxation: 'marginal',
    // Federal brackets.
    brackets: [
      { upTo: 55_867, rate: 0.15 },
      { upTo: 111_733, rate: 0.205 },
      { upTo: 173_205, rate: 0.26 },
      { upTo: 246_752, rate: 0.29 },
      { upTo: Infinity, rate: 0.33 },
    ],
    defaultMarginalRate: 0.205,
    interestAllowance: () => 0,
    taxAdvantagedAccount: {
      name: 'TFSA',
      annualAllowance: 7_000,
      interestTaxFree: true,
      withdrawalTaxedAsIncome: false,
      contributionGraceDays: 0,
    },
    document: {
      form: 'T5',
      title: 'Statement of Investment Income (T5 summary)',
      reportingThreshold: 50,
      requiredFields: [
        'payerName',
        'recipientName',
        'sin',
        'taxYear',
        'interestFromCanadianSources',
      ],
      notes: [
        'Box 13 reports interest from Canadian sources. A T5 is issued for interest of $50 or more.',
        'TFSA interest is tax-free and is not reported.',
      ],
    },
  },
  DE: {
    code: 'DE',
    name: 'Germany',
    currency: 'EUR',
    taxYearStart: { month: 1, day: 1 },
    interestTaxation: 'flat',
    // Abgeltungsteuer 25% + 5.5% solidarity surcharge on the tax.
    flatRate: 0.26375,
    defaultMarginalRate: 0.26375,
    // Sparer-Pauschbetrag.
    interestAllowance: () => 1_000,
    document: {
      form: 'Jahressteuerbescheinigung',
      title: 'Annual tax certificate for capital income',
      reportingThreshold: 0,
      requiredFields: [
        'taxpayerName',
        'taxId',
        'taxYear',
        'capitalIncome',
        'saverAllowanceUsed',
        'withholdingTax',
        'solidaritySurcharge',
      ],
      notes: [
        'Submit an exemption order (Freistellungsauftrag) so interest up to the €1,000 saver allowance is paid without withholding.',
      ],
    },
  },
  NG: {
    code: 'NG',
    name: 'Nigeria',
    currency: 'NGN',
    taxYearStart: { month: 1, day: 1 },
    interestTaxation: 'flat',
    // Withholding tax on interest, a final tax for individuals.
    flatRate: 0.1,
    defaultMarginalRate: 0.1,
    interestAllowance: () => 0,
    document: {
      form: 'WHT Credit Note',
      title: 'Withholding tax credit note on interest',
      reportingThreshold: 0,
      requiredFields: [
        'payerName',
        'recipientName',
        'tin',
        'taxYear',
        'grossInterest',
        'withholdingTaxDeducted',
      ],
      notes: [
        'Withholding tax on interest paid to individuals is a final tax; keep credit notes as evidence.',
      ],
    },
  },
};

/** ISO 3166-1 alpha-2 country → jurisdiction (GB and UK both map to UK). */
export const COUNTRY_TO_JURISDICTION: Record<string, TaxJurisdiction> = {
  US: 'US',
  GB: 'UK',
  UK: 'UK',
  CA: 'CA',
  DE: 'DE',
  NG: 'NG',
};

/** Currencies that identify a single supported jurisdiction. */
export const CURRENCY_TO_JURISDICTION: Record<string, TaxJurisdiction> = {
  USD: 'US',
  GBP: 'UK',
  CAD: 'CA',
  NGN: 'NG',
};
