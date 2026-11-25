import { BadRequestException, Injectable } from '@nestjs/common';
import {
  JurisdictionDetectionDto,
  JurisdictionSource,
  TaxAnalysisRequestDto,
  TaxDocumentFieldDto,
  TaxDocumentRequestDto,
  TaxDocumentTemplateDto,
  TaxEstimateDto,
  TaxOptimizationResponseDto,
  TaxSuggestionDto,
  TaxTransactionDto,
  TaxYearDto,
  TransactionPatternDto,
  WithdrawalOptionDto,
  WithdrawalStrategyDto,
} from './dto/tax-suggestion.dto';
import {
  COUNTRY_TO_JURISDICTION,
  CURRENCY_TO_JURISDICTION,
  JURISDICTION_RULES,
  JurisdictionRules,
  TAX_JURISDICTIONS,
  TaxJurisdiction,
} from './tax-rules';

const DAY_MS = 86_400_000;

/** Suggest waiting for the new tax year when it starts within this many days. */
const NEW_TAX_YEAR_WINDOW_DAYS = 30;

/** Remind users about allowances when the tax year ends within this many days. */
const YEAR_END_WINDOW_DAYS = 90;

export const TAX_DISCLAIMER =
  'Estimates use simplified headline rules for individual savers and are not tax advice. Confirm with a qualified tax adviser before acting.';

/** Round to cents. */
function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Savings tax optimization (#644).
 *
 * Stateless: callers pass the user's savings transactions and (optionally)
 * income, age, balances and expected rate, and get back an analysis of the
 * transaction pattern, an estimate of tax on interest, deposit-timing
 * suggestions, a withdrawal strategy, and a tax document template — all
 * under the rules of the detected jurisdiction (see `tax-rules.ts`).
 */
@Injectable()
export class TaxOptimizationService {
  // ---------------------------------------------------------------------
  // Jurisdiction
  // ---------------------------------------------------------------------

  /**
   * Picks the jurisdiction: explicit value, then ISO country code, then the
   * region of a BCP-47 locale (`en-GB` → UK), then a currency that maps to
   * a single jurisdiction. Falls back to US.
   */
  detectJurisdiction(
    input: Pick<
      TaxAnalysisRequestDto,
      'jurisdiction' | 'countryCode' | 'locale' | 'currency'
    >,
  ): JurisdictionDetectionDto {
    const result = (
      code: TaxJurisdiction,
      detectedFrom: JurisdictionSource,
    ): JurisdictionDetectionDto => ({
      jurisdiction: code,
      name: JURISDICTION_RULES[code].name,
      currency: JURISDICTION_RULES[code].currency,
      detectedFrom,
    });

    if (input.jurisdiction) {
      const code = input.jurisdiction.toUpperCase() as TaxJurisdiction;
      if (!TAX_JURISDICTIONS.includes(code)) {
        throw new BadRequestException(
          `Unsupported jurisdiction "${input.jurisdiction}". Supported: ${TAX_JURISDICTIONS.join(', ')}`,
        );
      }
      return result(code, 'explicit');
    }

    const fromCountry =
      input.countryCode &&
      COUNTRY_TO_JURISDICTION[input.countryCode.trim().toUpperCase()];
    if (fromCountry) return result(fromCountry, 'countryCode');

    const region = input.locale?.split(/[-_]/)[1];
    const fromLocale = region && COUNTRY_TO_JURISDICTION[region.toUpperCase()];
    if (fromLocale) return result(fromLocale, 'locale');

    const fromCurrency =
      input.currency &&
      CURRENCY_TO_JURISDICTION[input.currency.trim().toUpperCase()];
    if (fromCurrency) return result(fromCurrency, 'currency');

    return result('US', 'default');
  }

  /** Supported jurisdictions and their headline rules. */
  listJurisdictions() {
    return TAX_JURISDICTIONS.map((code) => {
      const rules = JURISDICTION_RULES[code];
      return {
        code,
        name: rules.name,
        currency: rules.currency,
        taxYearStart: rules.taxYearStart,
        interestTaxation: rules.interestTaxation,
        taxAdvantagedAccount: rules.taxAdvantagedAccount
          ? {
              name: rules.taxAdvantagedAccount.name,
              annualAllowance: rules.taxAdvantagedAccount.annualAllowance,
            }
          : null,
        document: rules.document.form,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Tax year & rates
  // ---------------------------------------------------------------------

  /** The tax year (labelled by the calendar year it starts in) containing `date`. */
  taxYearFor(rules: JurisdictionRules, date: Date): TaxYearDto {
    const { month, day } = rules.taxYearStart;
    const startThisYear = utcDate(date.getUTCFullYear(), month, day);
    const year =
      date.getTime() >= startThisYear.getTime()
        ? date.getUTCFullYear()
        : date.getUTCFullYear() - 1;
    return this.taxYearBounds(rules, year);
  }

  taxYearBounds(rules: JurisdictionRules, year: number): TaxYearDto {
    const { month, day } = rules.taxYearStart;
    const start = utcDate(year, month, day);
    const end = new Date(utcDate(year + 1, month, day).getTime() - DAY_MS);
    return { year, start: isoDate(start), end: isoDate(end) };
  }

  /** Marginal rate for `annualIncome`, or the jurisdiction default. */
  marginalRate(rules: JurisdictionRules, annualIncome?: number): number {
    if (rules.interestTaxation === 'flat') return rules.flatRate ?? 0;
    if (annualIncome === undefined || !rules.brackets) {
      return rules.defaultMarginalRate;
    }
    const bracket = rules.brackets.find((b) => annualIncome <= b.upTo);
    return (bracket ?? rules.brackets[rules.brackets.length - 1]).rate;
  }

  /**
   * Tax on `taxableInterest` (interest from taxable accounts only) after the
   * jurisdiction's tax-free allowance.
   */
  calculateInterestTax(
    rules: JurisdictionRules,
    taxableInterest: number,
    rate: number,
  ): TaxEstimateDto {
    const interest = Math.max(0, taxableInterest);
    const allowance = rules.interestAllowance(rate);
    const allowanceApplied = Math.min(interest, allowance);
    const taxableAfterAllowance = interest - allowanceApplied;
    const estimatedTax = money(taxableAfterAllowance * rate);
    return {
      taxableInterest: money(interest),
      allowanceApplied: money(allowanceApplied),
      taxableAfterAllowance: money(taxableAfterAllowance),
      rate,
      estimatedTax,
      effectiveRate:
        interest > 0 ? Math.round((estimatedTax / interest) * 10_000) / 10_000 : 0,
    };
  }

  // ---------------------------------------------------------------------
  // Transaction patterns
  // ---------------------------------------------------------------------

  analyzeTransactions(
    rules: JurisdictionRules,
    taxYear: TaxYearDto,
    transactions: TaxTransactionDto[],
  ): TransactionPatternDto {
    const start = Date.parse(taxYear.start);
    const endExclusive = Date.parse(taxYear.end) + DAY_MS;
    const lastQuarterStart = endExclusive - 91 * DAY_MS;

    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let depositCount = 0;
    let lateDeposits = 0;
    let taxableInterest = 0;
    let taxAdvantagedInterest = 0;
    let taxAdvantagedContributions = 0;

    for (const tx of transactions) {
      const at = Date.parse(tx.date);
      if (Number.isNaN(at) || at < start || at >= endExclusive) continue;
      const advantaged =
        tx.account === 'tax_advantaged' && !!rules.taxAdvantagedAccount;
      const amount = Math.abs(tx.amount);

      switch (tx.type) {
        case 'deposit':
          totalDeposits += amount;
          depositCount += 1;
          if (at >= lastQuarterStart) lateDeposits += amount;
          if (advantaged) taxAdvantagedContributions += amount;
          break;
        case 'withdrawal':
          totalWithdrawals += amount;
          break;
        case 'interest':
          if (advantaged && rules.taxAdvantagedAccount?.interestTaxFree) {
            taxAdvantagedInterest += amount;
          } else {
            taxableInterest += amount;
          }
          break;
      }
    }

    const allowance = rules.taxAdvantagedAccount?.annualAllowance ?? 0;
    return {
      totalDeposits: money(totalDeposits),
      totalWithdrawals: money(totalWithdrawals),
      depositCount,
      averageDeposit: depositCount ? money(totalDeposits / depositCount) : 0,
      taxableInterest: money(taxableInterest),
      taxAdvantagedInterest: money(taxAdvantagedInterest),
      taxAdvantagedContributions: money(taxAdvantagedContributions),
      contributionAllowance: allowance,
      remainingContributionAllowance: money(
        Math.max(0, allowance - taxAdvantagedContributions),
      ),
      lateYearDepositShare: totalDeposits
        ? Math.round((lateDeposits / totalDeposits) * 10_000) / 10_000
        : 0,
    };
  }

  // ---------------------------------------------------------------------
  // Deposit timing suggestions
  // ---------------------------------------------------------------------

  suggestTiming(params: {
    rules: JurisdictionRules;
    taxYear: TaxYearDto;
    asOf: Date;
    rate: number;
    analysis: TransactionPatternDto;
    previousYear: TransactionPatternDto;
    taxEstimate: TaxEstimateDto;
    request: TaxAnalysisRequestDto;
  }): TaxSuggestionDto[] {
    const { rules, taxYear, asOf, rate, analysis, previousYear, taxEstimate, request } =
      params;
    const suggestions: TaxSuggestionDto[] = [];
    const account = rules.taxAdvantagedAccount;
    const interestRate = request.annualInterestRate ?? 0;
    const taxableBalance = request.balances?.taxable;
    const yearEnd = new Date(Date.parse(taxYear.end));
    const nextYearStart = new Date(yearEnd.getTime() + DAY_MS);
    const daysToYearEnd = Math.max(
      0,
      Math.ceil((yearEnd.getTime() - asOf.getTime()) / DAY_MS),
    );

    /** Tax saved per year by sheltering `amount` from interest tax. */
    const shelterSaving = (amount: number) => money(amount * interestRate * rate);

    if (account) {
      const remaining = analysis.remainingContributionAllowance;

      // 1. Prior-year contributions still allowed (US IRA until mid-April).
      const prevEnd = Date.parse(this.taxYearBounds(rules, taxYear.year - 1).end);
      const graceEnd = new Date(prevEnd + account.contributionGraceDays * DAY_MS);
      if (
        account.contributionGraceDays > 0 &&
        asOf.getTime() <= graceEnd.getTime() &&
        previousYear.remainingContributionAllowance > 0
      ) {
        const amount = previousYear.remainingContributionAllowance;
        suggestions.push({
          type: 'prior_year_contribution',
          priority: 'high',
          title: `Contribute to your ${account.name} for ${taxYear.year - 1}`,
          description: `You can still make ${taxYear.year - 1} ${account.name} contributions until ${isoDate(graceEnd)}. Up to ${amount} ${rules.currency} of allowance is unused.`,
          amount,
          deadline: isoDate(graceEnd),
          estimatedTaxSaving: money(
            amount * rate + shelterSaving(amount),
          ),
          rule: `${rules.name}: prior-year ${account.name} contributions are accepted until the filing deadline.`,
        });
      }

      // 2. Use the current year's allowance before it resets.
      if (remaining > 0) {
        const amount =
          taxableBalance !== undefined ? Math.min(remaining, taxableBalance) : remaining;
        const nearYearEnd = daysToYearEnd <= YEAR_END_WINDOW_DAYS;
        const deductible = account.withdrawalTaxedAsIncome; // pre-tax contributions
        suggestions.push({
          type: 'use_tax_advantaged_allowance',
          priority: nearYearEnd ? 'high' : 'medium',
          title: `Use your ${account.name} allowance before ${taxYear.end}`,
          description: `${remaining} ${rules.currency} of your ${account.annualAllowance} ${rules.currency} ${account.name} allowance is unused this tax year and does not carry over. Deposit before ${taxYear.end}${
            account.contributionGraceDays > 0
              ? ` (or by ${isoDate(new Date(yearEnd.getTime() + account.contributionGraceDays * DAY_MS))} for this tax year)`
              : ''
          } so interest grows tax-free.`,
          amount: money(amount),
          deadline: taxYear.end,
          estimatedTaxSaving: money(
            (deductible ? amount * rate : 0) + shelterSaving(amount),
          ),
          rule: `${rules.name}: ${account.name} allowance is ${account.annualAllowance} ${rules.currency} per tax year.`,
        });
      }

      // 3. Allowance used up and a new tax year is close: wait for it.
      const daysToNewYear = Math.ceil(
        (nextYearStart.getTime() - asOf.getTime()) / DAY_MS,
      );
      if (remaining <= 0 && daysToNewYear <= NEW_TAX_YEAR_WINDOW_DAYS) {
        suggestions.push({
          type: 'wait_for_new_tax_year',
          priority: 'medium',
          title: `Hold new ${account.name} deposits until ${isoDate(nextYearStart)}`,
          description: `This year's ${account.name} allowance is used up. A fresh ${account.annualAllowance} ${rules.currency} allowance starts on ${isoDate(nextYearStart)} — deposits made then are sheltered for the whole year.`,
          amount: account.annualAllowance,
          recommendedDate: isoDate(nextYearStart),
          estimatedTaxSaving: shelterSaving(account.annualAllowance),
          rule: `${rules.name}: the tax year starts on ${isoDate(nextYearStart).slice(5)}.`,
        });
      }

      // 4. Taxable interest is being taxed: move savings into the shelter.
      if (taxEstimate.estimatedTax > 0 && remaining > 0) {
        const amount =
          taxableBalance !== undefined ? Math.min(remaining, taxableBalance) : remaining;
        suggestions.push({
          type: 'shift_to_tax_advantaged',
          priority: 'high',
          title: `Move savings into your ${account.name}`,
          description: `You're paying about ${taxEstimate.estimatedTax} ${rules.currency} tax on interest this year. Moving up to ${money(amount)} ${rules.currency} from taxable savings into your ${account.name} shelters its future interest.`,
          amount: money(amount),
          deadline: taxYear.end,
          estimatedTaxSaving: shelterSaving(amount),
          rule: `${rules.name}: interest inside a ${account.name} is not taxed when earned.`,
        });
      }
    }

    // 5. Tax-free interest allowance (UK PSA, DE Sparer-Pauschbetrag).
    const allowance = rules.interestAllowance(rate);
    if (allowance > 0) {
      const headroom = money(allowance - taxEstimate.allowanceApplied);
      if (headroom > 0) {
        suggestions.push({
          type: 'interest_allowance_headroom',
          priority: 'low',
          title: 'Interest is within your tax-free allowance',
          description: `You can earn another ${headroom} ${rules.currency} of interest this tax year before tax applies.`,
          amount: headroom,
          deadline: taxYear.end,
          estimatedTaxSaving: money(headroom * rate),
          rule: `${rules.name}: ${allowance} ${rules.currency} of savings interest is tax-free per year at your rate.`,
        });
      }
      if (rules.code === 'DE') {
        suggestions.push({
          type: 'claim_allowance',
          priority: analysis.taxableInterest > 0 ? 'medium' : 'low',
          title: 'File an exemption order (Freistellungsauftrag)',
          description: `Without an exemption order, tax is withheld from the first euro of interest. Filing one lets up to ${allowance} ${rules.currency} be paid gross.`,
          amount: allowance,
          estimatedTaxSaving: money(
            Math.min(allowance, analysis.taxableInterest) * rate,
          ),
          rule: `${rules.name}: Sparer-Pauschbetrag of ${allowance} ${rules.currency}.`,
        });
      }
    }

    // 6. Flat final withholding (NG): timing doesn't change the rate.
    if (rules.interestTaxation === 'flat' && allowance === 0) {
      suggestions.push({
        type: 'final_withholding',
        priority: 'low',
        title: 'Interest tax is withheld at source',
        description: `Interest is taxed at a flat ${rules.flatRate! * 100}% final withholding rate, so deposit timing does not change the tax. Keep your credit notes.`,
        estimatedTaxSaving: 0,
        rule: `${rules.name}: ${rules.flatRate! * 100}% withholding tax on interest is final.`,
      });
    }

    const order = { high: 0, medium: 1, low: 2 } as const;
    return suggestions.sort(
      (a, b) =>
        order[a.priority] - order[b.priority] ||
        b.estimatedTaxSaving - a.estimatedTaxSaving,
    );
  }

  // ---------------------------------------------------------------------
  // Withdrawal strategy
  // ---------------------------------------------------------------------

  /**
   * Compares withdrawing from taxable savings first versus the tax-advantaged
   * account first, costing each as immediate tax (+ penalties) plus a year of
   * tax on the interest the remaining taxable balance earns, and recommends
   * the cheapest.
   */
  withdrawalStrategy(params: {
    rules: JurisdictionRules;
    amount: number;
    taxableBalance: number;
    taxAdvantagedBalance: number;
    rate: number;
    interestRate: number;
    age?: number;
  }): WithdrawalStrategyDto {
    const { rules, amount, taxableBalance, rate, interestRate, age } = params;
    const account = rules.taxAdvantagedAccount;
    const taxAdvantagedBalance = account ? params.taxAdvantagedBalance : 0;
    const feasible = amount <= taxableBalance + taxAdvantagedBalance;

    const advantagedTaxRate = account
      ? (account.withdrawalTaxedAsIncome ? rate : 0) +
        (account.earlyWithdrawalPenalty &&
        (age === undefined || age < account.earlyWithdrawalPenalty.belowAge)
          ? account.earlyWithdrawalPenalty.rate
          : 0)
      : 0;

    const build = (
      name: string,
      order: ('taxable' | 'tax_advantaged')[],
    ): WithdrawalOptionDto => {
      let left = amount;
      let remainingTaxable = taxableBalance;
      const steps: WithdrawalOptionDto['steps'] = [];
      for (const source of order) {
        const available =
          source === 'taxable' ? taxableBalance : taxAdvantagedBalance;
        const take = Math.min(left, available);
        if (take <= 0) continue;
        left -= take;
        if (source === 'taxable') remainingTaxable -= take;
        steps.push({
          source,
          amount: money(take),
          immediateTax:
            source === 'taxable' ? 0 : money(take * advantagedTaxRate),
        });
      }
      const immediateTax = money(steps.reduce((s, x) => s + x.immediateTax, 0));
      const futureInterest = Math.max(0, remainingTaxable) * interestRate;
      const futureInterestTax = this.calculateInterestTax(
        rules,
        futureInterest,
        rate,
      ).estimatedTax;
      return {
        name,
        steps,
        immediateTax,
        futureInterestTax,
        totalTaxCost: money(immediateTax + futureInterestTax),
      };
    };

    const options = account
      ? [
          build('taxable_first', ['taxable', 'tax_advantaged']),
          build('tax_advantaged_first', ['tax_advantaged', 'taxable']),
        ]
      : [build('taxable_only', ['taxable'])];

    const sorted = [...options].sort((a, b) => a.totalTaxCost - b.totalTaxCost);
    const recommended = sorted[0];
    const worst = sorted[sorted.length - 1];

    let rationale: string;
    if (!account) {
      rationale = `${rules.name} has no tax-advantaged savings account in these rules; withdrawals of principal are not taxed.`;
    } else if (recommended.name === 'taxable_first') {
      rationale = `Withdraw from taxable savings first: principal comes out tax-free and the ${account.name} keeps sheltering future interest${
        advantagedTaxRate > 0
          ? `, avoiding ${Math.round(advantagedTaxRate * 100)}% tax/penalty on ${account.name} withdrawals`
          : ''
      }.`;
    } else {
      rationale = `Withdraw from your ${account.name} first: it costs nothing now and keeping the taxable balance is cheaper over the next year.`;
    }

    return {
      amount: money(amount),
      feasible,
      recommended,
      alternatives: sorted.slice(1),
      taxSaved: money(worst.totalTaxCost - recommended.totalTaxCost),
      rationale: feasible
        ? rationale
        : `Your balances (${money(taxableBalance + taxAdvantagedBalance)} ${rules.currency}) don't cover ${money(amount)} ${rules.currency}. ${rationale}`,
    };
  }

  // ---------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------

  optimize(request: TaxAnalysisRequestDto): TaxOptimizationResponseDto {
    const jurisdiction = this.detectJurisdiction(request);
    const rules = JURISDICTION_RULES[jurisdiction.jurisdiction];
    const asOf = this.parseAsOf(request.asOf);
    const taxYear =
      request.taxYear !== undefined
        ? this.taxYearBounds(rules, request.taxYear)
        : this.taxYearFor(rules, asOf);
    const rate = this.marginalRate(rules, request.annualIncome);
    const transactions = request.transactions ?? [];

    const analysis = this.analyzeTransactions(rules, taxYear, transactions);
    const previousYear = this.analyzeTransactions(
      rules,
      this.taxYearBounds(rules, taxYear.year - 1),
      transactions,
    );
    const taxEstimate = this.calculateInterestTax(
      rules,
      analysis.taxableInterest,
      rate,
    );
    const suggestions = this.suggestTiming({
      rules,
      taxYear,
      asOf,
      rate,
      analysis,
      previousYear,
      taxEstimate,
      request,
    });

    const response: TaxOptimizationResponseDto = {
      jurisdiction,
      taxYear,
      marginalRate: rate,
      analysis,
      taxEstimate,
      suggestions,
      disclaimer: TAX_DISCLAIMER,
    };

    if (request.plannedWithdrawal !== undefined && request.plannedWithdrawal > 0) {
      response.withdrawalStrategy = this.withdrawalStrategy({
        rules,
        amount: request.plannedWithdrawal,
        taxableBalance: request.balances?.taxable ?? 0,
        taxAdvantagedBalance: request.balances?.taxAdvantaged ?? 0,
        rate,
        interestRate: request.annualInterestRate ?? 0,
        age: request.age,
      });
    }

    return response;
  }

  /** A document template pre-filled with the year's interest figures. */
  generateDocument(request: TaxDocumentRequestDto): TaxDocumentTemplateDto {
    const { jurisdiction, taxYear, taxEstimate, analysis } = this.optimize(request);
    const rules = JURISDICTION_RULES[jurisdiction.jurisdiction];
    const doc = rules.document;
    const amount = (n: number) => n.toFixed(2);

    const values: Record<string, { label: string; value: string | null }> = {
      payerName: { label: 'Payer name', value: request.payerName ?? null },
      recipientName: { label: 'Recipient name', value: request.recipientName ?? null },
      taxpayerName: { label: 'Taxpayer name', value: request.recipientName ?? null },
      recipientTaxId: { label: 'Recipient TIN', value: request.taxId ?? null },
      utr: { label: 'Unique Taxpayer Reference', value: request.taxId ?? null },
      sin: { label: 'Social Insurance Number', value: request.taxId ?? null },
      taxId: { label: 'Tax identification number', value: request.taxId ?? null },
      tin: { label: 'Tax identification number', value: request.taxId ?? null },
      taxYear: { label: 'Tax year', value: `${taxYear.start} to ${taxYear.end}` },
      interestIncome: { label: 'Box 1 — Interest income', value: amount(taxEstimate.taxableInterest) },
      federalTaxWithheld: { label: 'Box 4 — Federal income tax withheld', value: amount(0) },
      untaxedInterest: { label: 'Untaxed UK interest', value: amount(taxEstimate.taxableInterest) },
      personalSavingsAllowanceUsed: { label: 'Personal Savings Allowance used', value: amount(taxEstimate.allowanceApplied) },
      taxableInterest: { label: 'Interest taxable after allowance', value: amount(taxEstimate.taxableAfterAllowance) },
      interestFromCanadianSources: { label: 'Box 13 — Interest from Canadian sources', value: amount(taxEstimate.taxableInterest) },
      capitalIncome: { label: 'Kapitalerträge (capital income)', value: amount(taxEstimate.taxableInterest) },
      saverAllowanceUsed: { label: 'Sparer-Pauschbetrag used', value: amount(taxEstimate.allowanceApplied) },
      withholdingTax: { label: 'Kapitalertragsteuer (25%)', value: amount(taxEstimate.taxableAfterAllowance * 0.25) },
      solidaritySurcharge: { label: 'Solidaritätszuschlag', value: amount(taxEstimate.taxableAfterAllowance * 0.25 * 0.055) },
      grossInterest: { label: 'Gross interest', value: amount(taxEstimate.taxableInterest) },
      withholdingTaxDeducted: { label: 'Withholding tax deducted (10%)', value: amount(taxEstimate.estimatedTax) },
    };

    const fields: TaxDocumentFieldDto[] = doc.requiredFields.map((key) => ({
      key,
      label: values[key]?.label ?? key,
      value: values[key]?.value ?? null,
      required: true,
    }));
    if (analysis.taxAdvantagedInterest > 0) {
      fields.push({
        key: 'taxAdvantagedInterest',
        label: `${rules.taxAdvantagedAccount?.name ?? 'Tax-advantaged'} interest (not taxable)`,
        value: amount(analysis.taxAdvantagedInterest),
        required: false,
      });
    }

    return {
      jurisdiction: jurisdiction.jurisdiction,
      form: doc.form,
      title: doc.title,
      taxYear,
      currency: rules.currency,
      fields,
      missingFields: fields
        .filter((f) => f.required && (f.value === null || f.value === ''))
        .map((f) => f.key),
      reportingRequired: taxEstimate.taxableInterest >= doc.reportingThreshold,
      notes: [...doc.notes, TAX_DISCLAIMER],
    };
  }

  private parseAsOf(asOf?: string): Date {
    if (!asOf) return new Date();
    const date = new Date(asOf);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('asOf must be an ISO-8601 date');
    }
    return date;
  }
}
