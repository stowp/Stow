import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import NewGoalPage from "./page";
import { apiFetch } from "@/lib/api";

jest.mock("next/navigation", () => ({
  useRouter: jest.fn(),
}));

jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return { ...actual, apiFetch: jest.fn() };
});

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function fillAndSubmit(name: string, targetAmount: string) {
  fireEvent.change(screen.getByLabelText(/goal name/i), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText(/target amount/i), {
    target: { value: targetAmount },
  });
  fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
}

describe("NewGoalPage", () => {
  const mockPush = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ push: mockPush });
  });

  it("renders a form to create a goal", () => {
    render(<NewGoalPage />);

    expect(screen.getByLabelText(/goal name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/target amount/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create goal/i }),
    ).toBeInTheDocument();
  });

  it("does not advance past validation for an invalid (non-positive) target amount", () => {
    render(<NewGoalPage />);

    fillAndSubmit("New laptop", "0");

    expect(
      screen.queryByRole("heading", { name: /confirm new goal/i }),
    ).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("routes to the goal detail page on a successful submit", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        on_chain_id: "goal-123",
        name: "New laptop",
        target_amount: "5000000000",
      }),
    } as Response);

    render(<NewGoalPage />);

    fillAndSubmit("New laptop", "500");
    fireEvent.click(
      screen.getByRole("button", { name: /confirm and create goal/i }),
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/savings/goals/goal-123");
    });
  });

  it("shows an error and does not navigate when creation fails", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "Invalid target amount" }),
    } as Response);

    render(<NewGoalPage />);

    fillAndSubmit("New laptop", "500");
    fireEvent.click(
      screen.getByRole("button", { name: /confirm and create goal/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Invalid target amount",
      );
    });
    expect(mockPush).not.toHaveBeenCalled();
  });
});
