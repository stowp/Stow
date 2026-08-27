import { renderHook, act, waitFor } from "@testing-library/react";
import { useGoalClaim } from "./useGoalClaim";
import * as api from "@/lib/api";

// jest.mock("@/lib/api") auto-mocks ApiError as a bare mock function (not a
// real Error subclass), which would make `err instanceof Error` false inside
// the hook and mask the real error message with the hook's generic fallback
// (see the identical, currently-failing pattern in useAnchorWithdraw.test.ts).
// Keep the real ApiError implementation so error assertions here reflect
// what the hook actually does.
jest.mock("@/lib/api", () => ({
  __esModule: true,
  apiFetch: jest.fn(),
  ApiError: jest.requireActual("@/lib/api").ApiError,
}));

const mockApiFetch = api.apiFetch as jest.MockedFunction<typeof api.apiFetch>;

describe("useGoalClaim", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("initializes with correct default values", () => {
    const { result } = renderHook(() => useGoalClaim());

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("successfully claims a goal", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ on_chain_id: "goal-1", status: "claimed" }),
    } as Response);

    const { result } = renderHook(() => useGoalClaim());

    let claimed;
    await act(async () => {
      claimed = await result.current.claimGoal("goal-1");
    });

    expect(claimed).toEqual({ on_chain_id: "goal-1", status: "claimed" });
    await waitFor(() => {
      expect(result.current.status).toBe("success");
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/goals/goal-1/claim",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sets isLoading true while a claim is pending", async () => {
    let resolveFetch!: (value: unknown) => void;
    mockApiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }) as Promise<Response>,
    );

    const { result } = renderHook(() => useGoalClaim());

    act(() => {
      result.current.claimGoal("goal-1");
    });

    await waitFor(() => {
      expect(result.current.status).toBe("pending");
      expect(result.current.isLoading).toBe(true);
    });

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ on_chain_id: "goal-1", status: "claimed" }) });
    });
  });

  it("handles a rejected claim (e.g. not yet reached)", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "Goal has not reached its target yet" }),
    } as Response);

    const { result } = renderHook(() => useGoalClaim());

    let claimed;
    await act(async () => {
      claimed = await result.current.claimGoal("goal-1");
    });

    expect(claimed).toBeNull();
    await waitFor(() => {
      expect(result.current.status).toBe("error");
      expect(result.current.error?.message).toContain("Goal has not reached its target yet");
    });
  });

  it("handles network errors", async () => {
    const networkError = new Error("Network error");
    mockApiFetch.mockRejectedValueOnce(networkError);

    const { result } = renderHook(() => useGoalClaim());

    await act(async () => {
      await result.current.claimGoal("goal-1");
    });

    await waitFor(() => {
      expect(result.current.error).toEqual(networkError);
      expect(result.current.status).toBe("error");
    });
  });

  it("resets state correctly", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ on_chain_id: "goal-1", status: "claimed" }),
    } as Response);

    const { result } = renderHook(() => useGoalClaim());

    await act(async () => {
      await result.current.claimGoal("goal-1");
    });

    await waitFor(() => expect(result.current.status).toBe("success"));

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});
