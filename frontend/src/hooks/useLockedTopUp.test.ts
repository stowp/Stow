import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as api from "@/lib/api";
import {
  useLockedTopUp,
  validateTopUpAmount,
  parseTopUpAmountToStroops,
} from "./useLockedTopUp";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, apiFetch: vi.fn() };
});

const mockApiFetch = api.apiFetch as unknown as ReturnType<typeof vi.fn>;

const updatedPlan = {
  on_chain_id: "7",
  owner: "GOWNER",
  balance: "150000000",
  unlock_at: "2099-01-01T00:00:00.000Z",
};

describe("parseTopUpAmountToStroops", () => {
  it("converts whole and fractional amounts without float error", () => {
    expect(parseTopUpAmountToStroops("5")).toBe("50000000");
    expect(parseTopUpAmountToStroops("0.1")).toBe("1000000");
    expect(parseTopUpAmountToStroops("12,5")).toBe("125000000");
    expect(parseTopUpAmountToStroops("0.0000001")).toBe("1");
    expect(parseTopUpAmountToStroops("922337203685.4775807")).toBe(
      "9223372036854775807",
    );
  });

  it("rejects malformed or over-precise input", () => {
    expect(parseTopUpAmountToStroops("abc")).toBeNull();
    expect(parseTopUpAmountToStroops("-1")).toBeNull();
    expect(parseTopUpAmountToStroops("1.2.3")).toBeNull();
    expect(parseTopUpAmountToStroops("1.00000001")).toBeNull();
  });
});

describe("validateTopUpAmount", () => {
  it("flags each invalid case", () => {
    expect(validateTopUpAmount("")).toBe("required");
    expect(validateTopUpAmount("   ")).toBe("required");
    expect(validateTopUpAmount("ten")).toBe("invalid");
    expect(validateTopUpAmount("-5")).toBe("invalid");
    expect(validateTopUpAmount("0")).toBe("too-small");
    expect(validateTopUpAmount("0.0000000")).toBe("too-small");
    expect(validateTopUpAmount("1.12345678")).toBe("too-precise");
  });

  it("accepts positive amounts", () => {
    expect(validateTopUpAmount("5")).toBeNull();
    expect(validateTopUpAmount(" 2.5 ")).toBeNull();
    expect(validateTopUpAmount("0.0000001")).toBeNull();
  });
});

describe("useLockedTopUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the amount in stroops with an idempotency key and returns the updated plan", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => updatedPlan,
    } as Response);

    const { result } = renderHook(() => useLockedTopUp());

    let returned;
    await act(async () => {
      returned = await result.current.topUp("7", "GOWNER", "5");
    });

    expect(returned).toEqual(updatedPlan);
    expect(result.current.status).toBe("success");
    expect(result.current.error).toBeNull();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockApiFetch.mock.calls[0];
    expect(url).toBe("/api/savings/locked/7/top-up");
    expect(init.method).toBe("POST");
    expect(init.headers["Idempotency-Key"]).toEqual(expect.any(String));
    expect(JSON.parse(init.body)).toEqual({
      owner: "GOWNER",
      amount: "50000000",
    });
    // A top-up never sends or changes the unlock time.
    expect(JSON.parse(init.body)).not.toHaveProperty("unlock_at");
  });

  it("rejects an invalid amount without calling the API", async () => {
    const { result } = renderHook(() => useLockedTopUp());

    let returned;
    await act(async () => {
      returned = await result.current.topUp("7", "GOWNER", "0");
    });

    expect(returned).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toMatch(/greater than zero/i);
  });

  it("surfaces the API error message on failure", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "Insufficient wallet balance" }),
    } as Response);

    const { result } = renderHook(() => useLockedTopUp());

    await act(async () => {
      await result.current.topUp("7", "GOWNER", "5");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("Insufficient wallet balance");
  });

  it("falls back to the status text when the error body isn't JSON", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    const { result } = renderHook(() => useLockedTopUp());

    await act(async () => {
      await result.current.topUp("7", "GOWNER", "5");
    });

    expect(result.current.error?.message).toBe(
      "Failed to top up plan: Internal Server Error",
    );
  });

  it("reset returns to idle", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useLockedTopUp());

    await act(async () => {
      await result.current.topUp("7", "GOWNER", "5");
    });
    expect(result.current.status).toBe("error");

    act(() => result.current.reset());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});
