"use client";

import { useRef, useState } from "react";
import { Check, Copy, Gift, Users } from "lucide-react";
import { useReferrals, type ReferralStatus } from "@/hooks/useReferrals";
import ErrorRetry from "@/components/ui/ErrorRetry";
import { SavingsListSkeleton, SummaryCardSkeleton } from "@/components/savings";

type CopyStatus = "idle" | "copied" | "error";

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error("Clipboard API unavailable");
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const success = document.execCommand("copy");
      document.body.removeChild(textarea);
      return success;
    } catch {
      return false;
    }
  }
}

function StatusBadge({ status }: { status: ReferralStatus }) {
  const styles =
    status === "qualified"
      ? "bg-brand/10 text-brand border-brand/30"
      : "bg-yellow-400/10 text-yellow-400 border-yellow-400/30";

  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${styles}`}
    >
      {status}
    </span>
  );
}

export default function ReferralsPage() {
  const { data, error, isLoading, refetch } = useReferrals();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const resetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const referralLink =
    typeof window !== "undefined" && data
      ? `${window.location.origin}/signup?ref=${data.referral_code}`
      : "";

  async function handleCopy() {
    if (!referralLink) return;
    const success = await copyToClipboard(referralLink);
    setCopyStatus(success ? "copied" : "error");
    if (resetTimeout.current) clearTimeout(resetTimeout.current);
    resetTimeout.current = setTimeout(() => setCopyStatus("idle"), 2000);
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="mx-auto max-w-2xl">
          <ErrorRetry error={error} onRetry={refetch} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-2">
            <Gift className="h-7 w-7 sm:h-8 sm:w-8 text-brand shrink-0" />
            <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
              Referrals
            </h1>
          </div>
          <p className="text-muted">
            Invite friends and track who has joined using your link.
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-6">
            <SummaryCardSkeleton />
            <div className="grid grid-cols-3 gap-3">
              <SummaryCardSkeleton />
              <SummaryCardSkeleton />
              <SummaryCardSkeleton />
            </div>
            <SavingsListSkeleton rows={3} />
          </div>
        ) : (
          data && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-border bg-card p-6">
                <label
                  htmlFor="referral-link"
                  className="block text-sm font-medium text-foreground mb-2"
                >
                  Your referral link
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="referral-link"
                    type="text"
                    readOnly
                    value={referralLink}
                    className="w-full min-w-0 select-all rounded-xl border border-border bg-background px-4 py-3 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand/50 overflow-hidden text-ellipsis"
                  />
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label="Copy referral link"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background-elevated text-muted transition-colors hover:bg-white/5 hover:text-foreground"
                  >
                    {copyStatus === "copied" ? (
                      <Check className="h-4 w-4 text-brand" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
                {copyStatus === "error" && (
                  <p role="alert" className="mt-2 text-xs text-red-400">
                    Couldn&apos;t copy automatically — please copy manually.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 text-center">
                  <p className="text-xl sm:text-2xl font-semibold text-foreground">
                    {data.total}
                  </p>
                  <p className="text-xs text-muted mt-1">Total</p>
                </div>
                <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 text-center">
                  <p className="text-xl sm:text-2xl font-semibold text-yellow-400">
                    {data.pending}
                  </p>
                  <p className="text-xs text-muted mt-1">Pending</p>
                </div>
                <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 text-center">
                  <p className="text-xl sm:text-2xl font-semibold text-brand">
                    {data.qualified}
                  </p>
                  <p className="text-xs text-muted mt-1">Qualified</p>
                </div>
              </div>

              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3">
                  <Users className="h-4 w-4 text-muted" />
                  Your referrals
                </h2>

                {data.referrals.length === 0 ? (
                  <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted">
                    No referrals yet. Share your link to get started.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {data.referrals.map((referral) => (
                      <div
                        key={referral.id}
                        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">
                            {referral.referred_username ??
                              referral.referred_stellar_address}
                          </p>
                          <p className="text-xs text-muted mt-0.5">
                            Joined{" "}
                            {new Date(referral.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="sm:ml-4">
                          <StatusBadge status={referral.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
