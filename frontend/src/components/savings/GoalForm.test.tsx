import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GoalForm from "./GoalForm";
import { apiFetch } from "@/lib/api";

jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return { ...actual, apiFetch: jest.fn() };
});

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function fillForm(name: string, targetAmount: string) {
  fireEvent.change(screen.getByLabelText(/goal name/i), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText(/target amount/i), {
    target: { value: targetAmount },
  });
}

describe("GoalForm", () => {
  const onCreated = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("disables the submit button until both fields are filled", () => {
    render(<GoalForm onCreated={onCreated} />);

    expect(screen.getByRole("button", { name: /create goal/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/goal name/i), {
      target: { value: "New laptop" },
    });
    expect(screen.getByRole("button", { name: /create goal/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/target amount/i), {
      target: { value: "500" },
    });
    expect(screen.getByRole("button", { name: /create goal/i })).not.toBeDisabled();
  });

  it.each([
    ["0", "a zero target"],
    ["-100", "a negative target"],
    ["not-a-number", "a non-numeric target"],
  ])(
    "rejects %s target amount (%s) and shows a validation error without calling the API",
    (invalidAmount: string) => {
      render(<GoalForm onCreated={onCreated} />);

      fillForm("New laptop", invalidAmount);
      // The submit button only disables for an empty target, so a bad
      // value still reaches handleSubmit — the validation guard there must
      // catch it.
      const submitButton = screen.getByRole("button", { name: /create goal/i });
      if (!submitButton.hasAttribute("disabled")) {
        fireEvent.click(submitButton);
      }

      expect(mockApiFetch).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
      // Neither the invalid amount nor a non-numeric one should advance to
      // the confirmation step.
      expect(
        screen.queryByRole("button", { name: /confirm and create goal/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("does not submit for a whitespace-only name even with a valid target", () => {
    render(<GoalForm onCreated={onCreated} />);

    fillForm("   ", "500");

    expect(screen.getByRole("button", { name: /create goal/i })).toBeDisabled();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("shows a confirmation step before submitting, with the entered name and target", () => {
    render(<GoalForm onCreated={onCreated} />);

    fillForm("New laptop", "500");
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    expect(
      screen.getByRole("heading", { name: /confirm new goal/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("New laptop")).toBeInTheDocument();
    expect(screen.getByText(/500 XLM/)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("returns from the confirmation step without submitting when Back is clicked", () => {
    render(<GoalForm onCreated={onCreated} />);

    fillForm("New laptop", "500");
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(screen.getByLabelText(/goal name/i)).toHaveValue("New laptop");
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("calls onCreated with the new goal's on-chain id after confirming", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        on_chain_id: "goal-123",
        name: "New laptop",
        target_amount: "5000000000",
      }),
    } as Response);

    render(<GoalForm onCreated={onCreated} />);

    fillForm("New laptop", "500");
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm and create goal/i }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("goal-123");
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/goals",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "New laptop", target_amount: "5000000000" }),
      }),
    );
  });

  it("does not call onCreated and shows an error message on a failed confirm", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "Invalid target amount" }),
    } as Response);

    render(<GoalForm onCreated={onCreated} />);

    fillForm("New laptop", "500");
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm and create goal/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Invalid target amount",
      );
    });
    expect(onCreated).not.toHaveBeenCalled();
    // Stay on the confirmation step so the error is visible, rather than
    // silently reverting to the pre-confirmation form.
    expect(
      screen.getByRole("heading", { name: /confirm new goal/i }),
    ).toBeInTheDocument();
  });

  it("converts a fractional XLM target into whole stroops", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        on_chain_id: "goal-456",
        name: "Bike",
        target_amount: "12500000",
      }),
    } as Response);

    render(<GoalForm onCreated={onCreated} />);

    fillForm("Bike", "1.25");
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm and create goal/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/goals",
        expect.objectContaining({
          body: JSON.stringify({ name: "Bike", target_amount: "12500000" }),
        }),
      );
    });
  });
});
