import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WaitlistForm from "./WaitlistForm";
import * as api from "@/lib/api";

describe("WaitlistForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "apiFetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
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
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "invalid-email");
      await user.click(button);

      expect(
        screen.getByText(/please enter a valid email address/i),
      ).toBeInTheDocument();
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(api.apiFetch).not.toHaveBeenCalled();
    });

    it("shows error for empty email", async () => {
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const button = screen.getByRole("button", { name: /join waitlist/i });
      await user.click(button);

      expect(
        screen.getByText(/please enter a valid email address/i),
      ).toBeInTheDocument();
    });

    it("accepts valid email format", async () => {
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      expect(
        screen.queryByText(/please enter a valid email address/i),
      ).not.toBeInTheDocument();

      await waitFor(() => {
        expect(
          screen.getByText(/you're on the list — we'll be in touch/i),
        ).toBeInTheDocument();
      });
    });

    it("clears error state when user types after validation error", async () => {
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "invalid");
      await user.click(button);
      expect(
        screen.getByText(/please enter a valid email address/i),
      ).toBeInTheDocument();

      await user.type(input, "@");
      expect(
        screen.queryByText(/please enter a valid email address/i),
      ).not.toBeInTheDocument();
    });
  });

  describe("Backend submission", () => {
    it("POSTs the email to the waitlist endpoint", async () => {
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
        "/api/waitlist",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: "test@example.com" }),
          skipAuth: true,
        }),
      ));
    });

    it("transitions to success state after a successful submission", async () => {
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      await waitFor(() => {
        expect(
          screen.getByText(/you're on the list — we'll be in touch/i),
        ).toBeInTheDocument();
      });

      expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    });

    it("treats a duplicate signup (409) as success", async () => {
      vi.spyOn(api, "apiFetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Already on the waitlist" }), {
          status: 409,
        }),
      );
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      await waitFor(() => {
        expect(
          screen.getByText(/you're on the list — we'll be in touch/i),
        ).toBeInTheDocument();
      });
    });

    it("shows a server error message when the request fails", async () => {
      vi.spyOn(api, "apiFetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Server unavailable" }), {
          status: 500,
        }),
      );
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      await waitFor(() => {
        expect(screen.getByText(/server unavailable/i)).toBeInTheDocument();
      });
    });

    it("shows a generic error message when the network request throws", async () => {
      vi.spyOn(api, "apiFetch").mockRejectedValue(new Error("Failed to fetch"));
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "test@example.com");
      await user.click(button);

      await waitFor(() => {
        expect(
          screen.getByText(/something went wrong\. please try again\./i),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Accessibility", () => {
    it("associates error message with input via aria-describedby", async () => {
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.type(input, "invalid");
      await user.click(button);

      const errorMessage = screen.getByRole("alert");
      expect(input).toHaveAttribute("aria-describedby", errorMessage.id);
    });

    it("marks input as invalid when there's an error", async () => {
      const user = userEvent.setup();
      render(<WaitlistForm />);

      const input = screen.getByLabelText(/email address/i);
      const button = screen.getByRole("button", { name: /join waitlist/i });

      await user.click(button);
      expect(input).toHaveAttribute("aria-invalid", "true");
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
        const user = userEvent.setup();
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
