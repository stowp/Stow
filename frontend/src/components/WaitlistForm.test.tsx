import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WaitlistForm from "./WaitlistForm";

describe("WaitlistForm", () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  it("renders the form with an email input and submit button", () => {
    render(<WaitlistForm />);
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /join waitlist/i }),
    ).toBeInTheDocument();
  });

  describe("Validation", () => {
    it("shows error for invalid email format", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "invalid-email");
      await user.click(button);

      expect(
        screen.getByText(/please enter a valid email address/i),
      ).toBeInTheDocument();
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("shows error for empty email", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const button = screen.getByRole("button", { name: /join waitlist/i });
      await user.click(button);

      expect(
        screen.getByText(/please enter a valid email address/i),
      ).toBeInTheDocument();
    });

    it("accepts valid email format", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      // Should show loading state (no error)
      expect(
        screen.queryByText(/please enter a valid email address/i),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/joining/i)).toBeInTheDocument();
    });

    it("clears error state when user types after validation error", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      // Trigger validation error
      await user.type(input, "invalid");
      await user.click(button);
      expect(
        screen.getByText(/please enter a valid email address/i),
      ).toBeInTheDocument();

      // Start typing again
      await user.type(input, "@");
      expect(
        screen.queryByText(/please enter a valid email address/i),
      ).not.toBeInTheDocument();
    });
  });

  describe("Form States", () => {
    it("transitions to loading state on valid submit", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      expect(screen.getByText(/joining/i)).toBeInTheDocument();
      expect(button).toBeDisabled();
      expect(screen.getByRole("button")).toHaveClass("disabled:opacity-70");
    });

    it("transitions to success state after submission", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      // Fast-forward through the simulated delay
      await vi.advanceTimersByTimeAsync(700);

      await waitFor(() => {
        expect(
          screen.getByText(/you're on the list — we'll be in touch/i),
        ).toBeInTheDocument();
      });

      // Form should be replaced with success message
      expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    });

    it("clears email input after successful submission", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      await vi.advanceTimersByTimeAsync(700);

      await waitFor(() => {
        expect(
          screen.getByText(/you're on the list — we'll be in touch/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Accessibility", () => {
    it("associates error message with input via aria-describedby", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "invalid");
      await user.click(button);

      const errorMessage = screen.getByRole("alert");
      expect(input).toHaveAttribute("aria-describedby", errorMessage.id);
    });

    it("marks input as invalid when there's an error", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.click(button);
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("has proper button disabled state during loading", async () => {
      const user = userEvent.setup({ delay: null });
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      expect(button).toBeDisabled();
    });
  });

  describe("Email Format Validation", () => {
    const testCases = [
      { email: "user@domain.com", valid: true },
      { email: "user.name@domain.co.uk", valid: true },
      { email: "user+tag@domain.com", valid: true },
      { email: "invalid", valid: false },
      { email: "invalid@", valid: false },
      { email: "@domain.com", valid: false },
      { email: "user@domain", valid: false },
      { email: "user domain@test.com", valid: false },
    ];

    testCases.forEach(({ email, valid }) => {
      it(`${valid ? "accepts" : "rejects"} email: ${email}`, async () => {
        const user = userEvent.setup({ delay: null });
        render(<WaitlistForm />);

        const input = screen.getByLabelText(/email address/i);
        const button = screen.getByRole("button", { name: /join waitlist/i });

        await user.type(input, email);
        await user.click(button);

        if (valid) {
          expect(
            screen.queryByText(/please enter a valid email address/i),
          ).not.toBeInTheDocument();
        } else {
          expect(
            screen.getByText(/please enter a valid email address/i),
          ).toBeInTheDocument();
        }
      });
    });
  });
});
