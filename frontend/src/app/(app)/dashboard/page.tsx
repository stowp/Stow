"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard,
  ArrowDownToLine,
  ArrowUpFromLine,
  Target,
  Users,
} from "lucide-react";
import { useSession } from "@/context/SessionProvider";
import { useSavingsSummary } from "@/hooks/useSavingsSummary";
import { useSavingsAccounts } from "@/hooks/useSavingsAccount";
import AccountList from "@/components/savings/AccountList";
import SummaryCards from "@/components/savings/SummaryCards";
import PortfolioAllocationChart from "@/components/savings/PortfolioAllocationChart";
import DepositModal from "@/components/savings/DepositModal";
import WithdrawModal from "@/components/savings/WithdrawModal";
import ErrorRetry from "@/components/ui/ErrorRetry";
import AriaLive from "@/components/a11y/AriaLive";

/** Assets offered in the deposit QR's SEP-7 payment request. USDC is only
 * included when its issuer is configured, since a SEP-7 request for a
 * non-native asset needs the issuer to be unambiguous. */
const USDC_ISSUER = process.env.NEXT_PUBLIC_USDC_ISSUER;
const DEPOSIT_QR_ASSETS: DepositQrAsset[] = [
  { code: "XLM" },
  ...(USDC_ISSUER ? [{ code: "USDC", issuer: USDC_ISSUER }] : []),
];

/**
 * Dashboard savings overview: per-product totals from `GET
 * /api/savings/summary`, plus quick actions for the flows a user reaches
 * for most (deposit, withdraw, start a goal, start a group).
 */
export default function DashboardPage() {
  const { address } = useSession();
  const router = useRouter();
  const { summary, status, error, refetch } = useSavingsSummary(address);
  // Declared after `useSavingsSummary` so the summary request is issued first.
  const { deposits, status: depositsStatus } = useDepositHistory(address);
  const { accounts, status: accountsStatus } = useSavingsAccounts(address);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const flexibleBalance =
    summary?.products.find((p) => p.product === "flexible")?.total ?? "0";

  const isLoading = status === "loading";

  return (
    <div className="min-h-screen bg-background p-6">
      <AriaLive
        message={
          status === "error"
            ? "Could not load your savings summary."
            : status === "ready"
              ? "Your savings summary is available."
              : ""
        }
        politeness={status === "error" ? "assertive" : "polite"}
      />
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center gap-3">
          <LayoutDashboard className="h-8 w-8 text-brand" />
          <h1 className="text-3xl font-semibold text-foreground">
            Your savings
          </h1>
        </div>

        {status === "error" ? (
          <ErrorRetry error={error} onRetry={refetch} />
        ) : (
          <>
            <SummaryCards summary={summary} isLoading={isLoading} />
            <PortfolioAllocationChart summary={summary} isLoading={isLoading} />

            {address && accountsStatus !== "error" && (
              <div className="mt-8">
                <AccountList
                  accounts={accounts}
                  isLoading={accountsStatus === "loading"}
                />
              </div>
            )}

            <div className="mt-8">
              <h2 className="mb-3 text-sm font-medium text-muted">
                Quick actions
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <button
                  type="button"
                  onClick={() => setDepositOpen(true)}
                  disabled={!address}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-card/70 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/50"
                >
                  <ArrowDownToLine
                    className="h-5 w-5 text-brand"
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium text-foreground">
                    Deposit
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setWithdrawOpen(true)}
                  disabled={!address || !summary || BigInt(flexibleBalance) <= BigInt(0)}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-card/70 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/50"
                >
                  <ArrowUpFromLine
                    className="h-5 w-5 text-brand"
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium text-foreground">
                    Withdraw
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => router.push("/savings/goals/new")}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-card/70 focus:outline-none focus:ring-2 focus:ring-brand/50"
                >
                  <Target className="h-5 w-5 text-brand" aria-hidden="true" />
                  <span className="text-sm font-medium text-foreground">
                    New goal
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => router.push("/savings/groups/new")}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-card/70 focus:outline-none focus:ring-2 focus:ring-brand/50"
                >
                  <Users className="h-5 w-5 text-brand" aria-hidden="true" />
                  <span className="text-sm font-medium text-foreground">
                    New group
                  </span>
                </button>
              </div>
            </div>

            {address && depositsStatus !== "error" && (
              <SavingsStreakTracker
                className="mt-8"
                depositDates={deposits.map((d) => d.created_at)}
                isLoading={depositsStatus === "loading"}
              />
            )}
          </>
        )}
      </div>

      {address && (
        <DepositModal
          open={depositOpen}
          onClose={() => setDepositOpen(false)}
          account={address}
        />
      )}

      {address && (
        <WithdrawModal
          open={withdrawOpen}
          onClose={() => setWithdrawOpen(false)}
          account={address}
          balance={flexibleBalance}
          onWithdrawn={refetch}
        />
      )}
    </div>
  );
}
