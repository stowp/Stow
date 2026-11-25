import { useState, useCallback, useEffect } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { unwrapApiData } from "@/lib/activity";
import { cacheKeys, withOfflineCache } from "@/lib/offline";

export interface FlexibleAccount {
  account: string;
  /** Balance in stroops. */
  amount: string;
  created_at: string;
  updated_at: string;
}

export type FlexibleBalanceStatus = "loading" | "ready" | "error";

export interface UseFlexibleBalanceReturn {
  /** Null once loaded means the address has never held a flexible balance. */
  account: FlexibleAccount | null;
  status: FlexibleBalanceStatus;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetches the address's flexible savings balance from
 * `GET /api/savings/accounts/:address`. A 404 means no account has been
 * observed yet, which is surfaced as a ready state with `account: null`
 * rather than an error.
 */
export function useFlexibleBalance(
  address: string | null,
): UseFlexibleBalanceReturn {
  const [account, setAccount] = useState<FlexibleAccount | null>(null);
  const [status, setStatus] = useState<FlexibleBalanceStatus>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [refetchCount, setRefetchCount] = useState(0);

  const fetchBalance = useCallback(async () => {
    if (!address) return;

    setStatus("loading");
    setError(null);

    try {
      // Cached for offline viewing; served from the cache when offline.
      const { data } = await withOfflineCache(
        cacheKeys.balance(address),
        async (): Promise<FlexibleAccount | null> => {
          const response = await apiFetch(
            `/api/savings/accounts/${encodeURIComponent(address)}`,
          );

          if (response.status === 404) return null;

          if (!response.ok) {
            throw new ApiError(
              `Failed to load flexible balance: ${response.statusText}`,
              response.status,
            );
          }

          return unwrapApiData<FlexibleAccount>(await response.json());
        },
      );
      setAccount(data);
      setStatus("ready");
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error("Unknown error occurred"),
      );
      setStatus("error");
    }
  }, [address]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance, refetchCount]);

  const refetch = useCallback(() => {
    setRefetchCount((c) => c + 1);
  }, []);

  return { account, status, error, refetch };
}
