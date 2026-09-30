import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSession } from "@/context/SessionProvider";
import * as api from "@/lib/api";
import LockedPlanDetailPage from "./page";

vi.mock("@/context/SessionProvider", () => ({
  useSession: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, apiFetch: vi.fn() };
});

const mockApiFetch = api.apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockUseSession = useSession as unknown as ReturnType<typeof vi.fn>;

const UNLOCK_AT = "2099-01-01T00:00:00.000Z";

const lockedPlan = {
  on_chain_id: "7",
  owner: "GOWNER",
  balance: "100000000", // 10 XLM
  unlock_at: UNLOCK_AT,
};

function listResponse(plans: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      address: "GOWNER",
      plans,
      total: plans.length,
      page: 1,
      limit: 100,
    }),
  } as Response;
}

function renderPage(id = "7") {
  return render(<LockedPlanDetailPage params={Promise.resolve({ id })} />);
}

async function openTopUpConfirmation(amount: string) {
  await waitFor(() => screen.getByLabelText("Amount (XLM)"));
  fireEvent.change(screen.getByLabelText("Amount (XLM)"), {
    target: { value: amount },
  });
  fireEvent.click(screen.getByRole("button", { name: "Top up" }));
  await waitFor(() => screen.getByRole("button", { name: "Confirm top-up" }));
}

describe("LockedPlanDetailPage top-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({
      user: { id: "user-1" },
      address: "GOWNER",
      loading: false,
    });
  });

  it("increases the displayed balance after a successful top-up", async () => {
    mockApiFetch
      .mockResolvedValueOnce(listResponse([lockedPlan]))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...lockedPlan, balance: "150000000" }),
      } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("locked-plan-balance")).toHaveTextContent(
        "10 XLM",
      );
    });

    await openTopUpConfirmation("5");
    expect(screen.getByText(/add 5 xlm to this plan/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm top-up" }));

    await waitFor(() => {
      expect(screen.getByTestId("locked-plan-balance")).toHaveTextContent(
        "15 XLM",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Added 5 XLM to this plan.",
    );

    const [url, init] = mockApiFetch.mock.calls[1];
    expect(url).toBe("/api/savings/locked/7/top-up");
    expect(JSON.parse(init.body)).toEqual({
      owner: "GOWNER",
      amount: "50000000",
    });
  });

  it("keeps the unlock time unchanged after a top-up", async () => {
    mockApiFetch
      .mockResolvedValueOnce(listResponse([lockedPlan]))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        // Even if a response carried a different unlock_at, the page must
        // keep the plan's original one.
        json: async () => ({
          ...lockedPlan,
          balance: "150000000",
          unlock_at: "2100-06-01T00:00:00.000Z",
        }),
      } as Response);

    const { container } = renderPage();

    await openTopUpConfirmation("5");
    fireEvent.click(screen.getByRole("button", { name: "Confirm top-up" }));

    await waitFor(() => {
      expect(screen.getByTestId("locked-plan-balance")).toHaveTextContent(
        "15 XLM",
      );
    });
    const times = container.querySelectorAll("time");
    expect(times.length).toBeGreaterThan(0);
    times.forEach((t) => expect(t.getAttribute("dateTime")).toBe(UNLOCK_AT));
    expect(screen.getByTestId("locked-plan-status")).toHaveTextContent(
      "Locked",
    );
  });

  it("shows a validation message and does not submit an invalid amount", async () => {
    mockApiFetch.mockResolvedValueOnce(listResponse([lockedPlan]));

    renderPage();

    await waitFor(() => screen.getByLabelText("Amount (XLM)"));
    fireEvent.change(screen.getByLabelText("Amount (XLM)"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Top up" }));

    expect(
      screen.getByText("Amount must be greater than zero."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm top-up" }),
    ).not.toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation, and cancelling sends nothing", async () => {
    mockApiFetch.mockResolvedValueOnce(listResponse([lockedPlan]));

    renderPage();

    await openTopUpConfirmation("2.5");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByLabelText("Amount (XLM)")).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("locked-plan-balance")).toHaveTextContent(
      "10 XLM",
    );
  });

  it("shows the error and keeps the balance when the top-up fails", async () => {
    mockApiFetch
      .mockResolvedValueOnce(listResponse([lockedPlan]))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ message: "Insufficient wallet balance" }),
      } as Response);

    renderPage();

    await openTopUpConfirmation("5");
    fireEvent.click(screen.getByRole("button", { name: "Confirm top-up" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Insufficient wallet balance",
      );
    });
    expect(screen.getByTestId("locked-plan-balance")).toHaveTextContent(
      "10 XLM",
    );
  });

  it("hides the top-up action once the plan has unlocked", async () => {
    mockApiFetch.mockResolvedValueOnce(
      listResponse([{ ...lockedPlan, unlock_at: "2000-01-01T00:00:00.000Z" }]),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("locked-plan-status")).toHaveTextContent(
        "Unlocked",
      );
    });
    expect(
      screen.queryByRole("button", { name: "Top up" }),
    ).not.toBeInTheDocument();
  });
});
