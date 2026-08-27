import { useState, useCallback } from "react";
import { apiFetch, ApiError } from "@/lib/api";

export type GoalClaimStatus = "idle" | "pending" | "success" | "error";

export interface ClaimedGoal {
  on_chain_id: string;
  status: string;
}

export interface UseGoalClaimReturn {
  status: GoalClaimStatus;
  error: Error | null;
  isLoading: boolean;
  claimGoal: (goalId: string) => Promise<ClaimedGoal | null>;
  reset: () => void;
}

export function useGoalClaim(): UseGoalClaimReturn {
  const [status, setStatus] = useState<GoalClaimStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const claimGoal = useCallback(
    async (goalId: string): Promise<ClaimedGoal | null> => {
      setStatus("pending");
      setError(null);

      try {
        const response = await apiFetch(`/api/goals/${goalId}/claim`, {
          method: "POST",
        });

        if (!response.ok) {
          let errorMessage = `Failed to claim goal: ${response.statusText}`;
          try {
            const errorData = await response.json();
            if (errorData.message) {
              errorMessage = errorData.message;
            }
          } catch {
            // Response body is not JSON, use default message
          }
          throw new ApiError(errorMessage, response.status);
        }

        const data: ClaimedGoal = await response.json();
        setStatus("success");
        return data;
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error("Unknown error occurred"),
        );
        setStatus("error");
        return null;
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return {
    status,
    error,
    isLoading: status === "pending",
    claimGoal,
    reset,
  };
}
