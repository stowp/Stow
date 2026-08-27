import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import GoalDetailPage from "./page";
import { apiFetch } from "@/lib/api";

// See useGoalClaim.test.ts: jest.mock("@/lib/api") auto-mocks ApiError as a
// bare mock function, not a real Error subclass, which breaks
// `err instanceof Error` inside useGoalClaim and masks real error messages.
jest.mock("@/lib/api", () => ({
  __esModule: true,
  apiFetch: jest.fn(),
  ApiError: jest.requireActual("@/lib/api").ApiError,
}));

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function renderPage(id = "goal-1") {
  return render(<GoalDetailPage params={Promise.resolve({ id })} />);
}

const activeGoal = {
  on_chain_id: "goal-1",
  name: "Vacation Fund",
  target_amount: "100000000",
  current_amount: "25000000",
  status: "active",
};

describe("GoalDetailPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the goal name, status, and progress", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => activeGoal,
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Vacation Fund")).toBeInTheDocument();
    });
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("2.5 / 10 XLM")).toBeInTheDocument();
  });

  it("disables the claim action until the goal is reached", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => activeGoal,
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /claim \(available once target is reached\)/i }),
      ).toBeDisabled();
    });
  });

  it("enables the claim action once the goal is reached", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...activeGoal, status: "reached", current_amount: "100000000" }),
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Claim goal" })).toBeEnabled();
    });
  });

  it("requires confirmation before submitting a claim", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...activeGoal, status: "reached", current_amount: "100000000" }),
    } as Response);

    renderPage();

    await waitFor(() => screen.getByRole("button", { name: "Claim goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Claim goal" }));

    expect(screen.getByText(/claim 10 xlm from this goal/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm claim" })).toBeInTheDocument();
  });

  it("updates state to claimed on a successful claim", async () => {
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...activeGoal, status: "reached", current_amount: "100000000" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ on_chain_id: "goal-1", status: "claimed" }),
      } as Response);

    renderPage();

    await waitFor(() => screen.getByRole("button", { name: "Claim goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Claim goal" }));
    await waitFor(() => screen.getByRole("button", { name: "Confirm claim" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm claim" }));

    await waitFor(() => {
      expect(screen.getByText("This goal has already been claimed.")).toBeInTheDocument();
    });
    expect(screen.getByText("Claimed")).toBeInTheDocument();
  });

  it("shows an error message when the claim request fails", async () => {
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...activeGoal, status: "reached", current_amount: "100000000" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ message: "Goal has already been claimed" }),
      } as Response);

    renderPage();

    await waitFor(() => screen.getByRole("button", { name: "Claim goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Claim goal" }));
    await waitFor(() => screen.getByRole("button", { name: "Confirm claim" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm claim" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Goal has already been claimed");
    });
  });

  it("handles not-found gracefully", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);

    renderPage("missing-goal");

    await waitFor(() => {
      expect(screen.getByText("Goal not found")).toBeInTheDocument();
    });
  });

  it("shows an error state with retry on failure", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });
});
