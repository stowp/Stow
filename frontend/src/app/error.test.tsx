import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ErrorPage from "./error";

describe("ErrorPage", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("renders a friendly fallback message", () => {
    render(<ErrorPage error={new Error("boom")} retry={vi.fn()} />);

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go home/i })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("calls retry when the try again button is clicked", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorPage error={new Error("boom")} retry={retry} />);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("logs the error for diagnostics", () => {
    const error = new Error("boom");
    render(<ErrorPage error={error} retry={vi.fn()} />);

    expect(consoleErrorSpy).toHaveBeenCalledWith(error);
  });
});
