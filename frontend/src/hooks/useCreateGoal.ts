import { useState, useCallback } from "react";
import { apiFetch, ApiError } from "@/lib/api";

export type CreateGoalStatus = "idle" | "submitting" | "error";

export interface CreatedGoal {
  on_chain_id: string;
  name: string;
  target_amount: string;
}

export interface UseCreateGoalReturn {
  status: CreateGoalStatus;
  error: Error | null;
  isLoading: boolean;
  createGoal: (name: string, targetAmount: string) => Promise<CreatedGoal | null>;
  reset: () => void;
}

export function useCreateGoal(): UseCreateGoalReturn {
  const [status, setStatus] = useState<CreateGoalStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const createGoal = useCallback(
    async (name: string, targetAmount: string): Promise<CreatedGoal | null> => {
      setStatus("submitting");
      setError(null);

      try {
        const response = await apiFetch("/api/goals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, target_amount: targetAmount }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to create goal: ${response.statusText}`;
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

        const data: CreatedGoal = await response.json();
        setStatus("idle");
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
    isLoading: status === "submitting",
    createGoal,
    reset,
  };
}
