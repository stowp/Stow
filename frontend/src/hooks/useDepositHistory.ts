import { useState, useCallback, useEffect } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { cacheKeys, withOfflineCache } from "@/lib/offline";

export interface DepositHistoryEntry {
  /** ISO-8601 timestamp of when the deposit was recorded. */
  created_at: string;
  amount?: string;
}

export type DepositHistoryStatus = "loading" | "ready" | "error";

export interface UseDepositHistoryReturn {
  deposits: DepositHistoryEntry[];
  status: DepositHistoryStatus;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetches the address's deposit history (`GET
 * /api/savings/deposits?address=`), used to compute savings streaks. A 404
 * is treated as "no deposits yet" rather than an error, since a brand-new
 * address has no history to return. Mirrors `useSavingsSummary`'s
 * fetch-on-mount/refetch shape.
 */
export function useDepositHistory(
  address: string | null,
): UseDepositHistoryReturn {
  const [deposits, setDeposits] = useState<DepositHistoryEntry[]>([]);
  const [status, setStatus] = useState<DepositHistoryStatus>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [refetchCount, setRefetchCount] = useState(0);

  const fetchDeposits = useCallback(async () => {
    if (!address) return;

    setStatus("loading");
    setError(null);

    try {
      // Cached for offline viewing; served from the cache when offline.
      const { data } = await withOfflineCache(
        cacheKeys.deposits(address),
        async (): Promise<DepositHistoryEntry[]> => {
          const response = await apiFetch(
            `/api/savings/deposits?address=${encodeURIComponent(address)}`,
          );

          if (response.status === 404) return [];

          if (!response.ok) {
            throw new ApiError(
              `Failed to load deposit history: ${response.statusText}`,
              response.status,
            );
          }

          const body:
            | { deposits?: DepositHistoryEntry[] }
            | DepositHistoryEntry[] = await response.json();
          return Array.isArray(body) ? body : (body.deposits ?? []);
        },
      );
      setDeposits(data);
      setStatus("ready");
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error("Unknown error occurred"),
      );
      setStatus("error");
    }
  }, [address]);

  useEffect(() => {
    fetchDeposits();
  }, [fetchDeposits, refetchCount]);

  const refetch = useCallback(() => {
    setRefetchCount((c) => c + 1);
  }, []);

  return { deposits, status, error, refetch };
}
