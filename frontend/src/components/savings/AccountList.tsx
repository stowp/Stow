"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { SavingsAccount } from "@/hooks/useSavingsAccount";
import { formatStroopsAmount } from "@/lib/currency";
import { matchesSearch } from "@/lib/nicknames";
import AriaLive from "@/components/a11y/AriaLive";

export interface AccountListProps {
  accounts: SavingsAccount[];
  isLoading?: boolean;
}

const KIND_LABELS: Record<SavingsAccount["kind"], string> = {
  locked: "Locked plan",
  goal: "Goal",
};

/**
 * The user's savings accounts (locked plans and goals), nickname first, with
 * a search box that matches nicknames as well as account names.
 */
export default function AccountList({
  accounts,
  isLoading = false,
}: AccountListProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () =>
      accounts.filter((a) =>
        matchesSearch(query, [a.nickname, a.name, KIND_LABELS[a.kind]]),
      ),
    [accounts, query],
  );

  return (
    <section aria-labelledby={`${searchId}-heading`}>
      <AriaLive
        message={
          isLoading
            ? "Loading accounts."
            : `${visible.length} ${visible.length === 1 ? "account" : "accounts"} shown.`
        }
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2
          id={`${searchId}-heading`}
          className="text-sm font-medium text-muted"
        >
          Your accounts
        </h2>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search accounts"
            aria-label="Search accounts"
            className="w-56 rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/50"
          />
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted" data-testid="account-list-loading">
          Loading accounts…
        </p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted" data-testid="account-list-empty">
          No locked plans or goals yet.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted" data-testid="account-list-no-match">
          No accounts match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((account) => (
            <li key={`${account.kind}:${account.id}`}>
              <Link
                href={account.href}
                className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-card/70 focus:outline-none focus:ring-2 focus:ring-brand/50"
              >
                <span className="min-w-0">
                  <span
                    data-testid="account-display-name"
                    className="block truncate text-base font-semibold text-foreground"
                  >
                    {account.displayName}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {KIND_LABELS[account.kind]}
                    {account.nickname ? ` · ${account.name}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-medium text-foreground">
                  {formatStroopsAmount(account.balance)} XLM
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
