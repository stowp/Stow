import { renderHook, act, waitFor } from "@testing-library/react";
import { useCreateGoal } from "./useCreateGoal";
import * as api from "@/lib/api";

jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return { ...actual, apiFetch: jest.fn() };
});

const mockApiFetch = api.apiFetch as jest.MockedFunction<typeof api.apiFetch>;

describe("useCreateGoal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("initializes with correct default values", () => {
    const { result } = renderHook(() => useCreateGoal());

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("successfully creates a goal", async () => {
    const mockGoal = {
      on_chain_id: "goal-123",
      name: "New laptop",
      target_amount: "5000000000",
    };
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockGoal,
    } as Response);

    const { result } = renderHook(() => useCreateGoal());

    let created: Awaited<ReturnType<typeof result.current.createGoal>> = null;
    await act(async () => {
      created = await result.current.createGoal("New laptop", "5000000000");
    });

    expect(created).toEqual(mockGoal);
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/goals",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "New laptop", target_amount: "5000000000" }),
      }),
    );
  });

  it("handles a failed creation", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "Invalid target amount" }),
    } as Response);

    const { result } = renderHook(() => useCreateGoal());

    let created: Awaited<ReturnType<typeof result.current.createGoal>> = null;
    await act(async () => {
      created = await result.current.createGoal("New laptop", "0");
    });

    expect(created).toBeNull();
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error?.message).toBe("Invalid target amount");
  });

  it("resets state", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({}),
    } as Response);

    const { result } = renderHook(() => useCreateGoal());

    await act(async () => {
      await result.current.createGoal("New laptop", "5000000000");
    });
    expect(result.current.status).toBe("error");

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});
