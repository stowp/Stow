import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Savings report generation for tax and personal records.
 *
 * `generate` turns an account's transaction history into:
 * - a structured summary (totals, monthly deposit/withdrawal breakdown,
 *   balance series, interest and tax for the period, and a calendar
 *   year-end tax summary);
 * - an HTML report rendered from `templates/report-template.html`, with the
 *   balance growth chart as inline SVG;
 * - a PDF of the same report, written directly (standard Type 1 fonts, vector
 *   chart), so no headless browser or extra dependency is needed.
 *
 * All money is handled in integer cents internally so totals and tax are
 * exact to the cent.
 */

export type ReportTransactionType = 'deposit' | 'withdrawal' | 'interest' | 'fee';

export interface ReportTransaction {
  id?: string;
  type: ReportTransactionType;
  /** Positive amount in whole currency units; the type sets the direction. */
  amount: number;
  timestamp: Date | string;
  description?: string;
  /** Tax already withheld at source on this transaction (interest only). */
  taxWithheld?: number;
}

export interface SavingsReportRequest {
  accountName: string;
  accountId?: string;
  currency?: string;
  /** Balance before the first transaction in `transactions`. */
  openingBalance?: number;
  /** Full history; entries outside `from`..`to` only affect opening balances. */
  transactions: ReportTransaction[];
  from: Date | string;
  to: Date | string;
  /** Income tax rate applied to interest, 0-1. */
  taxRate?: number;
  /** Calendar year for the year-end summary. Defaults to the year of `to`. */
  taxYear?: number;
  /** Fixes the "generated at" stamp (useful for reproducible output). */
  generatedAt?: Date | string;
}

export interface MonthlyBreakdown {
  /** `YYYY-MM` */
  month: string;
  deposits: number;
  withdrawals: number;
  interest: number;
  fees: number;
  net: number;
  closingBalance: number;
}

export interface BalancePoint {
  date: string;
  balance: number;
}

export interface TaxSummary {
  taxRate: number;
  interestIncome: number;
  estimatedTax: number;
  taxWithheld: number;
  /** `estimatedTax - taxWithheld`; negative means a refund is due. */
  taxDue: number;
}

export interface YearEndSummary extends TaxSummary {
  year: number;
  openingBalance: number;
  closingBalance: number;
  deposits: number;
  withdrawals: number;
  fees: number;
  /** Interest over the average of opening and closing balance, as a percentage. */
  effectiveYieldPercent: number;
}

export interface ReportLine {
  id: string | null;
  date: string;
  type: ReportTransactionType;
  description: string;
  amount: number;
  balance: number;
}

export interface SavingsReportSummary {
  accountName: string;
  accountId: string | null;
  currency: string;
  period: { from: string; to: string };
  generatedAt: string;
  openingBalance: number;
  closingBalance: number;
  totals: { deposits: number; withdrawals: number; interest: number; fees: number; net: number };
  counts: { deposits: number; withdrawals: number; interest: number; fees: number };
  monthly: MonthlyBreakdown[];
  balanceSeries: BalancePoint[];
  tax: TaxSummary;
  yearEnd: YearEndSummary;
  transactions: ReportLine[];
}

export interface SavingsReport {
  summary: SavingsReportSummary;
  html: string;
  pdf: Buffer;
  filename: string;
}

interface Tx {
  id: string | null;
  type: ReportTransactionType;
  cents: number;
  withheldCents: number;
  time: number;
  description: string;
}

const TYPES: ReportTransactionType[] = ['deposit', 'withdrawal', 'interest', 'fee'];
const TYPE_LABELS: Record<ReportTransactionType, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  interest: 'Interest',
  fee: 'Fee',
};
const MAX_RANGE_DAYS = 366 * 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── money helpers ────────────────────────────────────────────────────────

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

/** Signed effect of a transaction on the balance. */
function signed(tx: Tx): number {
  return tx.type === 'deposit' || tx.type === 'interest' ? tx.cents : -tx.cents;
}

export function formatMoney(amount: number, currency: string): string {
  const negative = amount < 0;
  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${frac} ${currency}`;
}

function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function toTime(value: Date | string, field: string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return time;
}

/** `to` given as a bare date (YYYY-MM-DD) includes that whole day. */
function endOfRange(value: Date | string): number {
  const time = toTime(value, 'to');
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return time + DAY_MS - 1;
  }
  return time;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── PDF writer ───────────────────────────────────────────────────────────

type Rgb = [number, number, number];

interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: Rgb;
  align?: 'left' | 'right';
}

/**
 * Minimal PDF 1.4 writer: A4 pages, Helvetica / Helvetica-Bold (standard
 * Type 1 fonts, WinAnsi encoding), text, lines, rectangles and polylines.
 * Content streams are left uncompressed.
 */
export class PdfWriter {
  static readonly WIDTH = 595.28;
  static readonly HEIGHT = 841.89;

  private readonly pages: string[][] = [];

  constructor(private readonly title: string) {}

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.pages.push([]);
  }

  private get ops(): string[] {
    if (this.pages.length === 0) this.addPage();
    return this.pages[this.pages.length - 1];
  }

  static escape(text: string): string {
    // WinAnsi covers Latin-1; anything else is replaced.
    const latin1 = text.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
    return latin1.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  /** Approximate Helvetica width; good enough to right-align numbers. */
  static textWidth(text: string, size: number, bold = false): number {
    let units = 0;
    for (const ch of text) {
      if (/[0-9]/.test(ch)) units += 556;
      else if (ch === ' ' || ch === ',' || ch === '.') units += 278;
      else if (ch === '-') units += 333;
      else if (/[A-Z]/.test(ch)) units += 667;
      else units += 500;
    }
    return (units * size * (bold ? 1.05 : 1)) / 1000;
  }

  private static num(value: number): string {
    return (Math.round(value * 100) / 100).toString();
  }

  private static color(rgb: Rgb): string {
    return rgb.map((c) => PdfWriter.num(c)).join(' ');
  }

  text(x: number, y: number, text: string, options: TextOptions = {}): void {
    const size = options.size ?? 10;
    const bold = options.bold ?? false;
    const left = options.align === 'right' ? x - PdfWriter.textWidth(text, size, bold) : x;
    this.ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${PdfWriter.color(options.color ?? [0, 0, 0])} rg ` +
        `${PdfWriter.num(left)} ${PdfWriter.num(y)} Td (${PdfWriter.escape(text)}) Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb = [0.8, 0.8, 0.8], width = 0.5): void {
    this.ops.push(
      `${PdfWriter.num(width)} w ${PdfWriter.color(color)} RG ` +
        `${PdfWriter.num(x1)} ${PdfWriter.num(y1)} m ${PdfWriter.num(x2)} ${PdfWriter.num(y2)} l S`,
    );
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): void {
    this.ops.push(
      `${PdfWriter.color(fill)} rg ${PdfWriter.num(x)} ${PdfWriter.num(y)} ` +
        `${PdfWriter.num(w)} ${PdfWriter.num(h)} re f`,
    );
  }

  polyline(points: [number, number][], color: Rgb, width = 1.5): void {
    if (points.length < 2) return;
    const [first, ...rest] = points;
    const path = [`${PdfWriter.num(first[0])} ${PdfWriter.num(first[1])} m`]
      .concat(rest.map(([x, y]) => `${PdfWriter.num(x)} ${PdfWriter.num(y)} l`))
      .join('\n');
    this.ops.push(`${PdfWriter.num(width)} w ${PdfWriter.color(color)} RG 1 j\n${path}\nS`);
  }

  toBuffer(createdAt: Date): Buffer {
    if (this.pages.length === 0) this.addPage();
    const objects: string[] = [];
    const pageCount = this.pages.length;
    // 1 catalog, 2 pages, 3-4 fonts, 5 info, then (page, content) pairs.
    const pageIds = this.pages.map((_, i) => 6 + i * 2);
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    const stamp = createdAt.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    objects[5] =
      `<< /Title (${PdfWriter.escape(this.title)}) /Producer (Stow savings reports) ` +
      `/CreationDate (D:${stamp}Z) >>`;
    this.pages.forEach((ops, i) => {
      const pageId = pageIds[i];
      const stream = ops.join('\n');
      objects[pageId] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PdfWriter.WIDTH} ${PdfWriter.HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
      objects[pageId + 1] =
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
    });

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
      offsets[id] = Buffer.byteLength(out, 'latin1');
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) {
      out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

// ── service ──────────────────────────────────────────────────────────────

@Injectable()
export class SavingsReportService {
  private template: string | null = null;

  generate(request: SavingsReportRequest): SavingsReport {
    const summary = this.buildSummary(request);
    return {
      summary,
      html: this.renderHtml(summary),
      pdf: this.renderPdf(summary),
      filename: `savings-report-${summary.period.from}-to-${summary.period.to}.pdf`,
    };
  }

  buildSummary(request: SavingsReportRequest): SavingsReportSummary {
    const from = toTime(request.from, 'from');
    const to = endOfRange(request.to);
    if (from > to) throw new BadRequestException('from must not be after to');
    if (to - from > MAX_RANGE_DAYS * DAY_MS) {
      throw new BadRequestException('Date range is too long');
    }
    const taxRate = request.taxRate ?? 0;
    if (!(taxRate >= 0 && taxRate <= 1)) {
      throw new BadRequestException('taxRate must be between 0 and 1');
    }
    if (!request.accountName?.trim()) {
      throw new BadRequestException('accountName is required');
    }
    const currency = request.currency ?? 'USDC';
    const txs = this.parse(request.transactions ?? []);
    const startCents = toCents(request.openingBalance ?? 0);

    const balanceBefore = (time: number) =>
      txs.filter((t) => t.time < time).reduce((sum, t) => sum + signed(t), startCents);
    const inRange = txs.filter((t) => t.time >= from && t.time <= to);
    const opening = balanceBefore(from);

    const totals = { deposit: 0, withdrawal: 0, interest: 0, fee: 0 };
    const counts = { deposit: 0, withdrawal: 0, interest: 0, fee: 0 };
    let withheld = 0;
    let balance = opening;
    const lines: ReportLine[] = [];
    const monthly: MonthlyBreakdown[] = [];
    const series: BalancePoint[] = [{ date: isoDate(from), balance: fromCents(opening) }];

    for (const tx of inRange) {
      totals[tx.type] += tx.cents;
      counts[tx.type] += 1;
      withheld += tx.withheldCents;
      balance += signed(tx);
      lines.push({
        id: tx.id,
        date: isoDate(tx.time),
        type: tx.type,
        description: tx.description,
        amount: fromCents(signed(tx)),
        balance: fromCents(balance),
      });

      const date = isoDate(tx.time);
      const last = series[series.length - 1];
      if (last.date === date) last.balance = fromCents(balance);
      else series.push({ date, balance: fromCents(balance) });
    }
    const endDate = isoDate(to);
    if (series[series.length - 1].date !== endDate) {
      series.push({ date: endDate, balance: fromCents(balance) });
    }

    // Monthly breakdown covers every month in the range, even quiet ones.
    let monthBalance = opening;
    const cursor = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1));
    while (cursor.getTime() <= to) {
      const key = cursor.toISOString().slice(0, 7);
      const c = { deposit: 0, withdrawal: 0, interest: 0, fee: 0 };
      for (const tx of inRange) {
        if (isoDate(tx.time).slice(0, 7) === key) c[tx.type] += tx.cents;
      }
      const net = c.deposit + c.interest - c.withdrawal - c.fee;
      monthBalance += net;
      monthly.push({
        month: key,
        deposits: fromCents(c.deposit),
        withdrawals: fromCents(c.withdrawal),
        interest: fromCents(c.interest),
        fees: fromCents(c.fee),
        net: fromCents(net),
        closingBalance: fromCents(monthBalance),
      });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    const net = totals.deposit + totals.interest - totals.withdrawal - totals.fee;
    const tax = this.tax(totals.interest, withheld, taxRate);

    // Year-end summary always covers the full calendar year.
    const year = request.taxYear ?? new Date(to).getUTCFullYear();
    if (!Number.isInteger(year) || year < 1970 || year > 9999) {
      throw new BadRequestException('taxYear is invalid');
    }
    const yearStart = Date.UTC(year, 0, 1);
    const yearEndTime = Date.UTC(year + 1, 0, 1);
    const yearTxs = txs.filter((t) => t.time >= yearStart && t.time < yearEndTime);
    const yearOpening = balanceBefore(yearStart);
    const yearTotals = { deposit: 0, withdrawal: 0, interest: 0, fee: 0 };
    let yearWithheld = 0;
    for (const tx of yearTxs) {
      yearTotals[tx.type] += tx.cents;
      yearWithheld += tx.withheldCents;
    }
    const yearClosing =
      yearOpening + yearTotals.deposit + yearTotals.interest - yearTotals.withdrawal - yearTotals.fee;
    const averageBalance = (yearOpening + yearClosing) / 2;

    return {
      accountName: request.accountName.trim(),
      accountId: request.accountId ?? null,
      currency,
      period: { from: isoDate(from), to: endDate },
      generatedAt: new Date(
        request.generatedAt !== undefined ? toTime(request.generatedAt, 'generatedAt') : Date.now(),
      ).toISOString(),
      openingBalance: fromCents(opening),
      closingBalance: fromCents(balance),
      totals: {
        deposits: fromCents(totals.deposit),
        withdrawals: fromCents(totals.withdrawal),
        interest: fromCents(totals.interest),
        fees: fromCents(totals.fee),
        net: fromCents(net),
      },
      counts: {
        deposits: counts.deposit,
        withdrawals: counts.withdrawal,
        interest: counts.interest,
        fees: counts.fee,
      },
      monthly,
      balanceSeries: series,
      tax,
      yearEnd: {
        year,
        openingBalance: fromCents(yearOpening),
        closingBalance: fromCents(yearClosing),
        deposits: fromCents(yearTotals.deposit),
        withdrawals: fromCents(yearTotals.withdrawal),
        fees: fromCents(yearTotals.fee),
        ...this.tax(yearTotals.interest, yearWithheld, taxRate),
        effectiveYieldPercent:
          averageBalance > 0 ? Math.round((yearTotals.interest / averageBalance) * 10_000) / 100 : 0,
      },
      transactions: lines,
    };
  }

  // ── HTML ───────────────────────────────────────────────────────────────

  renderHtml(summary: SavingsReportSummary): string {
    const money = (v: number) => escapeHtml(formatMoney(v, summary.currency));
    const monthlyRows = summary.monthly
      .map(
        (m) =>
          `<tr><td>${m.month}</td><td class="num">${money(m.deposits)}</td>` +
          `<td class="num">${money(m.withdrawals)}</td><td class="num">${money(m.interest)}</td>` +
          `<td class="num">${money(m.fees)}</td><td class="num">${money(m.closingBalance)}</td></tr>`,
      )
      .join('\n');
    const transactionRows =
      summary.transactions.length === 0
        ? '<tr><td colspan="5" class="empty">No transactions in this period</td></tr>'
        : summary.transactions
            .map(
              (t) =>
                `<tr><td>${t.date}</td><td>${TYPE_LABELS[t.type]}</td>` +
                `<td>${escapeHtml(t.description)}</td><td class="num">${money(t.amount)}</td>` +
                `<td class="num">${money(t.balance)}</td></tr>`,
            )
            .join('\n');

    const values: Record<string, string> = {
      title: escapeHtml(`Savings report - ${summary.accountName}`),
      accountName: escapeHtml(summary.accountName),
      accountId: escapeHtml(summary.accountId ?? '-'),
      currency: escapeHtml(summary.currency),
      periodFrom: summary.period.from,
      periodTo: summary.period.to,
      generatedAt: escapeHtml(summary.generatedAt),
      openingBalance: money(summary.openingBalance),
      closingBalance: money(summary.closingBalance),
      totalDeposits: money(summary.totals.deposits),
      totalWithdrawals: money(summary.totals.withdrawals),
      totalInterest: money(summary.totals.interest),
      totalFees: money(summary.totals.fees),
      netChange: money(summary.totals.net),
      depositCount: String(summary.counts.deposits),
      withdrawalCount: String(summary.counts.withdrawals),
      taxRate: `${(summary.tax.taxRate * 100).toFixed(2)}%`,
      interestIncome: money(summary.tax.interestIncome),
      estimatedTax: money(summary.tax.estimatedTax),
      taxWithheld: money(summary.tax.taxWithheld),
      taxDue: money(summary.tax.taxDue),
      year: String(summary.yearEnd.year),
      yearOpening: money(summary.yearEnd.openingBalance),
      yearClosing: money(summary.yearEnd.closingBalance),
      yearDeposits: money(summary.yearEnd.deposits),
      yearWithdrawals: money(summary.yearEnd.withdrawals),
      yearInterest: money(summary.yearEnd.interestIncome),
      yearFees: money(summary.yearEnd.fees),
      yearEstimatedTax: money(summary.yearEnd.estimatedTax),
      yearTaxWithheld: money(summary.yearEnd.taxWithheld),
      yearTaxDue: money(summary.yearEnd.taxDue),
      yearYield: `${summary.yearEnd.effectiveYieldPercent.toFixed(2)}%`,
    };
    const raw: Record<string, string> = {
      balanceChart: this.chartSvg(summary.balanceSeries),
      monthlyRows,
      transactionRows,
    };

    return this.loadTemplate()
      .replace(/\{\{\{\s*(\w+)\s*\}\}\}/g, (_, key: string) => raw[key] ?? '')
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => values[key] ?? '');
  }

  /** Balance growth line chart as inline SVG. */
  chartSvg(series: BalancePoint[], width = 640, height = 220): string {
    const pad = { left: 56, right: 12, top: 12, bottom: 28 };
    const points = this.chartPoints(series, pad.left, pad.top, width - pad.left - pad.right, height - pad.top - pad.bottom, true);
    const { min, max } = this.chartRange(series);
    const gridY = [0, 0.5, 1].map((f) => pad.top + (height - pad.top - pad.bottom) * (1 - f));
    const labels = [min, (min + max) / 2, max];
    return [
      `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Balance growth">`,
      ...gridY.map(
        (y, i) =>
          `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" class="grid"/>` +
          `<text x="${pad.left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis">${labels[i].toFixed(0)}</text>`,
      ),
      `<polyline class="balance" fill="none" points="${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`,
      `<text x="${pad.left}" y="${height - 8}" class="axis">${series[0]?.date ?? ''}</text>`,
      `<text x="${width - pad.right}" y="${height - 8}" text-anchor="end" class="axis">${series[series.length - 1]?.date ?? ''}</text>`,
      '</svg>',
    ].join('\n');
  }

  // ── PDF ────────────────────────────────────────────────────────────────

  renderPdf(summary: SavingsReportSummary): Buffer {
    const pdf = new PdfWriter(`Savings report - ${summary.accountName}`);
    const margin = 48;
    const right = PdfWriter.WIDTH - margin;
    const accent: Rgb = [0.11, 0.37, 0.63];
    const muted: Rgb = [0.4, 0.4, 0.4];
    const money = (v: number) => formatMoney(v, summary.currency);
    let y = 0;

    const newPage = () => {
      pdf.addPage();
      y = PdfWriter.HEIGHT - margin;
      pdf.text(margin, 24, `${summary.accountName} - ${summary.period.from} to ${summary.period.to}`, {
        size: 8,
        color: muted,
      });
      pdf.text(right, 24, `Page ${pdf.pageCount}`, { size: 8, color: muted, align: 'right' });
    };
    const ensure = (space: number) => {
      if (y - space < margin) newPage();
    };
    const heading = (text: string) => {
      ensure(40);
      y -= 18;
      pdf.text(margin, y, text, { size: 13, bold: true, color: accent });
      y -= 6;
      pdf.line(margin, y, right, y, accent, 0.75);
      y -= 14;
    };
    const row = (label: string, value: string, bold = false) => {
      ensure(16);
      pdf.text(margin, y, label, { bold });
      pdf.text(right, y, value, { bold, align: 'right' });
      y -= 15;
    };
    const table = (headers: string[], rows: string[][], columns: number[]) => {
      const draw = (cells: string[], bold: boolean) => {
        // Positive column positions are left edges; negative ones are right
        // edges of right-aligned (numeric) columns.
        cells.forEach((cell, i) => {
          pdf.text(Math.abs(columns[i]), y, cell, {
            size: 8.5,
            bold,
            align: columns[i] < 0 ? 'right' : 'left',
          });
        });
        y -= 13;
      };
      ensure(30);
      pdf.rect(margin, y - 4, right - margin, 14, [0.93, 0.95, 0.98]);
      draw(headers, true);
      for (const r of rows) {
        if (y - 13 < margin) {
          newPage();
          pdf.rect(margin, y - 4, right - margin, 14, [0.93, 0.95, 0.98]);
          draw(headers, true);
        }
        draw(r, false);
      }
      y -= 6;
    };

    // Cover / summary
    newPage();
    pdf.text(margin, y, 'Savings Report', { size: 22, bold: true, color: accent });
    y -= 22;
    pdf.text(margin, y, summary.accountName, { size: 12, bold: true });
    y -= 15;
    pdf.text(margin, y, `Account: ${summary.accountId ?? '-'}    Currency: ${summary.currency}`, { color: muted });
    y -= 13;
    pdf.text(margin, y, `Period: ${summary.period.from} to ${summary.period.to}    Generated: ${summary.generatedAt}`, {
      color: muted,
    });
    y -= 10;

    heading('Transaction summary');
    row('Opening balance', money(summary.openingBalance));
    row(`Deposits (${summary.counts.deposits})`, money(summary.totals.deposits));
    row(`Withdrawals (${summary.counts.withdrawals})`, money(-summary.totals.withdrawals));
    row('Interest earned', money(summary.totals.interest));
    row('Fees', money(-summary.totals.fees));
    row('Net change', money(summary.totals.net), true);
    row('Closing balance', money(summary.closingBalance), true);

    // Chart
    heading('Balance growth');
    const chartHeight = 170;
    ensure(chartHeight + 30);
    const chartLeft = margin + 50;
    const chartWidth = right - chartLeft;
    const chartBottom = y - chartHeight;
    const { min, max } = this.chartRange(summary.balanceSeries);
    for (const f of [0, 0.5, 1]) {
      const gy = chartBottom + chartHeight * f;
      pdf.line(chartLeft, gy, right, gy);
      pdf.text(chartLeft - 6, gy - 3, (min + (max - min) * f).toFixed(0), { size: 7, color: muted, align: 'right' });
    }
    pdf.polyline(
      this.chartPoints(summary.balanceSeries, chartLeft, chartBottom, chartWidth, chartHeight, false),
      accent,
      1.75,
    );
    pdf.text(chartLeft, chartBottom - 12, summary.balanceSeries[0]?.date ?? '', { size: 7, color: muted });
    pdf.text(right, chartBottom - 12, summary.balanceSeries[summary.balanceSeries.length - 1]?.date ?? '', {
      size: 7,
      color: muted,
      align: 'right',
    });
    y = chartBottom - 26;

    // Monthly breakdown
    heading('Deposits and withdrawals by month');
    table(
      ['Month', 'Deposits', 'Withdrawals', 'Interest', 'Fees', 'Closing balance'],
      summary.monthly.map((m) => [
        m.month,
        money(m.deposits),
        money(m.withdrawals),
        money(m.interest),
        money(m.fees),
        money(m.closingBalance),
      ]),
      [margin + 4, -200, -275, -350, -420, -(right - 4)],
    );

    // Tax
    heading('Interest and tax');
    row('Interest income', money(summary.tax.interestIncome));
    row(`Estimated tax at ${(summary.tax.taxRate * 100).toFixed(2)}%`, money(summary.tax.estimatedTax));
    row('Tax withheld', money(summary.tax.taxWithheld));
    row(summary.tax.taxDue >= 0 ? 'Tax due' : 'Refund due', money(Math.abs(summary.tax.taxDue)), true);

    heading(`Year-end tax summary ${summary.yearEnd.year}`);
    row('Opening balance (1 Jan)', money(summary.yearEnd.openingBalance));
    row('Total deposits', money(summary.yearEnd.deposits));
    row('Total withdrawals', money(-summary.yearEnd.withdrawals));
    row('Interest income', money(summary.yearEnd.interestIncome));
    row('Fees', money(-summary.yearEnd.fees));
    row('Closing balance (31 Dec)', money(summary.yearEnd.closingBalance), true);
    row('Effective yield', `${summary.yearEnd.effectiveYieldPercent.toFixed(2)}%`);
    row('Estimated tax', money(summary.yearEnd.estimatedTax));
    row('Tax withheld', money(summary.yearEnd.taxWithheld));
    row(summary.yearEnd.taxDue >= 0 ? 'Tax due' : 'Refund due', money(Math.abs(summary.yearEnd.taxDue)), true);

    // Transactions
    heading('Transactions');
    if (summary.transactions.length === 0) {
      pdf.text(margin, y, 'No transactions in this period', { color: muted });
      y -= 15;
    } else {
      table(
        ['Date', 'Type', 'Description', 'Amount', 'Balance'],
        summary.transactions.map((t) => [
          t.date,
          TYPE_LABELS[t.type],
          t.description.length > 38 ? `${t.description.slice(0, 37)}...` : t.description,
          money(t.amount),
          money(t.balance),
        ]),
        [margin + 4, margin + 72, margin + 140, -420, -(right - 4)],
      );
    }

    ensure(30);
    y -= 10;
    pdf.text(
      margin,
      y,
      'Tax figures are estimates based on the rate provided and are not tax advice.',
      { size: 7.5, color: muted },
    );

    return pdf.toBuffer(new Date(summary.generatedAt));
  }

  // ── internals ──────────────────────────────────────────────────────────

  private tax(interestCents: number, withheldCents: number, taxRate: number): TaxSummary {
    const estimated = Math.round(interestCents * taxRate);
    return {
      taxRate,
      interestIncome: fromCents(interestCents),
      estimatedTax: fromCents(estimated),
      taxWithheld: fromCents(withheldCents),
      taxDue: fromCents(estimated - withheldCents),
    };
  }

  private parse(transactions: ReportTransaction[]): Tx[] {
    return transactions
      .map((t, i) => {
        if (!TYPES.includes(t.type)) {
          throw new BadRequestException(`transactions[${i}].type is invalid`);
        }
        if (!Number.isFinite(t.amount) || t.amount <= 0) {
          throw new BadRequestException(`transactions[${i}].amount must be positive`);
        }
        const withheld = t.taxWithheld ?? 0;
        if (!Number.isFinite(withheld) || withheld < 0) {
          throw new BadRequestException(`transactions[${i}].taxWithheld must not be negative`);
        }
        return {
          id: t.id ?? null,
          type: t.type,
          cents: toCents(t.amount),
          withheldCents: toCents(withheld),
          time: toTime(t.timestamp, `transactions[${i}].timestamp`),
          description: t.description ?? TYPE_LABELS[t.type],
        };
      })
      .sort((a, b) => a.time - b.time);
  }

  private chartRange(series: BalancePoint[]): { min: number; max: number } {
    const values = series.map((p) => p.balance);
    const min = Math.min(0, ...values);
    const max = Math.max(...values, 0);
    return { min, max: max === min ? min + 1 : max };
  }

  /** Map balance points into a box. `flipY` for SVG (y grows downward). */
  private chartPoints(
    series: BalancePoint[],
    left: number,
    bottomOrTop: number,
    width: number,
    height: number,
    flipY: boolean,
  ): [number, number][] {
    if (series.length === 0) return [];
    const { min, max } = this.chartRange(series);
    const times = series.map((p) => Date.parse(p.date));
    const t0 = times[0];
    const span = Math.max(times[times.length - 1] - t0, 1);
    const points = series.map((p, i): [number, number] => {
      const x = left + (width * (times[i] - t0)) / span;
      const f = (p.balance - min) / (max - min);
      return [x, flipY ? bottomOrTop + height * (1 - f) : bottomOrTop + height * f];
    });
    // A single point still draws a flat line across the chart.
    return points.length === 1 ? [points[0], [left + width, points[0][1]]] : points;
  }

  private loadTemplate(): string {
    if (this.template === null) {
      const path = join(__dirname, 'templates', 'report-template.html');
      if (!existsSync(path)) {
        throw new Error(`Report template not found at ${path}`);
      }
      this.template = readFileSync(path, 'utf8');
    }
    return this.template;
  }
}
